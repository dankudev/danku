import { CliError } from "../../error.ts";
import type { Owner } from "../resource.ts";
import { defaultTransport } from "./generated/.kubb/client.ts";
import { CloudflareClient } from "./generated/client.ts";
import type { ResourceTaggingAccountResourceTypeBaseEnumKey as ResourceType } from "./generated/types.ts";

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

/** Every danku-owned resource of one type (e.g. `d1_database`), across all projects. */
export async function listTagged(type: ResourceType): Promise<{ id: string; owner: Owner }[]> {
  const { client, path } = cloudflare();
  const found: { id: string; owner: Owner }[] = [];
  let cursor: string | undefined;
  do {
    const { data } = await client.tagsList({
      path,
      // Repeated `tag` filters are ANDed: only resources that carry both danku tags.
      query: { type: [type], tag: ["danku.project", "danku.name"], cursor },
    });
    for (const { id, tags } of data.result ?? []) {
      found.push({
        id,
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
}

/** Stores the owner as danku.* tags on a resource; `keep` holds tags to leave in place. */
export async function tag(
  type: ResourceType,
  id: string,
  owner: Owner,
  keep: Record<string, string> = {},
): Promise<void> {
  const { client, path } = cloudflare();
  await client.tagsSet({
    path,
    body: {
      resource_type: type,
      resource_id: id,
      tags: {
        ...keep,
        "danku.project": owner.project,
        "danku.name": owner.name,
        ...(owner.hash && { "danku.hash": owner.hash }),
      },
    },
  });
}

/**
 * Like tag(), but keeps the tags users added themselves: Cloudflare's PUT replaces the whole set.
 * Only for resources found by listTagged(), since Cloudflare answers 500 for never-tagged ones.
 */
export async function retag(type: ResourceType, id: string, owner: Owner): Promise<void> {
  const { client, path } = cloudflare();
  const { data } = await client.tagsGet({
    path,
    query: { resource_type: type, resource_id: id },
  });
  await tag(type, id, owner, data.result?.tags);
}
