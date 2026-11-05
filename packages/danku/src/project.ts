import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { CliError } from "./error.ts";
import { resources } from "./resources/resource.ts";

/**
 * Loads danku/deploy.ts for `danku deploy` and `danku generate`, so both agree on the root and the
 * project name. The declared resources end up in `resources`.
 */
export async function loadProject(): Promise<{ root: string; project: string }> {
  // The root is the closest folder, from here upwards, with danku/deploy.ts, e.g. from an app.
  let root = process.cwd();
  while (!existsSync(join(root, "danku", "deploy.ts"))) {
    if (dirname(root) === root) {
      throw new CliError(`no danku/deploy.ts in ${process.cwd()} or its parent folders`);
    }
    root = dirname(root);
  }
  const deployFile = join(root, "danku", "deploy.ts");

  // The root package.json names the project, which prefixes every cloud name.
  const packageFile = join(root, "package.json");
  const { name: project = "" } = (await readFile(packageFile, "utf8").then(
    (text) => JSON.parse(text),
    () => ({}),
  )) as { name?: string };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    throw new CliError(
      `${packageFile}: "name" is the project name; use lowercase letters, digits and dashes, without a scope`,
    );
  }

  // Declaring registers each resource. If deploy.ts throws, nothing has been read or changed yet.
  resources.length = 0;
  await import(pathToFileURL(deployFile).href);
  if (resources.length === 0) throw new CliError("danku/deploy.ts declares no resources");

  return { root, project };
}
