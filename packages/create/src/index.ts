import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const PRESETS = ["saas", "saas-split"] as const;
export type Preset = (typeof PRESETS)[number];

export interface Options {
  name: string;
  preset?: Preset;
}

export const USAGE = `Usage: create-danku <name> [--preset ${PRESETS.join("|")}]`;

/** An expected failure: its message is printed without a stack trace. */
export class CliError extends Error {}

/** Thrown for invalid arguments; printed together with the usage. */
export class UsageError extends CliError {}

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

/** Fails when `directory` exists and has entries; a missing or empty directory is fine. */
export async function assertEmptyDirectory(directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") return;
    if (code === "ENOTDIR")
      throw new CliError(`${directory} already exists and is not a directory`);
    throw error;
  }
  if (entries.length > 0) {
    throw new CliError(`Directory ${directory} already exists and is not empty`);
  }
}

/** Parses and validates the command line arguments (without the node and script paths). */
export function parse(argv: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { preset: { type: "string" } },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  const { positionals, values } = parsed;
  if (positionals.length !== 1) throw new UsageError("Expected exactly one project name");
  const [name] = positionals;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new UsageError(
      `Invalid project name "${name}": use lowercase letters, digits and dashes`,
    );
  }

  const { preset } = values;
  if (preset === undefined) return { name };
  if (!(PRESETS as readonly string[]).includes(preset)) {
    throw new UsageError(`Unknown preset "${preset}"`);
  }
  // Presets are recognized now so the flag is stable; they are implemented in later steps.
  throw new UsageError(`Preset "${preset}" is not available yet`);
}

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

/** Sample packages `vp create vite:monorepo` generates; danku adds its own apps instead. */
export const SAMPLE_PACKAGES = ["apps/website", "packages/utils"];

/** Node versions generated projects support: Node 24 LTS from the first release Vitest 5 runs on. */
export const NODE_ENGINE = ">=24.11.0";

/** The only root script: `vp config` installs the commit hooks after `vp install`. */
export const ROOT_SCRIPTS = { prepare: "vp config" };

/**
 * Removes the sample packages, replaces the root scripts with {@link ROOT_SCRIPTS}
 * and sets the root `engines.node` to {@link NODE_ENGINE}.
 */
export async function cleanMonorepo(directory: string): Promise<void> {
  for (const path of SAMPLE_PACKAGES) {
    await rm(join(directory, path), { recursive: true, force: true });
  }

  const file = join(directory, "package.json");
  const pkg = await readJson<{
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  }>(file);
  pkg.scripts = { ...ROOT_SCRIPTS };
  pkg.engines = { ...pkg.engines, node: NODE_ENGINE };
  await writeJson(file, pkg);
}

/** `sv` release that `vp create svelte@…` runs; bump it deliberately, later cleanup depends on its output. */
export const SV_VERSION = "1.1.1";

/** The SvelteKit app; inside a monorepo `vp create` places it under `apps/`. */
export const APP_NAME = "web";

/** Official `sv add` add-ons with their options, one argument each (no shell, so no quotes). */
export const SVELTEKIT_ADD_ONS = [
  "enhanced-img",
  "experimental=features:async,remoteFunctions",
  "mdsvex",
  "sveltekit-adapter=adapter:cloudflare+cfTarget:workers",
  "tailwindcss=plugins:typography,forms",
];

const VITE_DEFINE_CONFIG = 'import { defineConfig } from "vite";';

/**
 * Workaround: `vp create` converts third-party templates only partly and leaves `defineConfig`
 * imported from "vite", which the `vite-plus/prefer-vite-plus-imports` lint rule rejects. It is
 * the only change `vp migrate` would make here. Remove once `vp create` does this itself.
 */
export async function useVitePlusDefineConfig(file: string): Promise<void> {
  await replaceOnce(file, VITE_DEFINE_CONFIG, 'import { defineConfig } from "vite-plus";');
}

/** The `prepare` script sv generates. */
const SV_PREPARE = "svelte-kit sync || echo ''";

/** Also writes the gitignored Worker types; pnpm runs it whenever an install changes dependencies. */
export const APP_PREPARE = "svelte-kit sync && wrangler types || echo ''";

/** The `check` script sv generates. */
const SV_CHECK =
  "wrangler types --check && svelte-kit sync && svelte-check --tsconfig ./tsconfig.json";

/** Also formats and lints the app; warnings fail it, as in CI. */
export const APP_CHECK = `vp check --deny-warnings && ${SV_CHECK}`;

/**
 * Dev dependencies sv pins itself; the workspace catalog pins them for every package instead.
 * Only the ones the app has are moved: `@types/node` comes with some add-ons only. `typescript`
 * stays on sv's 6.x: `svelte-kit sync` reads tsconfig through the TypeScript JS API, which the
 * catalog's TypeScript 7 does not provide yet.
 */
export const CATALOG_DEPENDENCIES = ["@types/node"];

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

/** Runs `vp check` in `check` and moves catalog dependencies to the catalog. */
export async function updateAppPackage(appDirectory: string): Promise<void> {
  const file = join(appDirectory, "package.json");
  await replaceScript(file, "check", SV_CHECK, APP_CHECK);
  const pkg = await readJson<{ devDependencies?: Record<string, string> }>(file);
  const devDependencies = pkg.devDependencies ?? {};
  for (const name of CATALOG_DEPENDENCIES) {
    if (devDependencies[name]) devDependencies[name] = "catalog:";
  }
  await writeJson(file, pkg);
}

/** Generates the Worker types in `prepare`, so every install that changes dependencies refreshes them. */
export async function generateWorkerTypes(appDirectory: string): Promise<void> {
  await replaceScript(join(appDirectory, "package.json"), "prepare", SV_PREPARE, APP_PREPARE);
}

/** `wrangler types` output: regenerated by `prepare`, so it is not committed. */
export async function ignoreWorkerTypes(appDirectory: string): Promise<void> {
  await appendLines(join(appDirectory, ".gitignore"), [
    "",
    "# Worker types, generated by the prepare script",
    "worker-configuration.d.ts",
  ]);
}

/** sv names the Worker after the app folder, so every project would deploy over the same Worker. */
export async function nameWorker(appDirectory: string, workerName: string): Promise<void> {
  await replaceOnce(
    join(appDirectory, "wrangler.jsonc"),
    `"name": ${JSON.stringify(APP_NAME)}`,
    `"name": ${JSON.stringify(workerName)}`,
  );
}

/**
 * Approves wrangler's esbuild install script (pnpm fails installs with unapproved build scripts,
 * and `vp create` approves only sharp and workerd), and makes `pnpm install` fail on a Node version
 * outside `engines` (pnpm ignores the app's .npmrc).
 */
export async function configureWorkspace(directory: string): Promise<void> {
  const file = join(directory, "pnpm-workspace.yaml");
  await replaceOnce(file, "allowBuilds:", "allowBuilds:\n  esbuild: true");
  await appendLines(file, ["engineStrict: true"]);
}

/**
 * VS Code only reads .vscode in the opened folder, so the app's extension recommendations and
 * settings move to the monorepo root (root settings win) and the app's .vscode is removed.
 */
export async function mergeEditorSettings(directory: string, appDirectory: string): Promise<void> {
  const root = join(directory, ".vscode");
  const app = join(appDirectory, ".vscode");

  const appExtensions = await readOptionalJson<{ recommendations?: string[] }>(
    join(app, "extensions.json"),
  );
  if (appExtensions?.recommendations) {
    const file = join(root, "extensions.json");
    const extensions = await readJson<{ recommendations?: string[] }>(file);
    extensions.recommendations = [
      ...new Set([...(extensions.recommendations ?? []), ...appExtensions.recommendations]),
    ];
    await writeJson(file, extensions);
  }

  const appSettings = await readOptionalJson<Record<string, unknown>>(join(app, "settings.json"));
  if (appSettings) {
    const file = join(root, "settings.json");
    const settings = await readJson<Record<string, unknown>>(file);
    for (const [key, value] of Object.entries(appSettings)) settings[key] ??= value;
    await writeJson(file, settings);
  }

  await rm(app, { recursive: true, force: true });
}

/** sv files the monorepo replaces: an .npmrc pnpm ignores in workspace packages, an empty `$lib` index. */
export const APP_LEFTOVERS = [".npmrc", "src/lib/index.ts"];

/**
 * `vp fmt` skips .svelte files unless `fmt.svelte` is set, and sorts imports only with
 * `sortImports` (groups, then alphabetical) in the root config.
 */
export async function configureFormatter(directory: string): Promise<void> {
  await replaceOnce(
    join(directory, "vite.config.ts"),
    "fmt: {}",
    "fmt: { svelte: {}, sortImports: true }",
  );
}

/**
 * sv enables only AsyncLocalStorage, which SvelteKit itself needs; full Node.js compatibility also
 * covers npm packages that use Node APIs (payment SDKs, auth libraries, API clients).
 */
export async function enableNodejsCompat(appDirectory: string): Promise<void> {
  await replaceOnce(join(appDirectory, "wrangler.jsonc"), '"nodejs_als"', '"nodejs_compat"');
}

/** CLI entry: returns the process exit code instead of exiting, so tests can call it. */
export async function main(argv: string[], run: Run = spawnRun): Promise<number> {
  try {
    const { name } = parse(argv);
    const cwd = process.cwd();
    const directory = resolve(cwd, name);
    await assertEmptyDirectory(directory);
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
    await cleanMonorepo(directory);
    // vp passes --no-install to sv, converts the app to Vite+, then installs and formats the workspace.
    await run(
      "vp",
      [
        "create",
        `svelte@${SV_VERSION}`,
        "--no-interactive",
        "--",
        APP_NAME,
        "--template",
        "minimal",
        "--types",
        "ts",
        "--add",
        ...SVELTEKIT_ADD_ONS,
      ],
      directory,
    );
    const app = join(directory, "apps", APP_NAME);
    await useVitePlusDefineConfig(join(app, "vite.config.ts"));
    await updateAppPackage(app);

    // Cloudflare: app-level Worker setup, candidates for a @dankudev/iac sv add-on.
    await generateWorkerTypes(app);
    await ignoreWorkerTypes(app);
    await nameWorker(app, `${name}-${APP_NAME}`);
    await enableNodejsCompat(app);

    await mergeEditorSettings(directory, app);
    for (const path of APP_LEFTOVERS) await rm(join(app, path), { force: true });
    await configureWorkspace(directory);
    await configureFormatter(directory);
    await run("vp", ["install"], directory);
    await run("vp", ["fmt"], directory);
    return 0;
  } catch (error) {
    // Anything else is a bug: rethrow it so the stack trace is printed.
    if (!(error instanceof CliError)) throw error;
    console.error(error.message);
    if (error instanceof UsageError) console.error(USAGE);
    return 1;
  }
}
