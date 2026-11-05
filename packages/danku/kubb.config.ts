import { parserTs } from "@kubb/parser-ts";
import { pluginFetch } from "@kubb/plugin-fetch";
import { pluginTs } from "@kubb/plugin-ts";
import { defineConfig } from "kubb/config";

// Kubb sends anonymous usage data unless this is set; it reads it when it would send.
process.env.KUBB_DISABLE_TELEMETRY = "1";

const include = [
  "createZoneRuleset",
  "createZoneRulesetRule",
  "d1-create-database",
  "d1-list-databases",
  "deleteZoneRulesetRule",
  "dns-records-for-a-zone-create-dns-record",
  "dns-records-for-a-zone-delete-dns-record",
  "dns-records-for-a-zone-list-dns-records",
  "dns-records-for-a-zone-update-dns-record",
  "getZoneRuleset",
  "listZoneRulesets",
  "tags-get",
  "tags-set",
  "tags-list",
  "tags-zone-get",
  "tags-zone-set",
  "updateZoneRulesetRule",
  "worker-script-delete-worker",
  "worker-script-list-workers",
  "worker-subdomain-get-subdomain",
  "workers.domains.delete",
  "workers.domains.list",
  "zones-get",
].map((id) => ({
  type: "operationId" as const,
  pattern: new RegExp(`^${id}$`),
}));

/**
 * Generates src/resources/cloudflare/generated: a typed CloudflareClient for only the endpoints
 * danku calls (Cloudflare's spec has 2,300+). After adding one to `include`: vp run openapi
 */
// Typed via defineConfig: `declaration` in tsconfig.json needs a type it can name, and Kubb's lives
// in an internal package.
const config: ReturnType<typeof defineConfig> = defineConfig({
  input: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
  output: {
    path: "src/resources/cloudflare/generated",
    clean: true,
    // Generated code is never formatted or linted (vite.config.ts ignores the folder too).
    format: false,
    lint: false,
  },
  // Relative imports need their .ts extension under the package's `nodenext` resolution.
  parsers: [parserTs({ extension: { ".ts": ".ts" } })],
  plugins: [
    pluginTs({ output: { path: "types.ts" }, include }),
    // The base URL is passed to the client in api.ts.
    pluginFetch({
      output: { path: "client.ts" },
      sdk: { mode: "flat", name: "CloudflareClient" },
      include,
    }),
  ],
});

export default config;
