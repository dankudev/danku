import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "@dankudev/cli-kit";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { main, type Run, spawnRun } from "../src/index.ts";

/** The `check` script sv generates. */
const SV_CHECK =
  "wrangler types --check && svelte-kit sync && svelte-check --tsconfig ./tsconfig.json";

/** The imports `vp create svelte` leaves in apps/web/vite.config.ts. */
const VITE_CONFIG = `import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { lazyPlugins } from "vite-plus";

export default defineConfig({ plugins: lazyPlugins(() => [sveltekit()]) });
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "create-danku-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Silences and records console output; `restoreMocks` in vite.config.ts undoes it after each test. */
function spyConsole() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
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
      prepare: "vp config",
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
      prepare: "svelte-kit sync || echo ''",
      check: SV_CHECK,
      gen: "wrangler types",
    },
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
  "--hooks",
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

describe("arguments", () => {
  /** Runs main() with a `vp` that must never be called; returns the exit code and stderr. */
  async function invalid(argv: string[]) {
    const console = spyConsole();
    // Spying again returns the same spy, so forget the calls of an earlier invalid() in the test.
    console.error.mockClear();
    const run = vi.fn<Run>();
    const exitCode = await main(argv, run);
    expect(run).not.toHaveBeenCalled();
    return { exitCode, stderr: console.error.mock.calls.flat().join("\n") };
  }

  test("requires a name and a preset, nothing more", async () => {
    expect(await invalid([])).toEqual({
      exitCode: 1,
      stderr: "error: missing required argument 'name'",
    });
    expect(await invalid(["my-app"])).toEqual({
      exitCode: 1,
      stderr: "error: missing required argument 'preset'",
    });
    expect((await invalid(["my-app", "saas", "extra"])).stderr).toContain("too many arguments");
  });

  test("rejects invalid names", async () => {
    for (const name of ["My-App", "my_app", "my app", "../app"]) {
      const { exitCode, stderr } = await invalid([name, "saas"]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`'${name}' is invalid for argument 'name'`);
      expect(stderr).toContain("Use lowercase letters, digits and dashes.");
    }
  });

  test("rejects unknown presets, listing the allowed ones", async () => {
    const { exitCode, stderr } = await invalid(["my-app", "blog"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("'blog' is invalid for argument 'preset'");
    expect(stderr).toContain("Allowed choices are local-business, saas.");
  });

  test("rejects unknown options", async () => {
    const { exitCode, stderr } = await invalid(["my-app", "saas", "--force"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown option '--force'");
  });

  test("--help and --version print and succeed", async () => {
    const console = spyConsole();
    const run = vi.fn<Run>();
    expect(await main(["--help"], run)).toBe(0);
    expect(console.log.mock.calls.flat().join("\n")).toContain("Usage: create-danku");
    expect(await main(["--version"], run)).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith("0.0.0");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("creating a project", () => {
  test("creates the monorepo, adds the SvelteKit app, adapts it and installs", async () => {
    const console = spyConsole();
    const { run, appsBeforeSvelte } = fakeVp();
    expect(await main(["my-app", "saas"], run)).toBe(0);
    expect(run.mock.calls).toEqual([
      ["vp", MONOREPO, dir],
      ["vp", SVELTE, project()],
      ["vp", ["install"], project()],
      ["vp", ["fmt"], project()],
    ]);
    // The sample packages are gone before the app is added.
    expect(appsBeforeSvelte).toEqual([[]]);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenLastCalledWith("Created my-app with the saas preset");
  });

  test("local-business creates the same base project for now", async () => {
    const console = spyConsole();
    const { run } = fakeVp();
    expect(await main(["my-app", "local-business"], run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(4);
    expect(console.log).toHaveBeenLastCalledWith("Created my-app with the local-business preset");
  });

  test("adapts the monorepo and the generated app", async () => {
    spyConsole();
    const { run } = fakeVp();
    expect(await main(["my-app", "saas"], run)).toBe(0);

    // Root: only the prepare script, the Node engine set, other engines kept, no sample packages.
    expect(await readJson(join(project(), "package.json"))).toEqual({
      name: "my-app",
      scripts: { prepare: "vp config" },
      engines: { node: ">=24.11.0", pnpm: ">=12" },
    });
    expect(await readdir(join(project(), "apps"))).toEqual(["web"]);
    expect(await readdir(join(project(), "packages"))).toEqual([]);
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
        prepare: "svelte-kit sync && wrangler types || echo ''",
        check: `vp check --deny-warnings && ${SV_CHECK}`,
        gen: "wrangler types",
      },
      // typescript stays on sv's 6.x: svelte-kit sync needs its JS API.
      devDependencies: { "@types/node": "catalog:", typescript: "^6.0.3", wrangler: "^4.97.0" },
    });
    expect(await readFile(join(app(), ".gitignore"), "utf8")).toBe(
      "node_modules\n.wrangler\n\n# Worker types, generated by the prepare script\nworker-configuration.d.ts\n",
    );
    expect(await readFile(join(app(), "wrangler.jsonc"), "utf8")).toBe(
      '{\n  "name": "my-app-web",\n  "compatibility_flags": ["nodejs_compat"],\n}\n',
    );

    // Editor settings: merged into the root (the root setting wins), the app's .vscode removed.
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
    spyConsole();
    const { run } = fakeVp({
      app: async () => {
        await rm(join(app(), ".vscode"), { recursive: true });
        const pkg = await readJson(join(app(), "package.json"));
        delete pkg.devDependencies["@types/node"];
        await writeJson(join(app(), "package.json"), pkg);
      },
    });
    expect(await main(["my-app", "saas"], run)).toBe(0);
    expect(await readJson(join(project(), ".vscode", "extensions.json"))).toEqual({
      recommendations: ["VoidZero.vite-plus-extension-pack"],
    });
    expect((await readJson(join(app(), "package.json"))).devDependencies).toEqual({
      typescript: "^6.0.3",
      wrangler: "^4.97.0",
    });
  });

  test("accepts an existing empty directory", async () => {
    spyConsole();
    await mkdir(project());
    const { run } = fakeVp();
    expect(await main(["my-app", "saas"], run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(4);
  });
});

describe("expected failures print one message and return 1", () => {
  test("a non-empty target directory, without running anything", async () => {
    const console = spyConsole();
    await mkdir(project());
    await writeFile(join(project(), "file.txt"), "");
    const run = vi.fn<Run>();
    expect(await main(["my-app", "saas"], run)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(console.error.mock.calls).toEqual([
      [`Directory ${project()} already exists and is not empty`],
    ]);
  });

  test("a target that is a file", async () => {
    const console = spyConsole();
    await writeFile(project(), "");
    expect(await main(["my-app", "saas"], vi.fn<Run>())).toBe(1);
    expect(console.error.mock.calls).toEqual([
      [`${project()} already exists and is not a directory`],
    ]);
  });

  test("a failed vp command stops the run", async () => {
    const console = spyConsole();
    const run = vi.fn<Run>(async () => {
      throw new CliError("vp create exited with code 1");
    });
    expect(await main(["my-app", "saas"], run)).toBe(1);
    expect(run).toHaveBeenCalledOnce();
    expect(console.error.mock.calls).toEqual([["vp create exited with code 1"]]);
  });

  test("a failed SvelteKit step does not install", async () => {
    const console = spyConsole();
    const { run } = fakeVp();
    run.mockImplementationOnce(async () => writeTemplate(project()));
    run.mockImplementationOnce(async () => {
      throw new CliError("vp create svelte exited with code 1");
    });
    expect(await main(["my-app", "saas"], run)).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(console.error.mock.calls).toEqual([["vp create svelte exited with code 1"]]);
  });

  /** A newer vp or sv that generates something else: each checked edit fails with its own message. */
  const changedOutput: {
    what: string;
    hooks: Parameters<typeof fakeVp>[0];
    message: () => string;
  }[] = [
    {
      what: "the app's vite.config.ts imports defineConfig differently",
      hooks: { app: () => writeFile(join(app(), "vite.config.ts"), "export default {};\n") },
      message: () =>
        `${join(app(), "vite.config.ts")}: expected 'import { defineConfig } from "vite";'`,
    },
    {
      what: "sv generated a different check script",
      hooks: { app: () => replaceIn(join(app(), "package.json"), SV_CHECK, "svelte-check") },
      message: () => `${join(app(), "package.json")}: expected the check script '${SV_CHECK}'`,
    },
    {
      what: "sv generated a different prepare script",
      hooks: {
        app: () => replaceIn(join(app(), "package.json"), "svelte-kit sync || echo ''", "x"),
      },
      message: () =>
        `${join(app(), "package.json")}: expected the prepare script 'svelte-kit sync || echo '''`,
    },
    {
      what: "the Worker is not named after the app",
      hooks: {
        app: () => replaceIn(join(app(), "wrangler.jsonc"), '"name": "web"', '"name": "x"'),
      },
      message: () => `${join(app(), "wrangler.jsonc")}: expected '"name": "web"'`,
    },
    {
      what: "sv no longer enables nodejs_als",
      hooks: { app: () => replaceIn(join(app(), "wrangler.jsonc"), '"nodejs_als"', '"x"') },
      message: () => `${join(app(), "wrangler.jsonc")}: expected '"nodejs_als"'`,
    },
    {
      what: "pnpm-workspace.yaml has no allowBuilds",
      hooks: {
        template: () =>
          writeFile(join(project(), "pnpm-workspace.yaml"), "packages:\n  - apps/*\n"),
      },
      message: () => `${join(project(), "pnpm-workspace.yaml")}: expected 'allowBuilds:'`,
    },
    {
      what: "the root vite.config.ts has no empty fmt block",
      hooks: {
        template: () => replaceIn(join(project(), "vite.config.ts"), "fmt: {}", "fmt: { a: 1 }"),
      },
      message: () => `${join(project(), "vite.config.ts")}: expected 'fmt: {}'`,
    },
  ];

  for (const { what, hooks, message } of changedOutput) {
    test(`changed output: ${what}`, async () => {
      const console = spyConsole();
      const { run } = fakeVp(hooks);
      expect(await main(["my-app", "saas"], run)).toBe(1);
      expect(console.error.mock.calls).toEqual([[message()]]);
      // Nothing is installed after a failed edit.
      expect(run.mock.calls.map(([, args]) => args[0])).not.toContain("install");
    });
  }

  test("any other error is a bug and is rethrown", async () => {
    spyConsole();
    const run = vi.fn<Run>(async () => {
      throw new TypeError("bug");
    });
    await expect(main(["my-app", "saas"], run)).rejects.toThrow(new TypeError("bug"));
  });
});

/** Replaces `from` in a fixture file; the test fails if the fixture does not contain it. */
async function replaceIn(file: string, from: string, to: string) {
  const text = await readFile(file, "utf8");
  expect(text).toContain(from);
  await writeFile(file, text.replace(from, to));
}

describe("spawnRun", () => {
  const node = process.execPath;

  test("resolves when the command exits with 0", async () => {
    await spawnRun(node, ["-e", "process.exit(0)"], dir);
  });

  test("rejects with the exit code", async () => {
    await expect(spawnRun(node, ["-e", "process.exit(3)"], dir)).rejects.toThrow(
      new CliError(`${node} -e process.exit(3) exited with code 3`),
    );
  });

  test("rejects when the command does not exist", async () => {
    await expect(spawnRun("create-danku-missing-command", [], dir)).rejects.toThrow(
      new CliError("create-danku-missing-command was not found; is it installed and on PATH?"),
    );
  });
});
