import { type Owner, Resource } from "../resource.ts";
import { cloudflare, listTagged, retag, tag } from "./api.ts";

/** A Cloudflare D1 database. A data kind: never deleted, its orphans are only reported. */
export class D1 extends Resource {
  // Local dev uses wrangler's local D1.
  static ciOnly = true;

  static async list() {
    const { client, path } = cloudflare();
    const [tagged, databases] = await Promise.all([
      listTagged(),
      (async () => {
        const all: { uuid?: string; name?: string }[] = [];
        const perPage = 10_000; // Cloudflare's maximum
        for (let page = 1; ; page++) {
          const { data } = await client.d1ListDatabases({
            path,
            query: { page, per_page: perPage },
          });
          all.push(...(data.result ?? []));
          if ((data.result?.length ?? 0) < perPage) return all;
        }
      })(),
    ]);
    // D1's own list decides what exists, the tags who owns it: tags outlive their resource, so a
    // database deleted in the dashboard keeps showing up in the tag search. Database names are unique
    // per account, so untagged ones are returned too: deploy refuses to create over them.
    const owners = new Map(
      tagged.filter(({ type }) => type === "d1_database").map(({ id, owner }) => [id, owner]),
    );
    return databases.flatMap(({ uuid, name }) =>
      uuid ? [{ id: uuid, name: name ?? "", owner: owners.get(uuid), outputs: {} }] : [],
    );
  }

  constructor(name: string) {
    super(name, {});
  }

  async create(owner: Owner): Promise<void> {
    const { client, path } = cloudflare();
    const { data } = await client.d1CreateDatabase({
      path,
      body: { name: this.cloudName(owner.project) },
    });
    const id = data.result?.uuid;
    // The spec marks every response field optional; a database without an id is a Cloudflare bug.
    if (!id) throw new Error("Cloudflare created a D1 database without returning its id");
    // Set before tagging, so the planner knows the database exists even if tagging fails.
    this.id = id;
    this.outputs = {};
    await tag({ type: "d1_database", id }, owner);
  }

  // Nothing about a D1 database changes in place; only the hash in its tags.
  async update(owner: Owner): Promise<void> {
    await retag({ type: "d1_database", id: this.id! }, owner);
  }
}
