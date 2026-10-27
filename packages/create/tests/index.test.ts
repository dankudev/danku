import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  assertEmptyDirectory,
  cleanMonorepo,
  CliError,
  enableNodejsCompat,
  generateWorkerTypes,
  main,
  mergeEditorSettings,
  nameWorker,
  parse,
  type Run,
  spawnRun,
  updateAppPackage,
  USAGE,
  useVitePlusDefineConfig,
} from "../src/index.ts";

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

/** Writes the parts of a `vp create vite:monorepo` result that `cleanMonorepo` touches. */
async function writeTemplate(directory: string) {
  for (const path of ["apps/website", "packages/utils"]) {
    await mkdir(join(directory, path, "src"), { recursive: true });
    await writeFile(join(directory, path, "package.json"), "{}");
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: "my-app",
        scripts: {
          ready: "vp check && vp run -r test && vp run -r build",
          dev: "vp run website#dev",
          prepare: "vp config",
        },
        engines: { node: ">=22.18.0" },
      },
      null,
      2,
    ),
  );
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

async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readPackageJson(directory: string) {
  return readJson(join(directory, "package.json"));
}

describe("parse", () => {
  test("takes the project name", () => {
    expect(parse(["my-app"])).toEqual({ name: "my-app" });
  });

  test("requires exactly one name", () => {
    expect(() => parse([])).toThrow("Expected exactly one project name");
    expect(() => parse(["a", "b"])).toThrow("Expected exactly one project name");
  });

  test("rejects invalid names", () => {
    for (const name of ["My-App", "my_app", "my app", "../app"]) {
      expect(() => parse([name])).toThrow(`Invalid project name "${name}"`);
    }
  });

  test("rejects unknown options", () => {
    expect(() => parse(["my-app", "--help"])).toThrow("Unknown option '--help'");
  });

  test("rejects unknown presets", () => {
    expect(() => parse(["my-app", "--preset", "blog"])).toThrow('Unknown preset "blog"');
  });

  test("recognizes presets that are not implemented yet", () => {
    expect(() => parse(["my-app", "--preset", "saas"])).toThrow(
      'Preset "saas" is not available yet',
    );
    expect(() => parse(["my-app", "--preset=saas-split"])).toThrow(
      'Preset "saas-split" is not available yet',
    );
  });
});

describe("assertEmptyDirectory", () => {
  test("accepts a missing or empty directory", async () => {
    await assertEmptyDirectory(join(dir, "missing"));
    await assertEmptyDirectory(dir);
  });

  test("rejects a directory with entries", async () => {
    await writeFile(join(dir, "file.txt"), "");
    await expect(assertEmptyDirectory(dir)).rejects.toThrow(
      new CliError(`Directory ${dir} already exists and is not empty`),
    );
  });

  test("rejects a file", async () => {
    const file = join(dir, "file.txt");
    await writeFile(file, "");
    await expect(assertEmptyDirectory(file)).rejects.toThrow(
      new CliError(`${file} already exists and is not a directory`),
    );
  });
});

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

describe("cleanMonorepo", () => {
  test("removes the sample packages, keeps only the prepare script and sets the Node engine", async () => {
    await writeTemplate(dir);
    await cleanMonorepo(dir);
    expect(await readdir(join(dir, "apps"))).toEqual([]);
    expect(await readdir(join(dir, "packages"))).toEqual([]);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(
      `${JSON.stringify(
        { name: "my-app", scripts: { prepare: "vp config" }, engines: { node: ">=24.11.0" } },
        null,
        2,
      )}\n`,
    );
  });

  test("adds the prepare script when the template has none", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vp dev" } }));
    await cleanMonorepo(dir);
    expect((await readPackageJson(dir)).scripts).toEqual({ prepare: "vp config" });
  });

  test("keeps other engines and adds a missing one", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ engines: { pnpm: ">=12" } }));
    await cleanMonorepo(dir);
    expect((await readPackageJson(dir)).engines).toEqual({ pnpm: ">=12", node: ">=24.11.0" });
  });

  test("accepts sample packages that are already missing", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await cleanMonorepo(dir);
    expect(await readdir(dir)).toEqual(["package.json"]);
  });
});

describe("useVitePlusDefineConfig", () => {
  test("imports defineConfig from vite-plus", async () => {
    const file = join(dir, "vite.config.ts");
    await writeFile(file, VITE_CONFIG);
    await useVitePlusDefineConfig(file);
    expect(await readFile(file, "utf8")).toBe(
      VITE_CONFIG.replace('from "vite";', 'from "vite-plus";'),
    );
  });

  test("fails when the generated config changed", async () => {
    const file = join(dir, "vite.config.ts");
    await writeFile(file, 'import { defineConfig } from "vite-plus";\n');
    await expect(useVitePlusDefineConfig(file)).rejects.toThrow(
      new CliError(`${file}: expected 'import { defineConfig } from "vite";'`),
    );
  });
});

describe("updateAppPackage", () => {
  test("runs vp check in check and uses the catalog", async () => {
    await writeApp(dir);
    await updateAppPackage(dir);
    expect(await readPackageJson(dir)).toEqual({
      name: "web",
      scripts: {
        dev: "vp dev",
        prepare: "svelte-kit sync || echo ''",
        check: `vp check --deny-warnings && ${SV_CHECK}`,
        gen: "wrangler types",
      },
      // typescript stays on sv's 6.x: svelte-kit sync needs its JS API.
      devDependencies: { "@types/node": "catalog:", typescript: "^6.0.3", wrangler: "^4.97.0" },
    });
  });

  test("fails when sv generated a different check script", async () => {
    await writeJson(join(dir, "package.json"), { scripts: { check: "svelte-check" } });
    await expect(updateAppPackage(dir)).rejects.toThrow(
      new CliError(`${join(dir, "package.json")}: expected the check script '${SV_CHECK}'`),
    );
  });

  test("leaves out catalog dependencies the app does not have", async () => {
    await writeJson(join(dir, "package.json"), {
      scripts: { check: SV_CHECK },
      devDependencies: { typescript: "^6.0.3" },
    });
    await updateAppPackage(dir);
    expect((await readPackageJson(dir)).devDependencies).toEqual({ typescript: "^6.0.3" });
  });
});

describe("generateWorkerTypes", () => {
  test("adds wrangler types to prepare", async () => {
    await writeApp(dir);
    await generateWorkerTypes(dir);
    expect((await readPackageJson(dir)).scripts.prepare).toBe(
      "svelte-kit sync && wrangler types || echo ''",
    );
  });

  test("fails when sv generated a different prepare script", async () => {
    await writeJson(join(dir, "package.json"), { scripts: { prepare: "svelte-kit sync" } });
    await expect(generateWorkerTypes(dir)).rejects.toThrow(
      new CliError(
        `${join(dir, "package.json")}: expected the prepare script 'svelte-kit sync || echo '''`,
      ),
    );
  });
});

describe("nameWorker", () => {
  test("fails when the Worker is not named after the app", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), '{ "name": "other" }\n');
    await expect(nameWorker(dir, "my-app-web")).rejects.toThrow(
      new CliError(`${join(dir, "wrangler.jsonc")}: expected '"name": "web"'`),
    );
  });
});

describe("mergeEditorSettings", () => {
  test("accepts an app without .vscode", async () => {
    const app = join(dir, "apps", "web");
    await writeTemplate(dir);
    await mkdir(app, { recursive: true });
    await mergeEditorSettings(dir, app);
    expect(await readJson(join(dir, ".vscode", "extensions.json"))).toEqual({
      recommendations: ["VoidZero.vite-plus-extension-pack"],
    });
  });
});

describe("enableNodejsCompat", () => {
  test("fails when sv no longer enables nodejs_als", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), '{ "compatibility_flags": [] }\n');
    await expect(enableNodejsCompat(dir)).rejects.toThrow(
      new CliError(`${join(dir, "wrangler.jsonc")}: expected '"nodejs_als"'`),
    );
  });
});

describe("main", () => {
  const monorepo = [
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

  const svelte = [
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

  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  });

  /**
   * Stands in for vp: `vite:monorepo` writes the template into `<dir>/my-app`,
   * `svelte` records which apps existed when it ran.
   */
  function fakeVp() {
    const appsBeforeSvelte: string[][] = [];
    const run = vi.fn<Run>(async (_command, args) => {
      if (args[1] === "vite:monorepo") await writeTemplate(join(dir, "my-app"));
      else if (args[1]?.startsWith("svelte@")) {
        appsBeforeSvelte.push(await readdir(join(dir, "my-app", "apps")));
        await writeApp(join(dir, "my-app", "apps", "web"));
      }
    });
    return { run, appsBeforeSvelte };
  }

  test("creates the monorepo, adds the SvelteKit app, adapts it and installs", async () => {
    const console = spyConsole();
    const { run, appsBeforeSvelte } = fakeVp();
    expect(await main(["my-app"], run)).toBe(0);
    expect(run.mock.calls).toEqual([
      ["vp", monorepo, dir],
      ["vp", svelte, join(dir, "my-app")],
      ["vp", ["install"], join(dir, "my-app")],
      ["vp", ["fmt"], join(dir, "my-app")],
    ]);
    expect(appsBeforeSvelte).toEqual([[]]);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("adapts the generated app to the monorepo", async () => {
    spyConsole();
    const { run } = fakeVp();
    expect(await main(["my-app"], run)).toBe(0);
    const project = join(dir, "my-app");
    const app = join(project, "apps", "web");

    expect(await readFile(join(app, "vite.config.ts"), "utf8")).toContain(
      'import { defineConfig } from "vite-plus";',
    );
    expect((await readPackageJson(app)).scripts.prepare).toBe(
      "svelte-kit sync && wrangler types || echo ''",
    );
    expect(await readFile(join(app, ".gitignore"), "utf8")).toBe(
      "node_modules\n.wrangler\n\n# Worker types, generated by the prepare script\nworker-configuration.d.ts\n",
    );
    expect(await readFile(join(app, "wrangler.jsonc"), "utf8")).toBe(
      '{\n  "name": "my-app-web",\n  "compatibility_flags": ["nodejs_compat"],\n}\n',
    );
    expect(await readJson(join(project, ".vscode", "extensions.json"))).toEqual({
      recommendations: [
        "VoidZero.vite-plus-extension-pack",
        "svelte.svelte-vscode",
        "bradlc.vscode-tailwindcss",
      ],
    });
    // The root setting wins over the app's.
    expect(await readJson(join(project, ".vscode", "settings.json"))).toEqual({
      "npm.scriptRunner": "vp",
      "editor.formatOnSave": true,
      "files.associations": { "*.css": "tailwindcss" },
    });
    expect(await readFile(join(project, "vite.config.ts"), "utf8")).toContain(
      "fmt: { svelte: {}, sortImports: true }",
    );
    expect(await readFile(join(project, "pnpm-workspace.yaml"), "utf8")).toBe(
      "packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n  sharp: true\n  workerd: true\nengineStrict: true\n",
    );
    expect((await readdir(app)).sort()).toEqual([
      ".gitignore",
      "package.json",
      "src",
      "vite.config.ts",
      "wrangler.jsonc",
    ]);
    expect(await readdir(join(app, "src", "lib"))).toEqual([]);
  });

  test("accepts an existing empty directory", async () => {
    spyConsole();
    await mkdir(join(dir, "my-app"));
    const { run } = fakeVp();
    expect(await main(["my-app"], run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(4);
  });

  test("does not add the app when the monorepo could not be created", async () => {
    spyConsole();
    const run = vi.fn<Run>(async () => {
      throw new CliError("vp create exited with code 1");
    });
    expect(await main(["my-app"], run)).toBe(1);
    expect(run).toHaveBeenCalledOnce();
  });

  test("prints a failed SvelteKit step without the usage", async () => {
    const console = spyConsole();
    const { run } = fakeVp();
    run.mockImplementationOnce(async () => writeTemplate(join(dir, "my-app")));
    run.mockImplementationOnce(async () => {
      throw new CliError("vp create svelte exited with code 1");
    });
    expect(await main(["my-app"], run)).toBe(1);
    expect(console.error.mock.calls).toEqual([["vp create svelte exited with code 1"]]);
  });

  test("prints the error and usage and returns 1 for invalid arguments", async () => {
    const console = spyConsole();
    const run = vi.fn<Run>();
    expect(await main([], run)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(console.error.mock.calls).toEqual([["Expected exactly one project name"], [USAGE]]);
  });

  test("refuses a non-empty target directory without running anything", async () => {
    const console = spyConsole();
    await mkdir(join(dir, "my-app"));
    await writeFile(join(dir, "my-app", "file.txt"), "");
    const run = vi.fn<Run>();
    expect(await main(["my-app"], run)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(console.error.mock.calls).toEqual([
      [`Directory ${join(dir, "my-app")} already exists and is not empty`],
    ]);
  });

  test("prints a failed command without the usage", async () => {
    const console = spyConsole();
    const run = vi.fn<Run>(async () => {
      throw new CliError("vp create exited with code 1");
    });
    expect(await main(["my-app"], run)).toBe(1);
    expect(console.error.mock.calls).toEqual([["vp create exited with code 1"]]);
  });

  test("rethrows unexpected errors", async () => {
    spyConsole();
    const run = vi.fn<Run>(async () => {
      throw new TypeError("bug");
    });
    await expect(main(["my-app"], run)).rejects.toThrow(new TypeError("bug"));
  });
});
