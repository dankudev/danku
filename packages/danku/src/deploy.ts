import { createHash } from "node:crypto";

import { CliError } from "./error.ts";
import { loadProject } from "./project.ts";
import { D1 } from "./resources/cloudflare/d1.ts";
import { Worker } from "./resources/cloudflare/worker.ts";
import { cloudName, type Kind, Resource, resources } from "./resources/resource.ts";

/** Every kind danku deploys. All of them are listed on each run, so removed resources are found. */
const kinds: (Kind & (abstract new (...args: never[]) => Resource))[] = [D1, Worker];

/**
 * `danku deploy`: makes the cloud match danku/deploy.ts. Everything is read and planned before the
 * first change, so a failing check or lookup leaves the cloud untouched.
 */
export async function deploy(): Promise<void> {
  const { project } = await loadProject();

  // CI deploys production. Anywhere else is dev, which applies only kinds local tools can't
  // provide, so a laptop needs no Cloudflare token.
  const production = !["", "0", "false"].includes(process.env.CI ?? "");
  const active = kinds.filter((kind) => production || !kind.ciOnly);
  const declared = resources.filter((resource) => active.some((kind) => resource instanceof kind));

  // Checked before any call, so a long name can't fail a deploy halfway.
  for (const resource of declared) {
    const name = cloudName({ project, name: resource.name });
    if (name.length > 63) {
      throw new CliError(
        `${resource.constructor.name} "${resource.name}": ${name} is longer than 63 characters`,
      );
    }
  }

  const found = (
    await Promise.all(
      active.map(async (kind) => (await kind.list()).map((existing) => ({ ...existing, kind }))),
    )
  ).flat();
  // Other projects' resources in the same account are never shown or touched.
  const owned = found.flatMap(({ owner, ...existing }) =>
    owner?.project === project ? [{ ...existing, owner }] : [],
  );

  const steps = declared.map((resource) => {
    // Resources other resources point at (`bindings: { DB: db }`) count by name: their id and
    // outputs are set during the run and would change the hash between two identical deploys.
    const inputs = JSON.stringify(resource.inputs, (_, value: unknown) =>
      value instanceof Resource ? value.name : value,
    );
    const owner = {
      project,
      name: resource.name,
      hash: createHash("sha256").update(inputs).digest("hex").slice(0, 16),
    };
    const matches = owned.filter(
      ({ kind, owner }) => resource instanceof kind && owner.name === resource.name,
    );
    if (matches.length > 1) {
      throw new CliError(
        `${resource.constructor.name} "${resource.name}" exists ${matches.length} times in the cloud; delete the extra copies`,
      );
    }
    const [match] = matches;
    // danku only touches what it created: a resource that already has the name it would create
    // stops the deploy before any change. Only kinds with unique names list untagged ones.
    const taken = match
      ? undefined
      : found.find(({ kind, name }) => resource instanceof kind && name === cloudName(owner));
    if (taken) {
      throw new CliError(
        `${resource.constructor.name} "${resource.name}": ${cloudName(owner)} already exists, ` +
          (taken.owner
            ? `and belongs to the danku project "${taken.owner.project}"`
            : "but danku didn't create it (it has no danku tags); remove it or rename the resource in danku/deploy.ts"),
      );
    }
    if (match) {
      resource.id = match.id;
      resource.outputs = match.outputs;
    }
    const change = !match ? "create" : match.owner.hash === owner.hash ? "none" : "update";
    return { resource, owner, change };
  });
  const orphans = owned.filter(
    ({ kind, owner }) =>
      !declared.some((resource) => resource instanceof kind && resource.name === owner.name),
  );

  for (const resource of resources) {
    const label = `${resource.constructor.name} ${resource.name}`;
    const step = steps.find((it) => it.resource === resource);
    if (!step) console.log(`· ${label}: skipped in dev`);
    else if (step.change === "none") console.log(`= ${label}: no changes`);
    else
      console.log(
        `${step.change === "create" ? "+" : "~"} ${label}: ${step.change} ${cloudName(step.owner)}`,
      );
  }
  for (const { kind, owner } of orphans) {
    const label = `${kind.name} ${owner.name}`;
    if (kind.delete) console.log(`- ${label}: delete ${cloudName(owner)}`);
    else {
      console.log(
        `! ${label}: ${cloudName(owner)} is no longer in danku/deploy.ts; danku never deletes data, so delete it yourself once you no longer need it`,
      );
    }
  }

  for (const { resource, owner, change } of steps) {
    if (change === "create") await resource.create(owner);
    if (change === "update") await resource.update(owner);
  }
  // Orphans go last, once everything that might replace them exists.
  for (const { kind, id } of orphans) await kind.delete?.(id);
}
