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

/** A danku-owned resource as Cloudflare's tag search returns it. */
function tagged(id: string, tags: Record<string, string>, type = "d1_database") {
  return { id, type, name: "", tags };
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

test("in dev, from inside an app, it skips CI-only kinds without a token or network", async () => {
  vi.stubEnv("CI", "");
  await project(
    {
      ...acme(
        'const web = new D1("web");\nnew Worker("web", { app: "apps/web", bindings: { DB: web } });',
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
    stdout: "· D1 web: skipped in dev\n· Worker web: skipped in dev",
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
      files: acme('new Zone("acme.dev").sub("my_app");'),
      message: () => 'Zone "acme.dev": "my_app" isn\'t a valid subdomain',
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
  ];

  for (const { routes, files = acme('new D1("db");'), message } of cases) {
    await project(files);
    const requests = routes ? mockCloudflare(routes) : [];
    expect(await danku(["deploy"], vi.fn<Run>())).toMatchObject({ exitCode: 1, stderr: message });
    // Problems found while planning stop the deploy before its first write.
    if (!message.startsWith("Cloudflare ")) expect(writes(requests)).toEqual([]);
  }
});
