import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { CliError } from "../src/error.ts";
import { main } from "../src/index.ts";
import type { Run } from "../src/run.ts";

/** The `check` script sv generates. */
const SV_CHECK =
  "wrangler types --check && svelte-kit sync && svelte-check --tsconfig ./tsconfig.json";

/** The `build` script sv generates, after `vp create` converts it to Vite+. */
const SV_BUILD = "wrangler types --check && vp build";

/** The imports `vp create svelte` leaves in apps/web/vite.config.ts. */
const VITE_CONFIG = `import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { lazyPlugins } from "vite-plus";

export default defineConfig({ plugins: lazyPlugins(() => [sveltekit()]) });
`;

let dir: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "create-danku-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  // Silences and records console output; `restoreMocks` in vite.config.ts undoes it after each test.
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs `danku create` with `run` standing in for vp; returns the exit code and stderr. */
async function create(argv: string[], run: Run) {
  error.mockClear();
  const exitCode = await main(["create", ...argv], run);
  return { exitCode, stderr: error.mock.calls.flat().join("\n") };
}

async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Writes the parts of a `vp create vite:monorepo` result that `main` adapts. */
async function writeTemplate(directory: string) {
  for (const path of ["apps/website", "packages/utils"]) {
    await mkdir(join(directory, path, "src"), { recursive: true });
    await writeFile(join(directory, path, "package.json"), "{}");
  }
  await writeJson(join(directory, "package.json"), {
    name: "my-app",
    scripts: {
      ready: "vp check && vp run -r test && vp run -r build",
      dev: "vp run website#dev",
    },
    engines: { node: ">=22.18.0", pnpm: ">=12" },
  });
  await mkdir(join(directory, ".vscode"));
  await writeJson(join(directory, ".vscode", "extensions.json"), {
    recommendations: ["VoidZero.vite-plus-extension-pack"],
  });
  await writeJson(join(directory, ".vscode", "settings.json"), {
    "npm.scriptRunner": "vp",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": { "source.fixAll.oxc": "explicit" },
  });
  await writeFile(
    join(directory, "vite.config.ts"),
    'import { defineConfig } from "vite-plus";\n\nexport default defineConfig({\n  fmt: {},\n});\n',
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\nallowBuilds:\n  sharp: true\n  workerd: true\n",
  );
}

/** Writes the parts of a `vp create svelte` app that `main` adapts. */
async function writeApp(app: string) {
  await mkdir(join(app, "src", "lib"), { recursive: true });
  await mkdir(join(app, ".vscode"));
  await writeFile(join(app, "vite.config.ts"), VITE_CONFIG);
  await writeJson(join(app, "package.json"), {
    name: "web",
    scripts: {
      dev: "vp dev",
      build: SV_BUILD,
      prepare: "svelte-kit sync || echo ''",
      check: SV_CHECK,
      gen: "wrangler types",
    },
    imports: { "#lib": "./src/lib/index.js", "#lib/*": "./src/lib/*" },
    devDependencies: { "@types/node": "^24", typescript: "^6.0.3", wrangler: "^4.97.0" },
  });
  await writeFile(join(app, ".gitignore"), "node_modules\n.wrangler\n");
  await writeFile(
    join(app, "wrangler.jsonc"),
    '{\n  "name": "web",\n  "compatibility_flags": ["nodejs_als"],\n}\n',
  );
  await writeJson(join(app, ".vscode", "extensions.json"), {
    recommendations: ["svelte.svelte-vscode", "bradlc.vscode-tailwindcss"],
  });
  await writeJson(join(app, ".vscode", "settings.json"), {
    "files.associations": { "*.css": "tailwindcss" },
    "editor.formatOnSave": false,
  });
  await writeFile(join(app, ".npmrc"), "engine-strict=true\n");
  await writeFile(join(app, "src", "lib", "index.ts"), "// place files you want to import\n");
}

const project = () => join(dir, "my-app");
const app = () => join(project(), "apps", "web");

/**
 * Stands in for vp: `vite:monorepo` writes the template, `svelte` writes the app. The hooks
 * change a fixture afterwards, to imitate a newer vp or sv that generates something else.
 */
function fakeVp(hooks: { template?: () => Promise<void>; app?: () => Promise<void> } = {}) {
  const appsBeforeSvelte: string[][] = [];
  const run = vi.fn<Run>(async (_command, args) => {
    if (args[1] === "vite:monorepo") {
      await writeTemplate(project());
      await hooks.template?.();
    } else if (args[1]?.startsWith("svelte@")) {
      appsBeforeSvelte.push(await readdir(join(project(), "apps")));
      await writeApp(app());
      await hooks.app?.();
    }
  });
  return { run, appsBeforeSvelte };
}

const MONOREPO = [
  "create",
  "vite:monorepo",
  "--no-interactive",
  "--directory",
  "my-app",
  "--git",
  "--editor",
  "vscode",
  "--no-hooks",
  "--package-manager",
  "pnpm",
];

const SVELTE = [
  "create",
  "svelte@1.1.1",
  "--no-interactive",
  "--",
  "web",
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
];

test("creates the monorepo, adds and adapts the SvelteKit app, and installs", async () => {
  // An existing empty folder is fine.
  await mkdir(project());
  const { run, appsBeforeSvelte } = fakeVp();

  expect(await create(["my-app", "saas"], run)).toEqual({ exitCode: 0, stderr: "" });

  expect(run.mock.calls).toEqual([
    ["vp", MONOREPO, dir],
    ["vp", SVELTE, project()],
    ["vp", ["install"], project()],
    ["vp", ["fmt"], project()],
  ]);
  // The sample packages are gone before the app is added.
  expect(appsBeforeSvelte).toEqual([[]]);
  expect(log).toHaveBeenLastCalledWith("Created my-app with the saas preset");

  // Root: no scripts, the Node engine set, other engines kept, no sample packages.
  expect(await readJson(join(project(), "package.json"))).toEqual({
    name: "my-app",
    engines: { node: ">=24.11.0", pnpm: ">=12" },
  });
  expect(await readdir(join(project(), "apps"))).toEqual(["web"]);
  expect(await readdir(project())).not.toContain("packages");
  expect(await readFile(join(project(), "vite.config.ts"), "utf8")).toContain(
    "fmt: { svelte: {}, sortImports: true }",
  );
  expect(await readFile(join(project(), "pnpm-workspace.yaml"), "utf8")).toBe(
    "packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n  sharp: true\n  workerd: true\nengineStrict: true\n",
  );

  // App: Vite+ config, scripts, catalog, Worker setup.
  expect(await readFile(join(app(), "vite.config.ts"), "utf8")).toBe(
    VITE_CONFIG.replace('from "vite";', 'from "vite-plus";'),
  );
  expect(await readJson(join(app(), "package.json"))).toEqual({
    name: "web",
    scripts: {
      dev: "vp dev",
      build: "vp build",
      prepare: "svelte-kit sync && wrangler types || echo ''",
      check:
        "wrangler types && svelte-kit sync && vp check --deny-warnings && svelte-check --tsconfig ./tsconfig.json",
    },
    // No barrel file, so only the `#lib/*` entry stays.
    imports: { "#lib/*": "./src/lib/*" },
    // typescript stays on sv's 6.x: svelte-kit sync needs its JS API.
    devDependencies: { "@types/node": "catalog:", typescript: "^6.0.3", wrangler: "^4.97.0" },
  });
  expect(await readFile(join(app(), ".gitignore"), "utf8")).toBe(
    "node_modules\n.wrangler\n\n# Worker types, generated by the prepare and check scripts\nworker-configuration.d.ts\n",
  );
  expect(await readFile(join(app(), "wrangler.jsonc"), "utf8")).toBe(
    '{\n  "name": "my-app-web",\n  "compatibility_flags": ["nodejs_compat"],\n}\n',
  );

  // Editor settings: merged into the root (the root setting wins), lint fixes on every save, the
  // app's .vscode removed.
  expect(await readJson(join(project(), ".vscode", "extensions.json"))).toEqual({
    recommendations: [
      "VoidZero.vite-plus-extension-pack",
      "svelte.svelte-vscode",
      "bradlc.vscode-tailwindcss",
    ],
  });
  expect(await readJson(join(project(), ".vscode", "settings.json"))).toEqual({
    "npm.scriptRunner": "vp",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": { "source.fixAll.oxc": "always" },
    "files.associations": { "*.css": "tailwindcss" },
  });

  // Leftovers removed.
  expect((await readdir(app())).sort()).toEqual([
    ".gitignore",
    "package.json",
    "src",
    "vite.config.ts",
    "wrangler.jsonc",
  ]);
  expect(await readdir(join(app(), "src", "lib"))).toEqual([]);
});

test("accepts an app without .vscode or catalog dependencies", async () => {
  const { run } = fakeVp({
    app: async () => {
      await rm(join(app(), ".vscode"), { recursive: true });
      const pkg = await readJson(join(app(), "package.json"));
      delete pkg.devDependencies["@types/node"];
      await writeJson(join(app(), "package.json"), pkg);
    },
  });

  expect(await create(["my-app", "saas"], run)).toEqual({ exitCode: 0, stderr: "" });

  expect(await readJson(join(project(), ".vscode", "extensions.json"))).toEqual({
    recommendations: ["VoidZero.vite-plus-extension-pack"],
  });
  expect((await readJson(join(app(), "package.json"))).devDependencies).toEqual({
    typescript: "^6.0.3",
    wrangler: "^4.97.0",
  });
});

test("bad arguments fail without running vp", async () => {
  const cases: [string[], string][] = [
    [[], "error: missing required argument 'project'"],
    [["my-app"], "error: missing required argument 'preset'"],
    [["my-app", "saas", "extra"], "too many arguments"],
    ...["My-App", "my_app", "my app", "../app"].map((name): [string[], string] => [
      [name, "saas"],
      `'${name}' is invalid for argument 'project'. Use lowercase letters, digits and dashes.`,
    ]),
    [["my-app", "blog"], "Allowed choices are localbusiness, saas."],
    [["my-app", "saas", "--force"], "unknown option '--force'"],
  ];
  const run = vi.fn<Run>();

  for (const [argv, message] of cases) {
    const { exitCode, stderr } = await create(argv, run);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(message);
  }
  expect(run).not.toHaveBeenCalled();
});

test("a taken target fails without running vp", async () => {
  const cases: [() => Promise<void>, () => string][] = [
    [
      async () => {
        await mkdir(project());
        await writeFile(join(project(), "file.txt"), "");
      },
      () => `Directory ${project()} already exists and is not empty`,
    ],
    [
      () => rm(project(), { recursive: true }).then(() => writeFile(project(), "")),
      () => `${project()} already exists and is not a directory`,
    ],
    // Last, since it applies to everything below this folder: inside a repository, never nest one.
    [
      () => writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n"),
      () => `danku create makes a new repository; run it outside ${dir}`,
    ],
  ];
  const run = vi.fn<Run>();

  for (const [take, message] of cases) {
    await take();
    expect(await create(["my-app", "saas"], run)).toEqual({ exitCode: 1, stderr: message() });
  }
  expect(run).not.toHaveBeenCalled();
});

test("a failing vp step stops the run before installing", async () => {
  // The monorepo step fails, then (in a fresh folder) the SvelteKit step.
  for (const failing of ["vite:monorepo", "svelte@1.1.1"]) {
    await rm(project(), { recursive: true, force: true });
    const { run } = fakeVp();
    const fake = run.getMockImplementation()!;
    run.mockImplementation(async (command, args, cwd) => {
      if (args[1] === failing) throw new CliError(`vp create ${failing} exited with code 1`);
      await fake(command, args, cwd);
    });

    expect(await create(["my-app", "saas"], run)).toEqual({
      exitCode: 1,
      stderr: `vp create ${failing} exited with code 1`,
    });
    expect(run.mock.calls.map(([, args]) => args[0])).not.toContain("install");
  }
});

test("output a newer vp or sv changed fails with the file and the text it expected", async () => {
  // One app file and one template file; every other edit is checked the same way.
  const cases: [Parameters<typeof fakeVp>[0], () => string][] = [
    [
      { app: () => writeFile(join(app(), "vite.config.ts"), "export default {};\n") },
      () => `${join(app(), "vite.config.ts")}: expected 'import { defineConfig } from "vite";'`,
    ],
    [
      { template: () => writeFile(join(project(), "pnpm-workspace.yaml"), "packages: []\n") },
      () => `${join(project(), "pnpm-workspace.yaml")}: expected 'allowBuilds:'`,
    ],
  ];

  for (const [hooks, message] of cases) {
    await rm(project(), { recursive: true, force: true });
    const { run } = fakeVp(hooks);
    expect(await create(["my-app", "saas"], run)).toEqual({ exitCode: 1, stderr: message() });
    expect(run.mock.calls.map(([, args]) => args[0])).not.toContain("install");
  }
});
