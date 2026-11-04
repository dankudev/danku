import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { acme, cleanUp, danku, deployTs, named, project, workspace } from "./project.ts";

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

/** A danku-owned D1 database as Cloudflare's tag search returns it. */
function tagged(id: string, tags: Record<string, string>) {
  return { id, type: "d1_database", name: "", tags };
}

/**
 * Replaces fetch with Cloudflare's API: `routes` maps "METHOD /path" (after the account prefix) to
 * a response body, a function of the request URL, or a Response. Returns the requests, in order.
 */
function mockCloudflare(routes: Record<string, unknown>) {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id");
  const requests: { route: string; url: URL; authorization: string | null; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    // Kubb's client always passes a Request.
    const request = input as Request;
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace("/client/v4/accounts/account-id", "")}`;
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
  // Filtered by type and by both danku tags on Cloudflare's side.
  const search = request("GET /tags/resources").url.searchParams;
  expect(search.getAll("type")).toEqual(["d1_database"]);
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
    "GET /d1/database": existing(databaseId, "old-id", "other-id"),
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
  const cases: { routes?: Record<string, unknown>; message: string }[] = [
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
  ];

  for (const { routes, message } of cases) {
    await project(acme('new D1("db");'));
    if (routes) mockCloudflare(routes);
    expect(await danku(["deploy"])).toMatchObject({ exitCode: 1, stderr: message });
  }
});
