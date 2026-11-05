import { createHash } from "node:crypto";

import { CliError } from "./error.ts";
import { loadProject } from "./project.ts";
import { D1 } from "./resources/cloudflare/d1.ts";
import { DnsRecord } from "./resources/cloudflare/dns-record.ts";
import { RedirectRule } from "./resources/cloudflare/redirect-rule.ts";
import { Worker } from "./resources/cloudflare/worker.ts";
import { Zone } from "./resources/cloudflare/zone.ts";
import { type Kind, Resource, resources } from "./resources/resource.ts";
import type { Run } from "./run.ts";

/**
 * Every kind danku deploys. All of them are listed on each run, so removed resources are found.
 */
const kinds: (Kind & (abstract new (...args: never[]) => Resource))[] = [
  Zone,
  D1,
  DnsRecord,
  RedirectRule,
  Worker,
];

/** Cloud names as the plan prints them: long ones (a DKIM key) are cut short. */
const short = (name: string) => (name.length > 80 ? `${name.slice(0, 79)}…` : name);

/**
 * `danku deploy`: makes the cloud match danku/deploy.ts. Everything is read and planned before the
 * first change, so a failing check or lookup leaves the cloud untouched.
 */
export async function deploy(run: Run): Promise<void> {
  const { root, project } = await loadProject();

  // CI deploys production. Anywhere else is dev, which applies only kinds local tools can't
  // provide, so a laptop needs no Cloudflare token.
  const production = !["", "0", "false"].includes(process.env.CI ?? "");
  const active = kinds.filter((kind) => production || !kind.ciOnly);
  const declared = resources.filter((resource) => active.some((kind) => resource instanceof kind));

  // Checked before any call, so a long name or a missing build can't fail a deploy halfway.
  const hashes = new Map<Resource, string>();
  for (const resource of declared) {
    resource.cloudName(project);
    // Resources other resources point at (`bindings: { DB: db }`) count by name: their id and
    // outputs are set during the run and would change the hash between two identical deploys.
    const inputs = JSON.stringify(resource.inputs, (_, value: unknown) =>
      value instanceof Resource ? value.name : value,
    );
    const hash = createHash("sha256")
      .update(inputs)
      .update((await resource.fingerprint?.(root)) ?? "");
    hashes.set(resource, hash.digest("hex").slice(0, 16));
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
    const label = `${resource.constructor.name} "${resource.name}"`;
    const name = resource.cloudName(project);
    const owner = { project, name: resource.name, hash: hashes.get(resource)! };
    const matches = owned.filter(
      ({ kind, owner }) => resource instanceof kind && owner.name === resource.name,
    );
    if (matches.length > 1) {
      throw new CliError(
        `${label} exists ${matches.length} times in the cloud; delete the extra copies`,
      );
    }
    const [match] = matches;
    // danku only touches what it created: a resource that already has the name it would create
    // stops the deploy before any change. Only kinds with unique names list untagged ones, and
    // only kinds that exist before danku runs (zones) adopt the untagged one instead. One this project owns under a label no longer declared was renamed in deploy.ts
    // (possible where the label isn't part of the cloud name): it's taken over, not refused.
    const taken = match
      ? undefined
      : found.find(({ kind, name: it }) => resource instanceof kind && it === name);
    const renamed =
      taken?.owner?.project === project &&
      !declared.some((it) => it instanceof taken.kind && it.name === taken.owner!.name);
    const adopt =
      taken && (renamed || (!taken.owner && (resource.constructor as unknown as Kind).adopt));
    if (taken && !adopt) {
      throw new CliError(
        `${label}: ${name} already exists, ` +
          (taken.owner
            ? `and belongs to the danku project "${taken.owner.project}"`
            : "but danku didn't create it; remove it, or change danku/deploy.ts so they don't clash"),
      );
    }
    if (!match && !taken && !resource.create) {
      throw new CliError(
        `${label}: ${name} was not found; danku adopts a ${resource.constructor.name} but never creates one, so add it first`,
      );
    }
    const existing = match ?? taken;
    if (existing) {
      resource.id = existing.id;
      resource.outputs = existing.outputs;
    }
    const change = taken
      ? "adopt"
      : !match
        ? "create"
        : match.owner.hash === owner.hash
          ? "none"
          : "update";
    return { resource, name, owner, change };
  });
  // Every resource now knows what exists, so checks across resources (a Worker's zone) can run.
  for (const { resource } of steps) resource.check?.();
  const orphans = owned.filter(
    ({ kind, id, owner }) =>
      !declared.some(
        (resource) =>
          resource instanceof kind && (resource.name === owner.name || resource.id === id),
      ),
  );
  // Orphans go last, once everything that might replace them exists, except ones holding what a
  // declared resource needs (a renamed Worker's domain): those go first, or it couldn't be taken.
  const held = new Map(
    orphans.flatMap((orphan) => {
      const what = orphan.kind.delete && orphan.kind.holds?.(orphan, declared);
      return what ? [[orphan, what] as const] : [];
    }),
  );

  for (const resource of resources) {
    const label = `${resource.constructor.name} ${resource.name}`;
    const step = steps.find((it) => it.resource === resource);
    const url = step && resource.url?.(project);
    const at = url ? ` → ${url}` : "";
    if (!step) console.log(`· ${label}: skipped in dev`);
    else if (step.change === "none") console.log(`= ${label}: no changes${at}`);
    else {
      console.log(
        `${step.change === "create" ? "+" : "~"} ${label}: ${step.change} ${short(step.name)}${at}`,
      );
    }
  }
  for (const orphan of orphans) {
    const { kind, owner, name } = orphan;
    const label = `${kind.name} ${owner.name}`;
    const what = held.get(orphan);
    if (what) console.log(`- ${label}: delete ${short(name)} first, to free ${what}`);
    else if (kind.delete) console.log(`- ${label}: delete ${short(name)}`);
    else {
      console.log(
        `! ${label}: ${name} is no longer in danku/deploy.ts; danku never deletes data, so delete it yourself once you no longer need it`,
      );
    }
  }

  for (const orphan of held.keys()) await orphan.kind.delete!(orphan);
  for (const { resource, owner, change } of steps) {
    if (change === "create") await resource.create!(owner, root, run);
    // Adopting writes danku's tags, which is what an update of an unchanged resource does.
    if (change === "update" || change === "adopt") await resource.update(owner, root, run);
  }
  for (const orphan of orphans) if (!held.has(orphan)) await orphan.kind.delete?.(orphan);
}
