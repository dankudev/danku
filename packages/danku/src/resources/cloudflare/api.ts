import { CliError } from "../../error.ts";
import type { Owner } from "../resource.ts";
import { defaultTransport } from "./generated/.kubb/client.ts";
import { CloudflareClient } from "./generated/client.ts";
import type {
  ResourceTaggingAccountResourceTypeBaseEnumKey as ResourceType,
  ResourceTaggingZoneResourceTypeBaseEnumKey as ZoneResourceType,
} from "./generated/types.ts";

/**
 * A typed Cloudflare API client, plus the `account_id` path parameter for CLOUDFLARE_ACCOUNT_ID
 * (the variable names wrangler uses). Failed calls throw a CliError with Cloudflare's reasons.
 */
export function cloudflare() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    throw new CliError(
      "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to deploy Cloudflare resources",
    );
  }
  const client = new CloudflareClient({
    baseURL: "https://api.cloudflare.com/client/v4",
    // A fixed header, not Kubb's `auth`: that follows the spec's security schemes, which list only
    // the Global API Key for the tag endpoints and would send the token in X-Auth-Email.
    headers: { Authorization: `Bearer ${token}` },
    // Kubb's own sending, with failures turned into a CliError instead of its ResponseError.
    async transport(request) {
      const result = await defaultTransport(request).catch((error: unknown) => {
        throw new CliError(`Cloudflare is unreachable: ${String(error)}`);
      });
      if (result.status >= 200 && result.status < 300) return result;
      // Cloudflare's JSON lists the reasons; gateway errors come back as HTML.
      const { errors } = (result.data ?? {}) as { errors?: { code: number; message: string }[] };
      const reasons =
        errors?.map((error) => `${error.message} (${error.code})`).join("; ") ||
        `${result.status} ${result.statusText}`;
      throw new CliError(
        `Cloudflare ${request.method} ${new URL(request.url).pathname}: ${reasons}`,
      );
    },
  });
  return { client, path: { account_id: account } };
}

type Tagged = { id: string; type: string; owner: Owner };
let pending: Promise<Tagged[]> | undefined;

/**
 * Every danku-owned resource in the account, of every type (`d1_database`, `worker`, `zone`…),
 * account- and zone-level alike, across all projects. One search serves every kind: kinds that ask while it runs share it, and it's
 * forgotten once done, so each deploy reads fresh tags.
 */
export function listTagged(): Promise<Tagged[]> {
  pending ??= (async () => {
    const { client, path } = cloudflare();
    const found: Tagged[] = [];
    let cursor: string | undefined;
    do {
      const { data } = await client.tagsList({
        path,
        // Repeated `tag` filters are ANDed: only resources that carry both danku tags.
        query: { tag: ["danku.project", "danku.name"], cursor },
      });
      for (const { id, type, tags } of data.result ?? []) {
        found.push({
          id,
          type,
          owner: {
            project: tags["danku.project"],
            name: tags["danku.name"],
            hash: tags["danku.hash"],
          },
        });
      }
      cursor = data.result_info?.cursor ?? undefined;
    } while (cursor);
    return found;
  })().finally(() => (pending = undefined));
  return pending;
}

/**
 * Where a resource's tags live: account-level resources (D1, Workers) are tagged through the
 * account, zone-level ones (the zone itself, later its DNS records) through their zone.
 */
export type Target =
  | { type: ResourceType; id: string }
  | { type: ZoneResourceType; id: string; zone: string };

/** Stores the owner as danku.* tags on a resource; `keep` holds tags to leave in place. */
export async function tag(
  target: Target,
  owner: Owner,
  keep: Record<string, string> = {},
): Promise<void> {
  const { client, path } = cloudflare();
  const tags = {
    ...keep,
    "danku.project": owner.project,
    "danku.name": owner.name,
    ...(owner.hash && { "danku.hash": owner.hash }),
  };
  if ("zone" in target) {
    await client.tagsZoneSet({
      path: { zone_id: target.zone },
      body: { resource_type: target.type, resource_id: target.id, tags },
    });
  } else {
    await client.tagsSet({
      path,
      body: { resource_type: target.type, resource_id: target.id, tags },
    });
  }
}

/**
 * Like tag(), but keeps the tags users added themselves: Cloudflare's PUT replaces the whole set.
 */
export async function retag(target: Target, owner: Owner): Promise<void> {
  const { client, path } = cloudflare();
  const { data } =
    "zone" in target
      ? await client.tagsZoneGet({
          path: { zone_id: target.zone },
          query: { resource_type: target.type, resource_id: target.id },
        })
      : await client.tagsGet({
          path,
          query: { resource_type: target.type, resource_id: target.id },
        });
  await tag(target, owner, data.result?.tags);
}
