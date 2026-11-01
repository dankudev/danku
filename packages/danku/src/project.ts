import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { CliError } from "./error.ts";
import { resources } from "./resources/resource.ts";

/**
 * The repo root: the closest folder, from here upwards, with a pnpm-workspace.yaml. Being the
 * workspace root, it is found from inside any app, where app scripts run danku.
 */
export function findRoot(): string | undefined {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Loads danku/deploy.ts for `danku deploy` and `danku generate`, so both agree on the root and the
 * project name. The declared resources end up in `resources`.
 */
export async function loadProject(): Promise<{ root: string; project: string }> {
  const root = findRoot();
  if (!root) {
    throw new CliError(
      "danku must run inside a pnpm workspace (no pnpm-workspace.yaml in this folder or any folder above it)",
    );
  }
  // Only the root's danku/deploy.ts counts, never one inside an app.
  const deployFile = join(root, "danku", "deploy.ts");
  if (!existsSync(deployFile)) {
    throw new CliError(`${deployFile} was not found; it belongs at the repo root`);
  }

  // The root package.json names the project, which prefixes every cloud name.
  const packageFile = join(root, "package.json");
  const { name = "" } = (await readFile(packageFile, "utf8").then(
    (text) => JSON.parse(text),
    () => ({}),
  )) as { name?: string };
  const project = name.replace(/^@[^/]+\//, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new CliError(
      `${packageFile}: "name" is the project name; use lowercase letters, digits and dashes`,
    );
  }

  // Declaring registers each resource. If deploy.ts throws, nothing has been read or changed yet.
  resources.length = 0;
  await import(pathToFileURL(deployFile).href);
  if (resources.length === 0) throw new CliError("danku/deploy.ts declares no resources");

  return { root, project };
}
