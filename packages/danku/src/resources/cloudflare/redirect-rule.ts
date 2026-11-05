import { CliError } from "../../error.ts";
import { resources } from "../resource.ts";
import { DnsRecord } from "./dns-record.ts";
import { Worker } from "./worker.ts";
import { type Rule, ZoneRule } from "./zone-rule.ts";
import { type Subdomain, Zone } from "./zone.ts";

/** What deploy.ts sets on a redirect. */
export interface RedirectRuleInputs {
  /**
   * The name it redirects: a zone (`zone`, example.com) or a name in it (`zone.sub("www")`).
   * Cloudflare redirects only proxied names, so deploy.ts also needs a proxied DNS record for it.
   */
  from: Zone | Subdomain;
  /** Where visitors go: an origin such as `https://example.com`. The path and query are kept. */
  to: string;
}

/**
 * A Single Redirect: every request to one name is sent to another site, keeping its path and query
 * (www.example.com/about?x=1 → https://example.com/about?x=1), before any Worker runs.
 */
export class RedirectRule extends ZoneRule<RedirectRuleInputs> {
  static override phase = "http_request_dynamic_redirect" as const;

  /** The name it redirects, read back from the expression rule() writes. */
  static override cloudNameOf(expression: string): string {
    return /^http\.host eq "(.+)"$/.exec(expression)?.[1] ?? expression;
  }

  constructor(name: string, inputs: RedirectRuleInputs) {
    super(name, inputs);
    const label = `RedirectRule "${name}"`;
    const hostname = this.hostname();
    const to = URL.parse(inputs.to);
    if (
      !to ||
      !["http:", "https:"].includes(to.protocol) ||
      inputs.to.replace(/\/$/, "") !== to.origin
    ) {
      throw new CliError(
        `${label}: \`to\` takes a site such as https://example.com, without a path; the path and query of each request are kept`,
      );
    }
    if (to.hostname === hostname) {
      throw new CliError(`${label}: redirecting ${hostname} to itself would loop`);
    }
    // Only the first of two would ever run.
    const same = resources.find(
      (it) => it instanceof RedirectRule && it !== this && it.hostname() === hostname,
    );
    if (same) throw new CliError(`${label} redirects the same name as RedirectRule "${same.name}"`);
  }

  zone(): Zone {
    const { from } = this.inputs;
    return from instanceof Zone ? from : from.zone;
  }

  hostname(): string {
    const { from } = this.inputs;
    return from instanceof Zone ? from.name : from.hostname;
  }

  /** Where it sends visitors, printed with its plan line. */
  url(): string {
    return this.inputs.to;
  }

  /**
   * Stops a redirect that would hide a Worker, or never run: Cloudflare runs rules only on names
   * it proxies, so without a proxied record the redirect would silently do nothing.
   */
  override check(): void {
    super.check();
    const label = `RedirectRule "${this.name}"`;
    const hostname = this.hostname();
    const worker = resources.find((it) => it instanceof Worker && it.hostname() === hostname);
    if (worker) {
      throw new CliError(
        `${label}: ${hostname} is the domain of Worker "${worker.name}", which the redirect would make unreachable`,
      );
    }
    const proxied = resources.some(
      (it) =>
        it instanceof DnsRecord &&
        it.hostname() === hostname &&
        "proxied" in it.inputs &&
        it.inputs.proxied,
    );
    if (!proxied) {
      throw new CliError(
        `${label}: Cloudflare redirects only proxied names; declare one for ${hostname}, e.g. new DnsRecord("${this.name}", { domain: …, type: "AAAA", content: "100::", proxied: true })`,
      );
    }
  }

  rule(): Rule {
    const { origin } = new URL(this.inputs.to);
    return {
      expression: `http.host eq "${this.hostname()}"`,
      action: "redirect",
      action_parameters: {
        from_value: {
          target_url: { expression: `concat("${origin}", http.request.uri.path)` },
          // Permanent: browsers and search engines move to the new address.
          status_code: 301,
          preserve_query_string: true,
        },
      },
    };
  }
}
