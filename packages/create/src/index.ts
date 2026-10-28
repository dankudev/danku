import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CliError, runProgram } from "@dankudev/cli-kit";
import { Argument, Command, InvalidArgumentError } from "commander";

import pkg from "../package.json" with { type: "json" };

/** Runs a command in `cwd`; tests replace it so nothing is spawned. */
export type Run = (command: string, args: string[], cwd: string) => Promise<void>;

/** Runs a command attached to the terminal; rejects when it cannot start or exits non-zero. */
export const spawnRun: Run = (command, args, cwd) =>
  new Promise((resolvePromise, reject) => {
    // No shell: arguments are passed as is, and `vp` is an executable (vp.exe on Windows).
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new CliError(`${command} was not found; is it installed and on PATH?`)
          : error,
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new CliError(`${command} ${args.join(" ")} exited with ${signal ?? `code ${code}`}`),
        );
    });
  });

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** `undefined` when the file does not exist. */
async function readOptionalJson<T>(file: string): Promise<T | undefined> {
  try {
    return await readJson<T>(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Writes 2-space JSON with a trailing newline, as the templates do. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Replaces the first `from` in `file`; fails loudly when a newer sv or vp no longer generates it. */
async function replaceOnce(file: string, from: string, to: string): Promise<void> {
  const text = await readFile(file, "utf8");
  if (!text.includes(from)) throw new CliError(`${file}: expected '${from}'`);
  await writeFile(
    file,
    text.replace(from, () => to),
  );
}

/** Appends `lines` to a text file, keeping a single trailing newline. */
async function appendLines(file: string, lines: string[]): Promise<void> {
  const text = await readFile(file, "utf8");
  await writeFile(file, `${text.trimEnd()}\n${lines.join("\n")}\n`);
}

/** Replaces a package.json script; fails loudly when sv generated a different one. */
async function replaceScript(
  file: string,
  name: string,
  expected: string,
  replacement: string,
): Promise<void> {
  const pkg = await readJson<{ scripts?: Record<string, string> }>(file);
  const scripts = pkg.scripts ?? {};
  if (scripts[name] !== expected) {
    throw new CliError(`${file}: expected the ${name} script '${expected}'`);
  }
  scripts[name] = replacement;
  await writeJson(file, pkg);
}

/** The SvelteKit app; inside a monorepo `vp create` places it under `apps/`. */
const APP_NAME = "web";

/** The `check` script sv generates. */
const SV_CHECK =
  "wrangler types --check && svelte-kit sync && svelte-check --tsconfig ./tsconfig.json";

/**
 * Entry point of `create-danku`: the only place the program is built and parsed. Returns the
 * exit code; expected failures are printed without a stack trace.
 */
export async function main(argv: string[], run: Run = spawnRun): Promise<number> {
  // A fresh program per run: Commander stores parsed option values on the command object.
  const program = new Command("create-danku")
    .description(
      "Create a danku project: a Vite+ monorepo with a SvelteKit app on Cloudflare Workers",
    )
    .version(pkg.version)
    .addArgument(
      new Argument(
        "<name>",
        "Project name and directory: lowercase letters, digits and dashes",
      ).argParser((name) => {
        // Commander reports this message as an invalid argument.
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          throw new InvalidArgumentError("Use lowercase letters, digits and dashes.");
        }
        return name;
      }),
    )
    .addArgument(
      new Argument("<preset>", "What the project is for").choices(["local-business", "saas"]),
    )
    .action(async (name: string, preset: string) => {
      const cwd = process.cwd();
      const directory = resolve(cwd, name);
      const app = join(directory, "apps", APP_NAME);

      // The target directory may be missing or empty, nothing else.
      const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        if (error.code === "ENOTDIR") {
          throw new CliError(`${directory} already exists and is not a directory`);
        }
        throw error;
      });
      if (entries.length > 0) {
        throw new CliError(`Directory ${directory} already exists and is not empty`);
      }

      await run(
        "vp",
        [
          "create",
          "vite:monorepo",
          "--no-interactive",
          "--directory",
          name,
          "--git",
          "--editor",
          "vscode",
          "--hooks",
          "--package-manager",
          "pnpm",
        ],
        cwd,
      );

      // Remove the sample packages; danku adds its own apps instead.
      for (const path of ["apps/website", "packages/utils"]) {
        await rm(join(directory, path), { recursive: true, force: true });
      }
      const rootPackageFile = join(directory, "package.json");
      const rootPackage = await readJson<{
        scripts?: Record<string, string>;
        engines?: Record<string, string>;
      }>(rootPackageFile);
      // The only root script: `vp config` installs the commit hooks after `vp install`.
      rootPackage.scripts = { prepare: "vp config" };
      // Node 24 LTS from the first release Vitest 5 runs on.
      rootPackage.engines = { ...rootPackage.engines, node: ">=24.11.0" };
      await writeJson(rootPackageFile, rootPackage);

      // vp passes --no-install to sv, converts the app to Vite+, then installs and formats the workspace.
      await run(
        "vp",
        [
          "create",
          // Bump sv deliberately: the edits below depend on its output.
          "svelte@1.1.1",
          "--no-interactive",
          "--",
          APP_NAME,
          "--template",
          "minimal",
          "--types",
          "ts",
          // Official `sv add` add-ons with their options, one argument each (no shell, so no quotes).
          "--add",
          "enhanced-img",
          "experimental=features:async,remoteFunctions",
          "mdsvex",
          "sveltekit-adapter=adapter:cloudflare+cfTarget:workers",
          "tailwindcss=plugins:typography,forms",
        ],
        directory,
      );

      // Workaround: `vp create` converts third-party templates only partly and leaves `defineConfig`
      // imported from "vite", which the `vite-plus/prefer-vite-plus-imports` lint rule rejects. It is
      // the only change `vp migrate` would make here. Remove once `vp create` does this itself.
      await replaceOnce(
        join(app, "vite.config.ts"),
        'import { defineConfig } from "vite";',
        'import { defineConfig } from "vite-plus";',
      );

      // `check` also formats and lints the app; warnings fail it, as in CI.
      const appPackageFile = join(app, "package.json");
      await replaceScript(
        appPackageFile,
        "check",
        SV_CHECK,
        `vp check --deny-warnings && ${SV_CHECK}`,
      );
      // The workspace catalog pins `@types/node` for every package; it comes with some add-ons only.
      // `typescript` stays on sv's 6.x: `svelte-kit sync` reads tsconfig through the TypeScript JS
      // API, which the catalog's TypeScript 7 does not provide yet.
      const appPackage = await readJson<{ devDependencies?: Record<string, string> }>(
        appPackageFile,
      );
      if (appPackage.devDependencies?.["@types/node"]) {
        appPackage.devDependencies["@types/node"] = "catalog:";
      }
      await writeJson(appPackageFile, appPackage);

      // Cloudflare: app-level Worker setup, candidates for a @dankudev/iac sv add-on.
      // Generate the Worker types in `prepare`, so every install that changes dependencies refreshes them.
      await replaceScript(
        appPackageFile,
        "prepare",
        "svelte-kit sync || echo ''",
        "svelte-kit sync && wrangler types || echo ''",
      );
      // `wrangler types` output: regenerated by `prepare`, so it is not committed.
      await appendLines(join(app, ".gitignore"), [
        "",
        "# Worker types, generated by the prepare script",
        "worker-configuration.d.ts",
      ]);
      // sv names the Worker after the app folder, so every project would deploy over the same Worker.
      const wranglerFile = join(app, "wrangler.jsonc");
      await replaceOnce(
        wranglerFile,
        `"name": ${JSON.stringify(APP_NAME)}`,
        `"name": ${JSON.stringify(`${name}-${APP_NAME}`)}`,
      );
      // sv enables only AsyncLocalStorage, which SvelteKit itself needs; full Node.js compatibility
      // also covers npm packages that use Node APIs (payment SDKs, auth libraries, API clients).
      await replaceOnce(wranglerFile, '"nodejs_als"', '"nodejs_compat"');

      // VS Code only reads .vscode in the opened folder, so the app's extension recommendations and
      // settings move to the monorepo root (root settings win) and the app's .vscode is removed.
      const rootVscode = join(directory, ".vscode");
      const appVscode = join(app, ".vscode");
      const appExtensions = await readOptionalJson<{ recommendations?: string[] }>(
        join(appVscode, "extensions.json"),
      );
      if (appExtensions?.recommendations) {
        const file = join(rootVscode, "extensions.json");
        const extensions = await readJson<{ recommendations?: string[] }>(file);
        extensions.recommendations = [
          ...new Set([...(extensions.recommendations ?? []), ...appExtensions.recommendations]),
        ];
        await writeJson(file, extensions);
      }
      const appSettings = await readOptionalJson<Record<string, unknown>>(
        join(appVscode, "settings.json"),
      );
      if (appSettings) {
        const file = join(rootVscode, "settings.json");
        const settings = await readJson<Record<string, unknown>>(file);
        for (const [key, value] of Object.entries(appSettings)) settings[key] ??= value;
        await writeJson(file, settings);
      }
      await rm(appVscode, { recursive: true, force: true });

      // sv files the monorepo replaces: an .npmrc pnpm ignores in workspace packages, an empty `$lib` index.
      for (const path of [".npmrc", "src/lib/index.ts"]) await rm(join(app, path), { force: true });

      // Approve wrangler's esbuild install script (pnpm fails installs with unapproved build scripts,
      // and `vp create` approves only sharp and workerd), and make `pnpm install` fail on a Node
      // version outside `engines` (pnpm ignores the app's .npmrc).
      const workspaceFile = join(directory, "pnpm-workspace.yaml");
      await replaceOnce(workspaceFile, "allowBuilds:", "allowBuilds:\n  esbuild: true");
      await appendLines(workspaceFile, ["engineStrict: true"]);

      // `vp fmt` skips .svelte files unless `fmt.svelte` is set, and sorts imports only with
      // `sortImports` (groups, then alphabetical) in the root config.
      await replaceOnce(
        join(directory, "vite.config.ts"),
        "fmt: {}",
        "fmt: { svelte: {}, sortImports: true }",
      );

      await run("vp", ["install"], directory);
      await run("vp", ["fmt"], directory);

      // Both presets create the same base project for now; their add-ons come in later steps.
      console.log(`Created ${name} with the ${preset} preset`);
    });

  return runProgram(program, argv);
}
