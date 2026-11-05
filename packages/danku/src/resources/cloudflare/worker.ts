import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { CliError } from "../../error.ts";
import type { Run } from "../../run.ts";
import { type Owner, Resource } from "../resource.ts";
import { cloudflare, listTagged, retag, tag } from "./api.ts";
import type { D1 } from "./d1.ts";
import { type Subdomain, Zone } from "./zone.ts";

/**
 * Pins the Workers runtime's behaviour for every Worker. danku sets it, so upgrading danku is how it
 * moves; keep it no later than the workerd in the newest wrangler, or local dev falls back to an
 * older date.
 */
export const compatibilityDate = "2026-10-13";

/** Where adapter-cloudflare writes the build, relative to the app. */
const output = ".svelte-kit/cloudflare";
/** Every folder that build spans: `_worker.js` imports the server code from the second. */
const build = [output, `${output}-tmp`];

/** What deploy.ts sets on a Worker. */
export interface WorkerInputs {
  /** The app's folder, relative to the repo root, e.g. `apps/web`. */
  app: string;
  /** Binding name → resource, e.g. `{ DB: db }`; the app reads them from `cloudflare:workers`. */
  bindings?: Record<string, D1>;
  /**
   * Where the app is served: a zone (`zone`, example.com) or a hostname in one (`zone.sub("app")`).
   * Cloudflare creates its DNS record and certificate. Without it, the app is served on workers.dev.
   */
  domain?: Zone | Subdomain;
}

/**
 * The app's wrangler config: `danku generate` writes it as wrangler.jsonc, without database ids;
 * `danku deploy` writes it as wrangler.deploy.jsonc, with the ids only the cloud knows.
 */
export function wranglerConfig(worker: Worker, project: string) {
  const hostname = worker.hostname();
  return {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: worker.cloudName(project),
    main: `${output}/_worker.js`,
    compatibility_date: compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    // With a domain, the app is served there only: a public workers.dev copy would duplicate it.
    workers_dev: !hostname,
    preview_urls: false,
    ...(hostname && { routes: [{ pattern: hostname, custom_domain: true }] }),
    assets: { binding: "ASSETS", directory: output },
    d1_databases: Object.entries(worker.inputs.bindings ?? {}).map(([binding, database]) => ({
      binding,
      database_name: database.cloudName(project),
      // Unset outside deploy: local dev doesn't need it.
      database_id: database.id,
    })),
  };
}

interface WorkerOutputs {
  /** The script name, which Cloudflare deletes it by. */
  name: string;
  /** Its custom domains: the `domain` it was deployed with. */
  domains: { id: string; hostname: string }[];
}

/**
 * A Cloudflare Worker running one app, uploaded with wrangler from the app's build output. Not data:
 * one removed from deploy.ts is deleted, with its custom domain.
 */
export class Worker extends Resource<WorkerInputs, WorkerOutputs> {
  // Local dev runs the app with Vite and wrangler's local runtime.
  static ciOnly = true;
  /** The account's workers.dev subdomain, read by list(); unset when the account has none. */
  static subdomain: string | undefined;

  static async list() {
    const { client, path } = cloudflare();
    const [tagged, scripts, domains, subdomain] = await Promise.all([
      listTagged(),
      client.workerScriptListWorkers({ path }).then(({ data }) => data.result ?? []),
      client.workersDomainsList({ path }).then(({ data }) => data.result ?? []),
      // Only for printing URLs, so an account without one (or a failed read) isn't an error.
      client.workerSubdomainGetSubdomain({ path }).then(
        ({ data }) => data.result.subdomain,
        () => undefined,
      ),
    ]);
    Worker.subdomain = subdomain;
    // Cloudflare's own list decides what exists, the tags who owns it (as for D1). Script names are
    // unique per account, so untagged ones are returned too: deploy refuses to create over them.
    const owners = new Map(
      tagged.filter(({ type }) => type === "worker").map(({ id, owner }) => [id, owner]),
    );
    return scripts.flatMap(({ id: name, tag: id }) =>
      name && id
        ? [
            {
              id,
              name,
              owner: owners.get(id),
              outputs: {
                name,
                domains: domains
                  .filter(({ service }) => service === name)
                  .map(({ id, hostname }) => ({ id, hostname })),
              },
            },
          ]
        : [],
    );
  }

  /**
   * An orphan Worker on a hostname a declared Worker is now deployed to (a renamed Worker keeping its
   * domain): it has to let go of it before the new one can take it over.
   */
  static holds({ outputs }: { outputs: unknown }, declared: Resource[]): string | undefined {
    const { domains } = outputs as WorkerOutputs;
    return domains.find(({ hostname }) =>
      declared.some((it) => it instanceof Worker && it.hostname() === hostname),
    )?.hostname;
  }

  static async delete({ outputs }: { outputs: unknown }): Promise<void> {
    const { client, path } = cloudflare();
    const { name, domains } = outputs as WorkerOutputs;
    // Detaching a custom domain removes the DNS record and certificate Cloudflare made for it;
    // done explicitly rather than trusting the script's deletion to do it.
    for (const { id } of domains) {
      await client.workersDomainsDelete({ path: { ...path, domain_id: id } });
    }
    await client.workerScriptDeleteWorker({ path: { ...path, script_name: name } });
  }

  constructor(name: string, inputs: WorkerInputs) {
    super(name, inputs);
    // zone.sub() also accepts DNS-only names like `_dmarc`, which can't serve a website.
    const hostname = this.hostname();
    if (hostname?.includes("_")) {
      throw new CliError(
        `Worker "${name}": ${hostname} can't serve a Worker; hostnames use letters, digits and dashes`,
      );
    }
  }

  /** The hostname of its `domain`, if it has one. */
  hostname(): string | undefined {
    const { domain } = this.inputs;
    return domain instanceof Zone ? domain.name : domain?.hostname;
  }

  /** Where the app is served once deployed. */
  url(project: string): string | undefined {
    const hostname = this.hostname();
    if (hostname) return `https://${hostname}`;
    if (Worker.subdomain)
      return `https://${this.cloudName(project)}.${Worker.subdomain}.workers.dev`;
  }

  /** Cloudflare only serves custom domains on active zones; pending ones wait for nameservers. */
  check(): void {
    const { domain } = this.inputs;
    const zone = domain instanceof Zone ? domain : domain?.zone;
    const status = zone?.outputs?.status;
    if (zone && status !== "active") {
      throw new CliError(
        `Worker "${this.name}": the domain ${zone.name} isn't active in Cloudflare yet (it's ${status}); finish adding it in the dashboard, then deploy again`,
      );
    }
  }

  /** The compatibility date and every file of the build, so a new build redeploys. */
  async fingerprint(root: string): Promise<string> {
    const app = join(root, this.inputs.app);
    const hash = createHash("sha256").update(compatibilityDate);
    for (const folder of build) {
      const dir = join(app, folder);
      const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => {
        throw new CliError(
          `Worker "${this.name}": ${this.inputs.app}/${folder} was not found; build the app before deploying`,
        );
      });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
      for (const file of files) {
        // Paths with `/` on every OS, so a laptop and CI agree on the hash.
        hash.update(relative(app, file).split(sep).join("/")).update(await readFile(file));
      }
    }
    return hash.digest("hex");
  }

  async create(owner: Owner, root: string, run: Run): Promise<void> {
    await this.upload(owner, root, run);
    // Cloudflare tags a Worker by its immutable id, which exists only once uploaded.
    const { client, path } = cloudflare();
    const { data } = await client.workerScriptListWorkers({ path });
    const name = this.cloudName(owner.project);
    const id = data.result?.find((script) => script.id === name)?.tag;
    if (!id) throw new Error(`Cloudflare doesn't list the Worker ${name} just deployed`);
    this.id = id;
    await tag({ type: "worker", id }, owner);
  }

  async update(owner: Owner, root: string, run: Run): Promise<void> {
    await this.upload(owner, root, run);
    await retag({ type: "worker", id: this.id! }, owner);
  }

  /** Writes wrangler.deploy.jsonc next to the app's wrangler.jsonc and deploys the build with it. */
  private async upload(owner: Owner, root: string, run: Run): Promise<void> {
    const app = join(root, this.inputs.app);
    const config = `${JSON.stringify(wranglerConfig(this, owner.project), null, 2)}\n`;
    await writeFile(join(app, "wrangler.deploy.jsonc"), config);
    await run("vp", ["exec", "wrangler", "deploy", "--config", "wrangler.deploy.jsonc"], app);
  }
}
