import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CliError } from "./error.ts";
import { findRoot } from "./project.ts";
import type { Run } from "./run.ts";

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

/**
 * `danku create`: a new repository with a Vite+ monorepo and a SvelteKit app on Cloudflare Workers.
 * `project` and `preset` are already validated by the command line.
 */
export async function create(project: string, preset: string, run: Run): Promise<void> {
  // Inside an existing repository this would nest a second one, like `ng new` or `rails new`.
  const existing = findRoot();
  if (existing) {
    throw new CliError(`danku create makes a new repository; run it outside ${existing}`);
  }

  const cwd = process.cwd();
  const directory = resolve(cwd, project);
  const app = join(directory, "apps", APP_NAME);

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
      project,
      "--git",
      "--editor",
      "vscode",
      "--no-hooks",
      "--package-manager",
      "pnpm",
    ],
    cwd,
  );

  // Remove the sample packages; danku adds its own apps instead. The whole `packages` folder goes:
  // git doesn't track empty folders, so a clone wouldn't have it anyway, and the workspace glob
  // still picks up packages added later.
  for (const path of ["apps/website", "packages"]) {
    await rm(join(directory, path), { recursive: true, force: true });
  }
  const rootPackageFile = join(directory, "package.json");
  const rootPackage = await readJson<{
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  }>(rootPackageFile);
  delete rootPackage.scripts;
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
  // the only change `vp migrate` would make here. Remove once `vp create` does this itself:
  // https://github.com/voidzero-dev/vite-plus/issues/3281
  await replaceOnce(
    join(app, "vite.config.ts"),
    'import { defineConfig } from "vite";',
    'import { defineConfig } from "vite-plus";',
  );

  // The Worker types are generated, not committed: `check` regenerates them before type checking
  // instead of `--check`ing a committed copy, like `svelte-kit sync` does for the route types.
  // `vp check` runs after both because it type checks too; it also formats and lints the app,
  // and warnings fail it, as in CI.
  const appPackageFile = join(app, "package.json");
  await replaceScript(
    appPackageFile,
    "check",
    "wrangler types --check && svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "wrangler types && svelte-kit sync && vp check --deny-warnings && svelte-check --tsconfig ./tsconfig.json",
  );
  // `vite build` never reads the Worker types, so the build doesn't need them.
  await replaceScript(appPackageFile, "build", "wrangler types --check && vp build", "vp build");
  // The workspace catalog pins `@types/node` for every package; it comes with some add-ons only.
  // `typescript` stays on sv's 6.x: `svelte-kit sync` reads tsconfig through the TypeScript JS
  // API, which the catalog's TypeScript 7 does not provide yet.
  const appPackage = await readJson<{
    scripts?: Record<string, string>;
    imports?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(appPackageFile);
  if (appPackage.devDependencies?.["@types/node"]) {
    appPackage.devDependencies["@types/node"] = "catalog:";
  }
  // `gen` only regenerated the Worker types, which `prepare` and `check` now do themselves.
  if (appPackage.scripts?.gen !== "wrangler types") {
    throw new CliError(`${appPackageFile}: expected the gen script 'wrangler types'`);
  }
  delete appPackage.scripts.gen;
  // No barrel file: its placeholder is removed below, and `#lib/*` still resolves every file in
  // src/lib, so the bare `#lib` entry would point at nothing.
  if (appPackage.imports?.["#lib"] !== "./src/lib/index.js") {
    throw new CliError(`${appPackageFile}: expected the #lib import './src/lib/index.js'`);
  }
  delete appPackage.imports["#lib"];
  await writeJson(appPackageFile, appPackage);

  // Cloudflare: app-level Worker setup, candidates for the danku sv add-on.
  // Also generate the Worker types in `prepare`, so the editor has them right after install.
  await replaceScript(
    appPackageFile,
    "prepare",
    "svelte-kit sync || echo ''",
    "svelte-kit sync && wrangler types || echo ''",
  );
  // `wrangler types` output: regenerated by `prepare` and `check`, so it is not committed.
  await appendLines(join(app, ".gitignore"), [
    "",
    "# Worker types, generated by the prepare and check scripts",
    "worker-configuration.d.ts",
  ]);
  // sv names the Worker after the app folder, so every project would deploy over the same Worker.
  const wranglerFile = join(app, "wrangler.jsonc");
  await replaceOnce(
    wranglerFile,
    `"name": ${JSON.stringify(APP_NAME)}`,
    `"name": ${JSON.stringify(`${project}-${APP_NAME}`)}`,
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
  const settingsFile = join(rootVscode, "settings.json");
  const settings = await readJson<Record<string, unknown>>(settingsFile);
  const appSettings = await readOptionalJson<Record<string, unknown>>(
    join(appVscode, "settings.json"),
  );
  for (const [key, value] of Object.entries(appSettings ?? {})) settings[key] ??= value;
  // Lint fixes on every save, autosave included, not only on Ctrl+S.
  settings["editor.codeActionsOnSave"] = {
    ...(settings["editor.codeActionsOnSave"] as object | undefined),
    "source.fixAll.oxc": "always",
  };
  await writeJson(settingsFile, settings);
  await rm(appVscode, { recursive: true, force: true });

  // sv files the monorepo replaces: an .npmrc pnpm ignores in workspace packages, an empty `#lib` barrel.
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
  console.log(`Created ${project} with the ${preset} preset`);
}
