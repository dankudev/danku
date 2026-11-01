import { CliError } from "../../error.ts";
import { Resource } from "../resource.ts";
import type { D1 } from "./d1.ts";

/**
 * Pins the Workers runtime's behaviour for every Worker. danku sets it, so upgrading danku is how it
 * moves; keep it no later than the workerd in the newest wrangler, or local dev falls back to an
 * older date.
 */
export const compatibilityDate = "2026-10-23";

/** What deploy.ts sets on a Worker. */
export interface WorkerInputs {
  /** The app's folder, relative to the repo root, e.g. `apps/web`. */
  app: string;
  /** Added to `nodejs_compat`, which every Worker gets. */
  compatibilityFlags?: string[];
  /** Binding name → resource, e.g. `{ DB: db }`; the app reads them from `cloudflare:workers`. */
  bindings?: Record<string, D1>;
}

/**
 * A Cloudflare Worker running one app. `danku generate` writes the app's wrangler.jsonc from it;
 * deploying it comes later.
 */
export class Worker extends Resource<WorkerInputs> {
  // Local dev runs the app with Vite and wrangler's local runtime.
  static ciOnly = true;

  // Nothing to find until danku deploys Workers.
  static async list() {
    return [];
  }

  async create(): Promise<void> {
    throw new CliError(`Worker "${this.name}": deploying Workers isn't supported yet`);
  }

  async update(): Promise<void> {
    throw new CliError(`Worker "${this.name}": deploying Workers isn't supported yet`);
  }
}
