import { cloudName, type Owner, Resource } from "../resource.ts";
import { cloudflare, listTagged, retag, tag } from "./api.ts";

/** A Cloudflare D1 database. A data kind: never deleted, its orphans are only reported. */
export class D1 extends Resource {
  // Local dev uses wrangler's local D1.
  static ciOnly = true;

  static async list() {
    return (await listTagged("d1_database")).map((found) => ({ ...found, outputs: {} }));
  }

  constructor(name: string) {
    super(name, {});
  }

  async create(owner: Owner): Promise<void> {
    const { client, path } = cloudflare();
    const { data } = await client.d1CreateDatabase({ path, body: { name: cloudName(owner) } });
    const id = data.result?.uuid;
    // The spec marks every response field optional; a database without an id is a Cloudflare bug.
    if (!id) throw new Error("Cloudflare created a D1 database without returning its id");
    // Set before tagging, so the planner knows the database exists even if tagging fails.
    this.id = id;
    this.outputs = {};
    await tag("d1_database", id, owner);
  }

  // Nothing about a D1 database changes in place; only the hash in its tags.
  async update(owner: Owner): Promise<void> {
    await retag("d1_database", this.id!, owner);
  }
}
