import { CliError } from "../error.ts";

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
  /** Every danku-owned resource of this kind in the account, across all projects. */
  list(): Promise<{ id: string; owner: Owner; outputs: unknown }[]>;
  /** Missing for data kinds (D1, KV, R2…): their orphans are only reported, never deleted. */
  delete?(id: string): Promise<void>;
}

/**
 * The name a resource gets at the provider, e.g. `acme-db`; renames create a new resource. Used by
 * kinds when creating, and by `danku deploy` for the plan, the length check and orphan reports.
 */
export function cloudName(owner: Owner): string {
  return `${owner.project}-${owner.name}`;
}

/** Filled by constructors while danku/deploy.ts is imported; main() empties it before each run. */
export const resources: Resource[] = [];

export abstract class Resource<Inputs = unknown, Outputs = unknown> {
  readonly name: string;
  readonly inputs: Inputs;
  outputs?: Outputs;
  id?: string;

  constructor(name: string, inputs: Inputs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new CliError(
        `${this.constructor.name} "${name}": use lowercase letters, digits and dashes`,
      );
    }
    // Two declarations with the same kind and name would fight over one cloud resource.
    if (resources.some((it) => it.constructor === this.constructor && it.name === name)) {
      throw new CliError(`${this.constructor.name} "${name}" is declared twice`);
    }
    this.name = name;
    this.inputs = inputs;
    resources.push(this);
  }

  abstract create(owner: Owner): Promise<void>;
  abstract update(owner: Owner): Promise<void>;
}
