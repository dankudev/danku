import { isIPv4, isIPv6 } from "node:net";

import { CliError } from "../../error.ts";
import { type Owner, Resource, resources } from "../resource.ts";
import { cloudflare, listTagged, listZones, retag, tag } from "./api.ts";
import { Worker } from "./worker.ts";
import { type Subdomain, Zone } from "./zone.ts";

interface Common {
  /** Where the record lives: the zone itself (`zone`) or a name in it (`zone.sub("_dmarc")`). */
  domain: Zone | Subdomain;
  /** The value: an address, a hostname, or text (TXT, written without quotes). */
  content: string;
}

/** What deploy.ts sets on a DNS record. TTL is always Cloudflare's "auto". */
export type DnsRecordInputs =
  | (Common & {
      type: "A" | "AAAA" | "CNAME";
      /**
       * Served through Cloudflare (the orange cloud) instead of pointing straight at `content`.
       * Off unless set, also when adopting a hand-made record that has it on.
       */
      proxied?: boolean;
    })
  | (Common & { type: "MX"; priority: number })
  | (Common & { type: "TXT" });

interface Outputs {
  zone: string;
  type: string;
  hostname: string;
}

/** Hostnames as DNS compares them: case-insensitive, with or without the final dot. */
const host = /^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]+$/;

/**
 * Content in one form for comparing what deploy.ts says with what Cloudflare has. Cloudflare stores
 * TXT content as quoted strings of up to 255 bytes (RFC 1035), splitting longer text (DKIM keys)
 * into several: they're joined back here.
 */
function normalize(type: string, content: string): string {
  if (type === "TXT") {
    const strings = [...content.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
    if (!strings.length) return content;
    return strings.map(([, text]) => text.replace(/\\(.)/g, "$1")).join("");
  }
  return content.toLowerCase().replace(/\.$/, "");
}

/** How a record is named in the plan and matched against the zone: type, name and content. */
function key(type: string, hostname: string, content: string): string {
  return `${type} ${hostname} ${normalize(type, content)}`;
}

/**
 * A DNS record in a zone. Its name in deploy.ts is only a label (`"spf"`): a zone can hold several
 * records of one type and name. A record you added by hand with the same type, name and content is
 * adopted; records aren't data, so ones removed from deploy.ts are deleted.
 */
export class DnsRecord extends Resource<DnsRecordInputs, Outputs> {
  // Local dev serves the app on localhost.
  static ciOnly = true;
  static adopt = true;
  /** Every record in the zones list() read, for checks across records. */
  static existing: { id: string; name: string; owner?: Owner; outputs: Outputs }[] = [];

  static async list() {
    const { client } = cloudflare();
    const [tagged, zones] = await Promise.all([listTagged(), listZones()]);
    // Only the zones that matter: the ones deploy.ts puts records in, and the ones holding
    // danku-owned records (to find orphans). Tags outlive deleted zones, hence the zone list.
    const declared = new Set(
      resources.flatMap((it) => (it instanceof DnsRecord ? [it.zone().name] : [])),
    );
    const owned = new Set(tagged.flatMap(({ type, zone }) => (type === "dns_record" ? zone : [])));
    const ids = zones
      .filter(({ id, name }) => declared.has(name) || owned.has(id))
      .map(({ id }) => id);
    const records = await Promise.all(
      ids.map(async (zone) => {
        const all: { id?: string; type?: string; name?: string; content?: string }[] = [];
        const perPage = 5000;
        for (let page = 1; ; page++) {
          const { data } = await client.dnsRecordsForAZoneListDnsRecords({
            path: { zone_id: zone },
            query: { page, per_page: perPage },
          });
          all.push(...(data.result ?? []));
          if ((data.result?.length ?? 0) < perPage)
            return all.map((record) => ({ ...record, zone }));
        }
      }),
    );
    const owners = new Map(
      tagged.filter(({ type }) => type === "dns_record").map(({ id, owner }) => [id, owner]),
    );
    DnsRecord.existing = records
      .flat()
      .flatMap(({ id, type = "", name: hostname = "", content = "", zone }) =>
        id
          ? [
              {
                id,
                name: key(type, hostname, content),
                owner: owners.get(id),
                outputs: { zone, type, hostname },
              },
            ]
          : [],
      );
    return DnsRecord.existing;
  }

  static async delete({ id, outputs }: { id: string; outputs: unknown }): Promise<void> {
    const { client } = cloudflare();
    const { zone } = outputs as Outputs;
    await client.dnsRecordsForAZoneDeleteDnsRecord({ path: { zone_id: zone, dns_record_id: id } });
  }

  constructor(name: string, inputs: DnsRecordInputs) {
    super(name, inputs);
    const label = `DnsRecord "${name}"`;
    const { type, content } = inputs;
    const problem =
      type === "A"
        ? !isIPv4(content) && "an A record's content is an IPv4 address"
        : type === "AAAA"
          ? !isIPv6(content) && "an AAAA record's content is an IPv6 address"
          : type === "CNAME" || type === "MX"
            ? !host.test(normalize(type, content)) && `a ${type} record's content is a hostname`
            : type === "TXT"
              ? !content && "a TXT record's content can't be empty"
              : `use one of the types A, AAAA, CNAME, MX, TXT`;
    if (problem) throw new CliError(`${label}: ${problem}`);
    if (
      type === "MX" &&
      !(Number.isInteger(inputs.priority) && inputs.priority >= 0 && inputs.priority <= 65535)
    ) {
      throw new CliError(`${label}: an MX record's priority is a whole number from 0 to 65535`);
    }
    // Cloudflare refuses a second identical record.
    const same = resources.find(
      (it) => it instanceof DnsRecord && it !== this && it.cloudName() === this.cloudName(),
    );
    if (same) throw new CliError(`${label} is the same record as DnsRecord "${same.name}"`);
  }

  zone(): Zone {
    const { domain } = this.inputs;
    return domain instanceof Zone ? domain : domain.zone;
  }

  hostname(): string {
    const { domain } = this.inputs;
    return domain instanceof Zone ? domain.name : domain.hostname;
  }

  /** The same for every project: the zone decides the name. */
  override cloudName(): string {
    return key(this.inputs.type, this.hostname(), this.inputs.content);
  }

  /**
   * Stops what Cloudflare would refuse halfway through a deploy: a record on a Worker's domain
   * (Cloudflare manages that one), and a CNAME sharing its name with an A, AAAA or CNAME record.
   */
  check(): void {
    const label = `DnsRecord "${this.name}"`;
    const hostname = this.hostname();
    const worker = resources.find((it) => it instanceof Worker && it.hostname() === hostname);
    if (worker) {
      throw new CliError(
        `${label}: ${hostname} is the domain of Worker "${worker.name}", and Cloudflare manages its DNS record`,
      );
    }
    const exclusive = ["A", "AAAA", "CNAME"];
    if (!exclusive.includes(this.inputs.type)) return;
    const others = [
      // Records already there (except this one), and declared ones still to be created.
      ...DnsRecord.existing
        .filter(({ id, outputs }) => outputs.hostname === hostname && id !== this.id)
        .map(({ outputs }) => outputs.type),
      ...resources.flatMap((it) =>
        it instanceof DnsRecord && it !== this && !it.id && it.hostname() === hostname
          ? [it.inputs.type]
          : [],
      ),
    ];
    const clash =
      this.inputs.type === "CNAME"
        ? others.find((type) => exclusive.includes(type))
        : others.find((type) => type === "CNAME");
    if (clash) {
      throw new CliError(
        `${label}: ${hostname} already has a${clash === "A" || clash === "AAAA" ? "n" : ""} ${clash} record, and a CNAME can't share its name with an A, AAAA or CNAME record`,
      );
    }
  }

  async create(owner: Owner): Promise<void> {
    const { client } = cloudflare();
    const zone = this.zone().id!;
    const { data } = await client.dnsRecordsForAZoneCreateDnsRecord({
      path: { zone_id: zone },
      body: this.body(),
    });
    const id = data.result?.id;
    if (!id) throw new Error("Cloudflare created a DNS record without returning its id");
    this.id = id;
    this.outputs = { zone, type: this.inputs.type, hostname: this.hostname() };
    await tag({ type: "dns_record", id, zone }, owner);
  }

  // Also adopting: a record added by hand gets exactly what deploy.ts says (priority, proxied).
  async update(owner: Owner): Promise<void> {
    const { client } = cloudflare();
    const zone = this.zone().id!;
    await client.dnsRecordsForAZoneUpdateDnsRecord({
      path: { zone_id: zone, dns_record_id: this.id! },
      body: this.body(),
    });
    await retag({ type: "dns_record", id: this.id!, zone }, owner);
  }

  private body() {
    const name = this.hostname();
    const ttl = 1; // automatic
    const inputs = this.inputs;
    switch (inputs.type) {
      case "MX":
        return { type: inputs.type, name, ttl, content: inputs.content, priority: inputs.priority };
      case "TXT":
        // One quoted string; Cloudflare splits text over 255 bytes itself.
        return {
          type: inputs.type,
          name,
          ttl,
          content: `"${inputs.content.replace(/[\\"]/g, "\\$&")}"`,
        };
      default:
        return {
          type: inputs.type,
          name,
          ttl,
          content: inputs.content,
          proxied: inputs.proxied ?? false,
        };
    }
  }
}
