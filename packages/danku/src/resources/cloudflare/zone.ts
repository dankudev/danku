import { CliError } from "../../error.ts";
import { type Owner, Resource } from "../resource.ts";
import { cloudflare, listTagged, retag } from "./api.ts";

/** One DNS label: lowercase letters, digits and inner dashes, at most 63 characters. */
const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A hostname inside a zone, e.g. `zone.sub("www")`; what a Worker's `domain` takes. */
export interface Subdomain {
  zone: Zone;
  hostname: string;
}

/**
 * A Cloudflare zone, shown as a domain in the dashboard: `new Zone("example.com")`. Buying a domain
 * from Cloudflare Registrar creates its zone, and you add the others by hand, so danku never creates
 * zones: it adopts the one with the declared name by tagging it, and never deletes it.
 */
export class Zone extends Resource<Record<string, never>, { status?: string }> {
  // Local dev serves the app on localhost.
  static ciOnly = true;
  static adopt = true;

  static override invalidName(name: string): string | undefined {
    const labels = name.split(".");
    return labels.length >= 2 && name.length <= 253 && labels.every((it) => label.test(it))
      ? undefined
      : "use a lowercase domain name, e.g. example.com";
  }

  static async list() {
    const { client, path } = cloudflare();
    const [tagged, zones] = await Promise.all([
      listTagged(),
      (async () => {
        const all: { id: string; name: string; status?: string }[] = [];
        const perPage = 50; // Cloudflare's maximum
        for (let page = 1; ; page++) {
          const { data } = await client.zonesGet({
            query: { "account.id": path.account_id, page, per_page: perPage },
          });
          all.push(...(data.result ?? []));
          if ((data.result?.length ?? 0) < perPage) return all;
        }
      })(),
    ]);
    // As for D1: the zone list decides what exists, the tags who owns it. A zone's name is unique
    // in an account, so untagged ones are returned too: deploy adopts the declared one.
    const owners = new Map(
      tagged.filter(({ type }) => type === "zone").map(({ id, owner }) => [id, owner]),
    );
    return zones.map(({ id, name, status }) => ({
      id,
      name,
      owner: owners.get(id),
      outputs: { status },
    }));
  }

  constructor(domain: string) {
    super(domain, {});
  }

  /** The zone's name is its domain, the same in every project. */
  override cloudName(): string {
    return this.name;
  }

  /** A hostname in this zone: `zone.sub("www")` is www.example.com. */
  sub(name: string): Subdomain {
    if (!name.split(".").every((it) => label.test(it))) {
      throw new CliError(`Zone "${this.name}": "${name}" isn't a valid subdomain`);
    }
    return { zone: this, hostname: `${name}.${this.name}` };
  }

  // Adopting and updating only write danku's tags; the zone's records and settings stay as they are.
  async update(owner: Owner): Promise<void> {
    await retag({ type: "zone", id: this.id!, zone: this.id! }, owner);
  }
}
