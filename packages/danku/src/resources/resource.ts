import { CliError } from "../error.ts";
import type { Run } from "../run.ts";

/** What danku stores on every resource it creates, in place of a state file. */
export interface Owner {
  /** The root package.json name. */
  project: string;
  /** The name in deploy.ts. */
  name: string;
  /**
   * Fingerprint of the inputs (and built code) at the last apply: same inputs, same hash.
   * Missing when unknown (no room to store it, or the stored value was lost); the planner then updates.
   */
  hash?: string;
}

/**
 * The static side of every kind's class (C#: static abstract interface members). The planner needs
 * these even when nothing of a kind is declared, to find orphans. Checked by `[D1, Worker] satisfies Kind[]`.
 */
export interface Kind {
  /** Applied only when CI=true; in dev, local tools (wrangler/miniflare) provide it. */
  ciOnly: boolean;
  /**
   * For kinds that exist before danku runs and that it never creates: zones (you register the
   * domain). An untagged one with the declared cloud name is adopted (tagged) instead of refused.
   * Other kinds only ever touch what danku created.
   */
  adopt?: boolean;
  /**
   * Resources of this kind that exist in the account: every danku-owned one, across all projects,
   * with its `owner`. Kinds whose cloud names are unique also return untagged ones, without an
   * owner, so `danku deploy` can refuse to create a name that's already taken before any change.
   */
  list(): Promise<{ id: string; name: string; owner?: Owner; outputs: unknown }[]>;
  /**
   * Deletes an orphan, as list() returned it. Missing for data kinds (D1, KV, R2…): their orphans
   * are only reported, never deleted.
   */
  delete?(found: { id: string; outputs: unknown }): Promise<void>;
  /**
   * What an orphan holds that a declared resource now needs (a Worker's hostname), if anything:
   * such an orphan is deleted before any change instead of last.
   */
  holds?(found: { id: string; outputs: unknown }, declared: Resource[]): string | undefined;
}

/** Filled by constructors while danku/deploy.ts is imported; main() empties it before each run. */
export const resources: Resource[] = [];

export abstract class Resource<Inputs = unknown, Outputs = unknown> {
  readonly name: string;
  readonly inputs: Inputs;
  outputs?: Outputs;
  id?: string;

  /** Why `name` can't name a resource of this kind, or undefined when it can. */
  static invalidName(name: string): string | undefined {
    return /^[a-z0-9][a-z0-9-]*$/.test(name)
      ? undefined
      : "use lowercase letters, digits and dashes";
  }

  constructor(name: string, inputs: Inputs) {
    const problem = (this.constructor as typeof Resource).invalidName(name);
    if (problem) throw new CliError(`${this.constructor.name} "${name}": ${problem}`);
    // Two declarations with the same kind and name would fight over one cloud resource.
    if (resources.some((it) => it.constructor === this.constructor && it.name === name)) {
      throw new CliError(`${this.constructor.name} "${name}" is declared twice`);
    }
    this.name = name;
    this.inputs = inputs;
    resources.push(this);
  }

  /**
   * The name it gets at the provider, e.g. `acme-db`; renames create a new resource. Kinds named by
   * the outside world (a zone is its domain) return their name as is.
   */
  cloudName(project: string): string {
    const name = `${project}-${this.name}`;
    if (name.length > 63) {
      throw new CliError(
        `${this.constructor.name} "${this.name}": ${name} is longer than 63 characters`,
      );
    }
    return name;
  }

  /**
   * Content beyond the inputs that the hash must cover, e.g. a Worker's build output. Read before
   * any cloud call, so a missing build stops the deploy before the first change.
   */
  fingerprint?(root: string): Promise<string>;

  /**
   * Runs once every resource knows what exists in the cloud, before the first change: a last chance
   * to stop, e.g. a Worker whose domain's zone isn't active yet.
   */
  check?(): void;

  /** Where it leads once deployed, printed with its plan line: a Worker's app, a redirect's target. */
  url?(project: string): string | undefined;

  /**
   * Missing for kinds danku only adopts (zones): one that doesn't exist stops the deploy.
   * `root` is the repo root; `run` runs commands such as `wrangler deploy` (tests replace it).
   */
  create?(owner: Owner, root: string, run: Run): Promise<void>;
  abstract update(owner: Owner, root: string, run: Run): Promise<void>;
}
