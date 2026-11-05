import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { Run } from "../src/run.ts";
import { acme, cleanUp, copy, danku, deployTs, named, project, workspace } from "./project.ts";

const databaseId = "c3f2a1e0-0000-4000-8000-000000000001";

beforeEach(() => {
  // Explicit both ways, so the tests behave the same on a laptop and in CI.
  vi.stubEnv("CI", "true");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
});

afterEach(cleanUp);

/** A successful Cloudflare response envelope. */
function ok(result: unknown, cursor?: string) {
  return { success: true, errors: [], messages: [], result, result_info: { cursor } };
}

/** D1's own list of the databases that exist, which danku checks the tag search against. */
function existing(...ids: string[]) {
  return ok(ids.map((uuid) => ({ uuid })));
}

/** A danku-owned resource as Cloudflare's tag search returns it; zone-level ones carry their zone. */
function tagged(id: string, tags: Record<string, string>, type = "d1_database", zone?: string) {
  return { id, type, name: "", tags, ...(zone && { zone_id: zone }) };
}

/**
 * Replaces fetch with Cloudflare's API: `routes` maps "METHOD /path" (after the account prefix, or
 * `/zones…` for zone calls) to a response body, a function of the request URL, or a Response.
 * Returns the requests, in order.
 */
function mockCloudflare(overrides: Record<string, unknown>) {
  // Every CI deploy lists each kind: an empty account unless a test says otherwise.
  const routes: Record<string, unknown> = {
    "GET /tags/resources": ok([]),
    "GET /zones": ok([]),
    "GET /d1/database": ok([]),
    "GET /workers/scripts": ok([]),
    "GET /workers/domains": ok([]),
    "GET /workers/subdomain": ok({ subdomain: "acme-team" }),
    ...overrides,
  };
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id");
  const requests: { route: string; url: URL; authorization: string | null; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    // Kubb's client always passes a Request.
    const request = input as Request;
    const url = new URL(request.url);
    const path = url.pathname.replace("/client/v4", "").replace("/accounts/account-id", "");
    const route = `${request.method} ${path}`;
    requests.push({
      route,
      url,
      authorization: request.headers.get("Authorization"),
      body: request.body ? await request.json() : undefined,
    });
    if (!(route in routes)) throw new Error(`Unexpected Cloudflare call: ${route}`);
    const response = routes[route];
    if (response instanceof Response) return response;
    return Response.json(typeof response === "function" ? response(url) : response);
  });
  return requests;
}

/** The writes danku made, in order; reads run in parallel, so their order isn't fixed. */
const writes = (requests: { route: string }[]) =>
  requests.map(({ route }) => route).filter((route) => !route.startsWith("GET "));

test("a first deploy in CI creates and tags the database", async () => {
  await project({ ...workspace, ...named("@acme/acme"), ...deployTs('new D1("db");') });
  const requests = mockCloudflare({
    "GET /tags/resources": ok([]),
    // Someone else's database in the same account: never shown or touched.
    "GET /d1/database": ok([{ uuid: "notes-id", name: "notes" }]),
    "POST /d1/database": ok({ uuid: databaseId }),
    "PUT /tags": ok({}),
  });

  // The @scope/ is dropped from the project name.
  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout: "+ D1 db: create acme-db",
    stderr: "",
  });

  expect(writes(requests)).toEqual(["POST /d1/database", "PUT /tags"]);
  expect(requests.every(({ authorization }) => authorization === "Bearer token")).toBe(true);
  const request = (route: string) => requests.find((it) => it.route === route)!;
  // One tag search for every kind (D1 and Worker both list), filtered by both danku tags.
  expect(requests.filter(({ route }) => route === "GET /tags/resources")).toHaveLength(1);
  const search = request("GET /tags/resources").url.searchParams;
  expect(search.getAll("type")).toEqual([]);
  expect(search.getAll("tag")).toEqual(["danku.project", "danku.name"]);
  // D1's list in Cloudflare's largest pages.
  expect(request("GET /d1/database").url.searchParams.toString()).toBe("page=1&per_page=10000");
  expect(request("POST /d1/database").body).toEqual({ name: "acme-db" });
  expect(request("PUT /tags").body).toEqual({
    resource_type: "d1_database",
    resource_id: databaseId,
    tags: { "danku.project": "acme", "danku.name": "db", "danku.hash": expect.any(String) },
  });
});

test("a redeploy updates changed databases and reports removed ones, ignoring other projects", async () => {
  await project(acme('new D1("db");'));
  const requests = mockCloudflare({
    // Two pages, with another project's database in the same account.
    "GET /tags/resources": (url: URL) =>
      url.searchParams.get("cursor") === "page-2"
        ? ok([tagged("old-id", { "danku.project": "acme", "danku.name": "old" })])
        : ok(
            [
              tagged("other-id", { "danku.project": "other", "danku.name": "old" }),
              tagged(databaseId, {
                "danku.project": "acme",
                "danku.name": "db",
                "danku.hash": "changed",
              }),
            ],
            "page-2",
          ),
    "GET /d1/database": ok([
      { uuid: databaseId, name: "acme-db" },
      { uuid: "old-id", name: "acme-old" },
      { uuid: "other-id", name: "other-old" },
    ]),
    // A tag someone added in the dashboard.
    "GET /tags": ok({
      tags: { "danku.project": "acme", "danku.name": "db", "danku.hash": "changed", team: "data" },
    }),
    "PUT /tags": ok({}),
  });

  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout:
      "~ D1 db: update acme-db\n" +
      "! D1 old: acme-old is no longer in danku/deploy.ts; danku never deletes data, so delete it yourself once you no longer need it",
    stderr: "",
  });

  expect(writes(requests)).toEqual(["PUT /tags"]);
  const searches = requests.filter(({ route }) => route === "GET /tags/resources");
  expect(searches.map(({ url }) => url.searchParams.get("cursor"))).toEqual([null, "page-2"]);
  const read = requests.find(({ route }) => route === "GET /tags")!;
  expect(read.url.searchParams.get("resource_id")).toBe(databaseId);
  const { tags } = requests.find(({ route }) => route === "PUT /tags")!.body as {
    tags: Record<string, string>;
  };
  expect(tags).toEqual({
    team: "data",
    "danku.project": "acme",
    "danku.name": "db",
    "danku.hash": expect.stringMatching(/^[0-9a-f]{16}$/),
  });
});

test("an unchanged redeploy writes nothing", async () => {
  await project(acme('new D1("db");'));
  const first = mockCloudflare({
    "GET /tags/resources": ok([]),
    "GET /d1/database": existing(),
    "POST /d1/database": ok({ uuid: databaseId }),
    "PUT /tags": ok({}),
  });
  await danku(["deploy"]);
  const { tags } = first.find(({ route }) => route === "PUT /tags")!.body as {
    tags: Record<string, string>;
  };

  await project(acme('new D1("db");'));
  const second = mockCloudflare({
    "GET /tags/resources": ok([tagged(databaseId, tags)]),
    "GET /d1/database": existing(databaseId),
  });

  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout: "= D1 db: no changes",
    stderr: "",
  });
  expect(writes(second)).toEqual([]);
});

test("a database deleted in the dashboard is created again, though its tags linger", async () => {
  await project(acme('new D1("db");'));
  const requests = mockCloudflare({
    // Cloudflare keeps a deleted resource's tags: the search still lists both, D1 lists neither.
    "GET /tags/resources": ok([
      tagged("deleted-id", { "danku.project": "acme", "danku.name": "db", "danku.hash": "same" }),
      tagged("deleted-old-id", { "danku.project": "acme", "danku.name": "old" }),
    ]),
    "GET /d1/database": existing(),
    "POST /d1/database": ok({ uuid: databaseId }),
    "PUT /tags": ok({}),
  });

  // Nothing is reported for the deleted "old" either: it no longer exists.
  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout: "+ D1 db: create acme-db",
    stderr: "",
  });
  expect(writes(requests)).toEqual(["POST /d1/database", "PUT /tags"]);
});

const workerTag = "0f5a2b9c4d6e8f1a3b5c7d9e0f2a4b6c";
/** Where acme-web is served without a domain: the account's workers.dev subdomain. */
const workersDev = "https://acme-web.acme-team.workers.dev";
const web =
  'const db = new D1("db");\nnew Worker("web", { app: "apps/web", bindings: { DB: db } });';
/** The project with apps/web already built, as CI builds it before deploying. */
const built = (body: string) => ({
  ...acme(body),
  "apps/web/.svelte-kit/cloudflare/_worker.js": "export default {};",
  "apps/web/.svelte-kit/cloudflare/_app/start.js": "start();",
  "apps/web/.svelte-kit/cloudflare-tmp/server.js": "export const server = {};",
});

/** Stands in for `vp exec wrangler deploy`: Cloudflare lists the Worker once it has run. */
function fakeWrangler() {
  let deployed = false;
  const run = vi.fn<Run>(async () => {
    deployed = true;
  });
  const scripts = () => ok(deployed ? [{ id: "acme-web", tag: workerTag }] : []);
  return { run, scripts };
}

test("a first deploy creates the database, then uploads and tags the Worker bound to it", async () => {
  const dir = await project(built(web));
  const wrangler = fakeWrangler();
  const requests = mockCloudflare({
    "POST /d1/database": ok({ uuid: databaseId }),
    "GET /workers/scripts": wrangler.scripts,
    "PUT /tags": ok({}),
  });

  // Without a domain, the app is served on the account's workers.dev subdomain.
  expect(await danku(["deploy"], wrangler.run)).toEqual({
    exitCode: 0,
    stdout: `+ D1 db: create acme-db\n+ Worker web: create acme-web → ${workersDev}`,
    stderr: "",
  });

  expect(wrangler.run.mock.calls).toEqual([
    [
      "vp",
      ["exec", "wrangler", "deploy", "--config", "wrangler.deploy.jsonc"],
      join(dir, "apps/web"),
    ],
  ]);
  // The generated config plus the id of the database created moments before.
  const config = JSON.parse(await readFile(join(dir, "apps/web/wrangler.deploy.jsonc"), "utf8"));
  expect(config).toMatchObject({
    name: "acme-web",
    main: ".svelte-kit/cloudflare/_worker.js",
    workers_dev: true,
    preview_urls: false,
    d1_databases: [{ binding: "DB", database_name: "acme-db", database_id: databaseId }],
  });
  expect(config).not.toHaveProperty("routes");
  expect(writes(requests)).toEqual(["POST /d1/database", "PUT /tags", "PUT /tags"]);
  expect(requests.filter(({ route }) => route === "PUT /tags")[1].body).toEqual({
    resource_type: "worker",
    resource_id: workerTag,
    tags: { "danku.project": "acme", "danku.name": "web", "danku.hash": expect.any(String) },
  });
});

test("the same build skips the Worker, a new build redeploys it", async () => {
  // First deploy, to learn the hashes danku stores.
  await project(built(web));
  const first = fakeWrangler();
  const firstRequests = mockCloudflare({
    "POST /d1/database": ok({ uuid: databaseId }),
    "GET /workers/scripts": first.scripts,
    "PUT /tags": ok({}),
  });
  await danku(["deploy"], first.run);
  const [databaseTags, workerTags] = firstRequests
    .filter(({ route }) => route === "PUT /tags")
    .map(({ body }) => (body as { tags: Record<string, string> }).tags);
  const account = {
    "GET /tags/resources": ok([
      tagged(databaseId, databaseTags),
      tagged(workerTag, workerTags, "worker"),
    ]),
    "GET /d1/database": ok([{ uuid: databaseId, name: "acme-db" }]),
    "GET /workers/scripts": ok([{ id: "acme-web", tag: workerTag }]),
  };

  // Same deploy.ts, same build: nothing to do.
  const dir = await copy(process.cwd());
  let run = vi.fn<Run>();
  mockCloudflare(account);
  expect(await danku(["deploy"], run)).toEqual({
    exitCode: 0,
    stdout: `= D1 db: no changes\n= Worker web: no changes → ${workersDev}`,
    stderr: "",
  });
  expect(run).not.toHaveBeenCalled();

  // A new build, of client code or of server code only: the Worker is uploaded again and its hash
  // updated.
  for (const file of [
    ".svelte-kit/cloudflare/_app/start.js",
    ".svelte-kit/cloudflare-tmp/server.js",
  ]) {
    const changed = await copy(dir);
    await writeFile(join(changed, "apps/web", file), "// changed");
    run = vi.fn<Run>();
    const requests = mockCloudflare({
      ...account,
      "GET /tags": ok({ tags: workerTags }),
      "PUT /tags": ok({}),
    });
    expect(await danku(["deploy"], run)).toEqual({
      exitCode: 0,
      stdout: `= D1 db: no changes\n~ Worker web: update acme-web → ${workersDev}`,
      stderr: "",
    });
    expect(run).toHaveBeenCalledOnce();
    expect(writes(requests)).toEqual(["PUT /tags"]);
  }
});

const zoneId = "023e105f4ecef8ad9ca31a8372d0c353";
/** The account's zones: acme.dev, ready to serve, and one nobody declared. */
const zones = (status = "active") =>
  ok([
    { id: zoneId, name: "acme.dev", status },
    { id: "other-zone-id", name: "other.dev", status: "active" },
  ]);
const onDomain = `const zone = new Zone("acme.dev");
new Worker("web", { app: "apps/web", domain: zone.sub("app") });`;

test("a Worker on a domain adopts the zone, then is served there", async () => {
  await project(built(onDomain));
  const wrangler = fakeWrangler();
  const requests = mockCloudflare({
    "GET /zones": zones(),
    // A tag someone added to the zone in the dashboard.
    [`GET /zones/${zoneId}/tags`]: ok({ tags: { team: "web" } }),
    [`PUT /zones/${zoneId}/tags`]: ok({}),
    "GET /workers/scripts": wrangler.scripts,
    "PUT /tags": ok({}),
  });

  // The zone existed before danku (bought or added by hand): it's adopted, not refused.
  expect(await danku(["deploy"], wrangler.run)).toEqual({
    exitCode: 0,
    stdout: "~ Zone acme.dev: adopt acme.dev\n+ Worker web: create acme-web → https://app.acme.dev",
    stderr: "",
  });

  // Adopting only adds danku's tags, keeping the others; nothing else in the zone is written.
  expect(writes(requests)).toEqual([`PUT /zones/${zoneId}/tags`, "PUT /tags"]);
  const zoneTags = requests.find(({ route }) => route === `PUT /zones/${zoneId}/tags`)!.body as {
    tags: Record<string, string>;
  };
  expect(zoneTags).toEqual({
    resource_type: "zone",
    resource_id: zoneId,
    tags: {
      team: "web",
      "danku.project": "acme",
      "danku.name": "acme.dev",
      "danku.hash": expect.any(String),
    },
  });
  // Served on the domain only: Cloudflare creates its DNS record and certificate.
  const config = JSON.parse(
    await readFile(join(process.cwd(), "apps/web/wrangler.deploy.jsonc"), "utf8"),
  );
  expect(config).toMatchObject({
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: "app.acme.dev", custom_domain: true }],
  });

  // Next deploy: the zone is danku's now, and unchanged.
  await copy(process.cwd());
  const workerTags = (
    requests.find(({ route }) => route === "PUT /tags")!.body as {
      tags: Record<string, string>;
    }
  ).tags;
  const again = mockCloudflare({
    "GET /tags/resources": ok([
      tagged(zoneId, zoneTags.tags, "zone"),
      tagged(workerTag, workerTags, "worker"),
    ]),
    "GET /zones": zones(),
    "GET /workers/scripts": ok([{ id: "acme-web", tag: workerTag }]),
  });
  expect(await danku(["deploy"], vi.fn<Run>())).toEqual({
    exitCode: 0,
    stdout: "= Zone acme.dev: no changes\n= Worker web: no changes → https://app.acme.dev",
    stderr: "",
  });
  expect(writes(again)).toEqual([]);
});

test("a Worker removed from deploy.ts is deleted with its custom domain", async () => {
  await project(acme('new D1("db");'));
  const requests = mockCloudflare({
    "GET /tags/resources": ok([
      tagged(workerTag, { "danku.project": "acme", "danku.name": "old" }, "worker"),
    ]),
    "GET /workers/scripts": ok([{ id: "acme-old", tag: workerTag }]),
    "GET /workers/domains": ok([
      { id: "old-domain-id", hostname: "old.acme.dev", service: "acme-old", zone_id: zoneId },
      // Another Worker's domain: not touched.
      { id: "notes-domain-id", hostname: "notes.acme.dev", service: "notes", zone_id: zoneId },
    ]),
    "POST /d1/database": ok({ uuid: databaseId }),
    "PUT /tags": ok({}),
    "DELETE /workers/domains/old-domain-id": ok(null),
    "DELETE /workers/scripts/acme-old": ok(null),
  });

  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout: "+ D1 db: create acme-db\n- Worker old: delete acme-old",
    stderr: "",
  });
  // The domain is detached first, which removes its DNS record and certificate; last of all.
  expect(writes(requests)).toEqual([
    "POST /d1/database",
    "PUT /tags",
    "DELETE /workers/domains/old-domain-id",
    "DELETE /workers/scripts/acme-old",
  ]);
});

test("a renamed Worker keeping its domain frees it before the new one is uploaded", async () => {
  await project(built(onDomain));
  let deployed = false;
  let writtenBeforeUpload: string[] = [];
  const run = vi.fn<Run>(async () => {
    writtenBeforeUpload = writes(requests);
    deployed = true;
  });
  const requests = mockCloudflare({
    "GET /tags/resources": ok([
      tagged("site-tag", { "danku.project": "acme", "danku.name": "site" }, "worker"),
    ]),
    "GET /zones": zones(),
    [`GET /zones/${zoneId}/tags`]: ok({ tags: {} }),
    [`PUT /zones/${zoneId}/tags`]: ok({}),
    "GET /workers/scripts": () =>
      ok(deployed ? [{ id: "acme-web", tag: workerTag }] : [{ id: "acme-site", tag: "site-tag" }]),
    "GET /workers/domains": ok([
      { id: "app-domain-id", hostname: "app.acme.dev", service: "acme-site", zone_id: zoneId },
    ]),
    "DELETE /workers/domains/app-domain-id": ok(null),
    "DELETE /workers/scripts/acme-site": ok(null),
    "PUT /tags": ok({}),
  });

  expect(await danku(["deploy"], run)).toEqual({
    exitCode: 0,
    stdout:
      "~ Zone acme.dev: adopt acme.dev\n" +
      "+ Worker web: create acme-web → https://app.acme.dev\n" +
      "- Worker site: delete acme-site first, to free app.acme.dev",
    stderr: "",
  });
  expect(writtenBeforeUpload).toEqual([
    "DELETE /workers/domains/app-domain-id",
    "DELETE /workers/scripts/acme-site",
    `PUT /zones/${zoneId}/tags`,
  ]);
  expect(writes(requests).slice(3)).toEqual(["PUT /tags"]);
});

const mail = `const zone = new Zone("acme.dev");
new DnsRecord("mail", { domain: zone, type: "MX", content: "smtp.google.com", priority: 1 });
new DnsRecord("spf", { domain: zone, type: "TXT", content: "v=spf1 include:_spf.google.com ~all" });
new DnsRecord("dmarc", { domain: zone.sub("_dmarc"), type: "TXT", content: "v=DMARC1; p=quarantine" });`;
const records = `/zones/${zoneId}/dns_records`;
/** Records already in acme.dev, added by hand; Cloudflare returns TXT content quoted. */
const handMade = [
  { id: "spf-id", type: "TXT", name: "acme.dev", content: '"v=spf1 include:_spf.google.com ~all"' },
  { id: "dmarc-none-id", type: "TXT", name: "_dmarc.acme.dev", content: '"v=DMARC1; p=none"' },
  { id: "www-id", type: "AAAA", name: "www.acme.dev", content: "100::" },
];

test("DNS records are created, identical hand-made ones adopted, and others left alone", async () => {
  await project(acme(mail));
  let created = 0;
  const requests = mockCloudflare({
    "GET /zones": zones(),
    [`GET /zones/${zoneId}/tags`]: ok({ tags: {} }),
    [`PUT /zones/${zoneId}/tags`]: ok({}),
    [`GET ${records}`]: ok(handMade),
    [`POST ${records}`]: () => ok({ id: `new-${++created}` }),
    [`PUT ${records}/spf-id`]: ok({ id: "spf-id" }),
  });

  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout:
      "~ Zone acme.dev: adopt acme.dev\n" +
      "+ DnsRecord mail: create MX acme.dev smtp.google.com\n" +
      "~ DnsRecord spf: adopt TXT acme.dev v=spf1 include:_spf.google.com ~all\n" +
      "+ DnsRecord dmarc: create TXT _dmarc.acme.dev v=DMARC1; p=quarantine",
    stderr: "",
  });

  // Each record is written, then tagged through its zone; the other two hand-made records aren't
  // touched, and only the zone deploy.ts uses is read.
  const tags = `PUT /zones/${zoneId}/tags`;
  expect(writes(requests)).toEqual([
    tags,
    `POST ${records}`,
    tags,
    `PUT ${records}/spf-id`,
    tags,
    `POST ${records}`,
    tags,
  ]);
  const listed = requests.filter(
    ({ route }) => route.endsWith("/dns_records") && route.startsWith("GET"),
  );
  expect(listed.map(({ url }) => url.searchParams.toString())).toEqual(["page=1&per_page=5000"]);
  const bodies = (route: string) =>
    requests.filter((it) => it.route === route).map(({ body }) => body);
  expect(bodies(`POST ${records}`)).toEqual([
    { type: "MX", name: "acme.dev", ttl: 1, content: "smtp.google.com", priority: 1 },
    { type: "TXT", name: "_dmarc.acme.dev", ttl: 1, content: '"v=DMARC1; p=quarantine"' },
  ]);
  expect(bodies(`PUT ${records}/spf-id`)).toEqual([
    { type: "TXT", name: "acme.dev", ttl: 1, content: '"v=spf1 include:_spf.google.com ~all"' },
  ]);
  const tagBodies = bodies(tags) as {
    resource_type: string;
    resource_id: string;
    tags: Record<string, string>;
  }[];
  expect(
    tagBodies.map(({ resource_type, resource_id, tags }) => [
      resource_type,
      resource_id,
      tags["danku.name"],
    ]),
  ).toEqual([
    ["zone", zoneId, "acme.dev"],
    ["dns_record", "new-1", "mail"],
    ["dns_record", "spf-id", "spf"],
    ["dns_record", "new-2", "dmarc"],
  ]);

  // Next deploy: all of it is danku's and unchanged.
  const tagsOf = (id: string) => tagBodies.find(({ resource_id }) => resource_id === id)!.tags;
  const owned = [
    tagged(zoneId, tagsOf(zoneId), "zone", zoneId),
    ...["new-1", "spf-id", "new-2"].map((id) => tagged(id, tagsOf(id), "dns_record", zoneId)),
  ];
  const account = {
    "GET /tags/resources": ok(owned),
    "GET /zones": zones(),
    [`GET ${records}`]: ok([
      ...handMade,
      { id: "new-1", type: "MX", name: "acme.dev", content: "smtp.google.com", priority: 1 },
      { id: "new-2", type: "TXT", name: "_dmarc.acme.dev", content: '"v=DMARC1; p=quarantine"' },
    ]),
  };
  await project(acme(mail));
  const again = mockCloudflare(account);
  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout:
      "= Zone acme.dev: no changes\n= DnsRecord mail: no changes\n= DnsRecord spf: no changes\n= DnsRecord dmarc: no changes",
    stderr: "",
  });
  expect(writes(again)).toEqual([]);

  // Then: a changed priority updates its record in place, a new label for the same record keeps
  // it, and records removed from deploy.ts are deleted, also in a zone deploy.ts no longer uses.
  await project(
    acme(`const zone = new Zone("acme.dev");
new DnsRecord("mail", { domain: zone, type: "MX", content: "smtp.google.com", priority: 5 });
new DnsRecord("spf-google", { domain: zone, type: "TXT", content: "v=spf1 include:_spf.google.com ~all" });`),
  );
  const otherRecords = "/zones/other-zone-id/dns_records";
  const changed = mockCloudflare({
    ...account,
    "GET /tags/resources": ok([
      ...owned,
      tagged(
        "old-id",
        { "danku.project": "acme", "danku.name": "old" },
        "dns_record",
        "other-zone-id",
      ),
    ]),
    [`GET ${otherRecords}`]: ok([
      { id: "old-id", type: "CNAME", name: "old.other.dev", content: "acme.dev" },
    ]),
    [`GET /zones/${zoneId}/tags`]: ok({ tags: {} }),
    [`PUT /zones/${zoneId}/tags`]: ok({}),
    [`PUT ${records}/new-1`]: ok({ id: "new-1" }),
    [`PUT ${records}/spf-id`]: ok({ id: "spf-id" }),
    [`DELETE ${records}/new-2`]: ok({ id: "new-2" }),
    [`DELETE ${otherRecords}/old-id`]: ok({ id: "old-id" }),
  });
  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout:
      "= Zone acme.dev: no changes\n" +
      "~ DnsRecord mail: update MX acme.dev smtp.google.com\n" +
      "~ DnsRecord spf-google: adopt TXT acme.dev v=spf1 include:_spf.google.com ~all\n" +
      "- DnsRecord dmarc: delete TXT _dmarc.acme.dev v=DMARC1; p=quarantine\n" +
      "- DnsRecord old: delete CNAME old.other.dev acme.dev",
    stderr: "",
  });
  expect(writes(changed)).toEqual([
    `PUT ${records}/new-1`,
    tags,
    `PUT ${records}/spf-id`,
    tags,
    `DELETE ${records}/new-2`,
    `DELETE ${otherRecords}/old-id`,
  ]);
  expect(changed.find(({ route }) => route === `PUT ${records}/new-1`)!.body).toMatchObject({
    priority: 5,
  });
  const relabelled = changed.filter(({ route }) => route === tags)[1].body as {
    tags: Record<string, string>;
  };
  expect(relabelled.tags["danku.name"]).toBe("spf-google");
});

test("long record content is cut short in the plan", async () => {
  const key = `v=DKIM1; k=rsa; p=${"A".repeat(400)}`;
  await project(
    acme(
      `new DnsRecord("dkim", { domain: new Zone("acme.dev").sub("google._domainkey"), type: "TXT", content: "${key}" });`,
    ),
  );
  const requests = mockCloudflare({
    "GET /zones": zones(),
    [`GET /zones/${zoneId}/tags`]: ok({ tags: {} }),
    [`PUT /zones/${zoneId}/tags`]: ok({}),
    // Cloudflare split an identical hand-made record into 255-byte strings: still the same record.
    [`GET ${records}`]: ok([
      {
        id: "dkim-id",
        type: "TXT",
        name: "google._domainkey.acme.dev",
        content: `"${key.slice(0, 255)}" "${key.slice(255)}"`,
      },
    ]),
    [`PUT ${records}/dkim-id`]: ok({ id: "dkim-id" }),
  });

  const { stdout } = await danku(["deploy"]);
  const line = stdout.split("\n")[1];
  expect(line).toBe(
    `~ DnsRecord dkim: adopt ${`TXT google._domainkey.acme.dev ${key}`.slice(0, 79)}…`,
  );
  expect(writes(requests)).toContain(`PUT ${records}/dkim-id`);
});

test("in dev, from inside an app, it skips CI-only kinds without a token or network", async () => {
  vi.stubEnv("CI", "");
  await project(
    {
      ...acme(
        'const web = new D1("web");\nnew Worker("web", { app: "apps/web", bindings: { DB: web } });\n' +
          'new DnsRecord("spf", { domain: new Zone("acme.dev"), type: "TXT", content: "v=spf1 -all" });',
      ),
      // Only the root's deploy.ts counts.
      "apps/web/danku/deploy.ts": 'throw new Error("not the root deploy.ts");',
    },
    "apps/web",
  );
  const fetch = vi.spyOn(globalThis, "fetch");

  // A D1 and a Worker may share a name.
  expect(await danku(["deploy"])).toEqual({
    exitCode: 0,
    stdout:
      "· D1 web: skipped in dev\n· Worker web: skipped in dev\n· Zone acme.dev: skipped in dev\n· DnsRecord spf: skipped in dev",
    stderr: "",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("a broken setup stops before calling Cloudflare", async () => {
  const cases: {
    files: Record<string, string>;
    argv?: string[];
    message: (dir: string) => string;
  }[] = [
    {
      files: {},
      message: () =>
        "danku must run inside a pnpm workspace (no pnpm-workspace.yaml in this folder or any folder above it)",
    },
    {
      files: workspace,
      message: (dir) =>
        `${join(dir, "danku", "deploy.ts")} was not found; it belongs at the repo root`,
    },
    ...[undefined, "My_App"].map((name) => ({
      files: { ...workspace, ...named(name), ...deployTs('new D1("db");') },
      message: (dir: string) =>
        `${join(dir, "package.json")}: "name" is the project name; use lowercase letters, digits and dashes`,
    })),
    { files: acme(""), message: () => "danku/deploy.ts declares no resources" },
    {
      files: acme('new D1("Db");'),
      message: () => 'D1 "Db": use lowercase letters, digits and dashes',
    },
    {
      files: acme('new D1("db");\nnew D1("db");'),
      message: () => 'D1 "db" is declared twice',
    },
    {
      files: acme(`new D1("${"x".repeat(59)}");`),
      message: () => `D1 "${"x".repeat(59)}": acme-${"x".repeat(59)} is longer than 63 characters`,
    },
    ...["Acme.dev", "acme", "acme_dev.com", "-acme.dev"].map((domain) => ({
      files: acme(`new Zone("${domain}");`),
      message: () => `Zone "${domain}": use a lowercase domain name, e.g. example.com`,
    })),
    {
      files: acme('new Zone("acme.dev").sub("my app");'),
      message: () => 'Zone "acme.dev": "my app" isn\'t a valid subdomain',
    },
    {
      // Underscores are for DNS names like _dmarc, not for websites.
      files: acme(
        'new Worker("web", { app: "apps/web", domain: new Zone("acme.dev").sub("my_app") });',
      ),
      message: () =>
        'Worker "web": my_app.acme.dev can\'t serve a Worker; hostnames use letters, digits and dashes',
    },
    ...[
      ['type: "A", content: "acme.dev"', "an A record's content is an IPv4 address"],
      ['type: "AAAA", content: "192.0.2.1"', "an AAAA record's content is an IPv6 address"],
      ['type: "CNAME", content: "https://acme.dev"', "a CNAME record's content is a hostname"],
      [
        'type: "MX", content: "mx.acme.dev", priority: 1.5',
        "an MX record's priority is a whole number from 0 to 65535",
      ],
      ['type: "TXT", content: ""', "a TXT record's content can't be empty"],
      ['type: "SRV", content: "x"', "use one of the types A, AAAA, CNAME, MX, TXT"],
    ].map(([inputs, problem]) => ({
      files: acme(`new DnsRecord("x", { domain: new Zone("acme.dev"), ${inputs} });`),
      message: () => `DnsRecord "x": ${problem}`,
    })),
    {
      // Cloudflare refuses a second identical record; differing labels don't make it a new one.
      files: acme(`const zone = new Zone("acme.dev");
new DnsRecord("a", { domain: zone, type: "CNAME", content: "Target.acme.dev." });
new DnsRecord("b", { domain: zone, type: "CNAME", content: "target.acme.dev" });`),
      message: () => 'DnsRecord "b" is the same record as DnsRecord "a"',
    },
    {
      files: acme(web),
      message: () =>
        'Worker "web": apps/web/.svelte-kit/cloudflare was not found; build the app before deploying',
    },
    {
      files: acme('new D1("db");'),
      argv: ["deploy", "extra"],
      message: () =>
        "error: too many arguments for 'deploy'. Expected 0 arguments but got 1: extra.",
    },
  ];
  const fetch = vi.spyOn(globalThis, "fetch");

  for (const { files, argv = ["deploy"], message } of cases) {
    const dir = await project(files);
    expect(await danku(argv)).toEqual({ exitCode: 1, stdout: "", stderr: message(dir) });
  }
  expect(fetch).not.toHaveBeenCalled();
});

test("Cloudflare's problems are reported in one line", async () => {
  const cases: {
    routes?: Record<string, unknown>;
    files?: Record<string, string>;
    message: string;
  }[] = [
    {
      message: "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to deploy Cloudflare resources",
    },
    {
      routes: {
        "GET /tags/resources": ok([]),
        "GET /d1/database": existing(),
        "POST /d1/database": Response.json(
          {
            success: false,
            errors: [{ code: 7502, message: "A database with that name already exists" }],
          },
          { status: 400 },
        ),
      },
      message:
        "Cloudflare POST /client/v4/accounts/account-id/d1/database: A database with that name already exists (7502)",
    },
    {
      routes: {
        "GET /tags/resources": ok([]),
        "GET /d1/database": existing(),
        "POST /d1/database": new Response("<html>Bad gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
        }),
      },
      message: "Cloudflare POST /client/v4/accounts/account-id/d1/database: 502 Bad Gateway",
    },
    {
      routes: {
        "GET /tags/resources": ok([
          tagged("id-1", { "danku.project": "acme", "danku.name": "db" }),
          tagged("id-2", { "danku.project": "acme", "danku.name": "db" }),
        ]),
        "GET /d1/database": existing("id-1", "id-2"),
      },
      message: 'D1 "db" exists 2 times in the cloud; delete the extra copies',
    },
    {
      routes: {
        // The name danku would create is taken by a database another danku project owns.
        "GET /tags/resources": ok([
          tagged("other-id", { "danku.project": "other", "danku.name": "x" }),
        ]),
        "GET /d1/database": ok([{ uuid: "other-id", name: "acme-db" }]),
      },
      message: 'D1 "db": acme-db already exists, and belongs to the danku project "other"',
    },
    {
      routes: {
        // acme-db exists, but without danku's tags: danku didn't create it, so it isn't touched.
        "GET /tags/resources": ok([]),
        "GET /d1/database": ok([
          { uuid: "notes-id", name: "notes" },
          { uuid: databaseId, name: "acme-db" },
        ]),
      },
      message: `D1 "db": acme-db already exists, but danku didn't create it (it has no danku tags); remove it or rename the resource in danku/deploy.ts`,
    },
    {
      // danku adopts zones but never creates them.
      files: built(onDomain),
      routes: { "GET /zones": ok([{ id: "other-zone-id", name: "other.dev", status: "active" }]) },
      message:
        'Zone "acme.dev": acme.dev was not found; danku adopts a Zone but never creates one, so add it first',
    },
    {
      // Added to Cloudflare, but the registrar's nameservers don't point there yet.
      files: built(onDomain),
      routes: { "GET /zones": zones("pending") },
      message:
        "Worker \"web\": the domain acme.dev isn't active in Cloudflare yet (it's pending); finish adding it in the dashboard, then deploy again",
    },
    {
      // Adopting is only for untagged zones: another project's stays theirs.
      files: built(onDomain),
      routes: {
        "GET /tags/resources": ok([
          tagged(zoneId, { "danku.project": "other", "danku.name": "acme.dev" }, "zone"),
        ]),
        "GET /zones": zones(),
      },
      message: 'Zone "acme.dev": acme.dev already exists, and belongs to the danku project "other"',
    },
    {
      // Cloudflare would refuse it after earlier changes were made: it stops the plan instead.
      files: acme(`const zone = new Zone("acme.dev");
new DnsRecord("www", { domain: zone.sub("www"), type: "CNAME", content: "acme.pages.dev" });`),
      routes: {
        "GET /zones": zones(),
        [`GET /zones/${zoneId}/dns_records`]: ok([
          { id: "www-id", type: "AAAA", name: "www.acme.dev", content: "100::" },
        ]),
      },
      message:
        'DnsRecord "www": www.acme.dev already has an AAAA record, and a CNAME can\'t share its name with an A, AAAA or CNAME record',
    },
    {
      files: built(`${onDomain}
new DnsRecord("app", { domain: zone.sub("app"), type: "A", content: "192.0.2.1" });`),
      routes: { "GET /zones": zones(), [`GET /zones/${zoneId}/dns_records`]: ok([]) },
      message:
        'DnsRecord "app": app.acme.dev is the domain of Worker "web", and Cloudflare manages its DNS record',
    },
    {
      // The same record, owned by another danku project: never adopted.
      files: acme(
        `new DnsRecord("spf", { domain: new Zone("acme.dev"), type: "TXT", content: "v=spf1 -all" });`,
      ),
      routes: {
        "GET /tags/resources": ok([
          tagged("spf-id", { "danku.project": "other", "danku.name": "spf" }, "dns_record", zoneId),
        ]),
        "GET /zones": zones(),
        [`GET /zones/${zoneId}/dns_records`]: ok([
          { id: "spf-id", type: "TXT", name: "acme.dev", content: '"v=spf1 -all"' },
        ]),
      },
      message:
        'DnsRecord "spf": TXT acme.dev v=spf1 -all already exists, and belongs to the danku project "other"',
    },
  ];

  for (const { routes, files = acme('new D1("db");'), message } of cases) {
    await project(files);
    const requests = routes ? mockCloudflare(routes) : [];
    expect(await danku(["deploy"], vi.fn<Run>())).toMatchObject({ exitCode: 1, stderr: message });
    // Problems found while planning stop the deploy before its first write.
    if (!message.startsWith("Cloudflare ")) expect(writes(requests)).toEqual([]);
  }
});
