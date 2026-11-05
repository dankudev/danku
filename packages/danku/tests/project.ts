import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { vi } from "vite-plus/test";

import { main } from "../src/index.ts";
import type { Run } from "../src/run.ts";

export const workspace = { "pnpm-workspace.yaml": "packages:\n  - apps/*\n" };
export const named = (name?: string) => ({ "package.json": JSON.stringify({ name }) });
export const deployTs = (body: string) => ({
  "danku/deploy.ts": `import { D1, DnsRecord, Worker, Zone } from "@dankudev/danku/deploy/cloudflare";\n${body}`,
});
/** A project named acme with this deploy.ts. */
export const acme = (body: string) => ({ ...workspace, ...named("acme"), ...deployTs(body) });

const cwd = process.cwd();
const dirs: string[] = [];

/**
 * Writes a project into a new folder and moves into it, or into `cwd` inside it. Always a new
 * folder: Node caches imports by path, so a reused deploy.ts would not run its constructors again.
 */
export async function project(files: Record<string, string>, cwd = ".") {
  const dir = await mkdtemp(join(tmpdir(), "danku-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await mkdir(join(dir, cwd), { recursive: true });
  process.chdir(join(dir, cwd));
  return dir;
}

/** Copies the project in `dir` to a new folder and moves into it, for a second run of the same files. */
export async function copy(dir: string) {
  const copied = await mkdtemp(join(tmpdir(), "danku-"));
  dirs.push(copied);
  await cp(dir, copied, { recursive: true });
  process.chdir(copied);
  return copied;
}

/** For afterEach: leaves and deletes every project the test wrote. */
export async function cleanUp() {
  process.chdir(cwd);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** Runs danku with these arguments; returns the exit code and what it printed. */
export async function danku(argv: string[], run?: Run) {
  // Spying again returns the same spy; `restoreMocks` in vite.config.ts undoes it after each test.
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  log.mockClear();
  error.mockClear();
  const exitCode = await main(argv, run);
  return {
    exitCode,
    stdout: log.mock.calls.flat().join("\n"),
    stderr: error.mock.calls.flat().join("\n"),
  };
}
