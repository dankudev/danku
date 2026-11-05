import { CliError } from "../../error.ts";
import { type Owner, Resource, resources } from "../resource.ts";
import { cloudflare, listTagged, listZones } from "./api.ts";
import type {
  CreateZoneRulesetBody,
  RulesetsRequestRule,
  RulesetsRulesetPhaseKey,
} from "./generated/types.ts";
import type { Zone } from "./zone.ts";

/**
 * A rule as danku writes it. Cloudflare's spec lists the fields Cloudflare sets itself (`id`,
 * `version`, `last_updated`) as required, so the generated request types demand them too: body()
 * and the new ruleset are cast instead.
 */
export type Rule = Partial<RulesetsRequestRule>;

interface Outputs {
  zone: string;
  ruleset: string;
}

/**
 * One rule in a zone's ruleset for a phase: Single Redirects, WAF custom rules, rate limiting…
 * Cloudflare runs one such ruleset per zone and phase, shared with the rules added in the dashboard,
 * so danku owns single rules in it, never the ruleset. Each feature is a subclass that sets its
 * phase and turns its inputs into the rule. Rules aren't data: ones removed from deploy.ts are deleted.
 */
export abstract class ZoneRule<Inputs> extends Resource<Inputs, Outputs> {
  // Local dev serves the app on localhost.
  static ciOnly = true;
  /** The phase whose ruleset holds this kind's rules, e.g. `http_request_dynamic_redirect`. */
  static phase: RulesetsRulesetPhaseKey;
  /**
   * Zone id → its ruleset for this kind's phase, as list() found it: a new rule joins it, and
   * the first rule in a zone records the ruleset it created, for the next one.
   */
  static rulesets = new Map<string, string>();

  static async list(this: typeof ZoneRule) {
    const { client } = cloudflare();
    // Set on this kind, not ZoneRule: each phase has its own rulesets.
    const rulesets = (this.rulesets = new Map());
    const [tagged, zones] = await Promise.all([listTagged(), listZones()]);
    // The zones this kind's rules are declared in, plus every danku-owned zone: one danku adopted
    // to put a rule in stays tagged, so a rule removed from deploy.ts is still found.
    const declared = new Set(
      resources.flatMap((it) => (it instanceof this ? [it.zone().name] : [])),
    );
    const owned = new Set(tagged.flatMap(({ type, id }) => (type === "zone" ? id : [])));
    const ids = zones
      .filter(({ id, name }) => declared.has(name) || owned.has(id))
      .map(({ id }) => id);
    const found = await Promise.all(
      ids.map(async (zone) => {
        let ruleset: string | undefined;
        let cursor: string | undefined;
        do {
          const { data } = await client.listZoneRulesets({
            path: { zone_id: zone },
            query: { cursor, per_page: 50 },
          });
          ruleset ??= data.result?.find(
            ({ kind, phase }) => kind === "zone" && phase === this.phase,
          )?.id;
          cursor = data.result_info?.cursors?.after;
        } while (cursor && !ruleset);
        if (!ruleset) return [];
        rulesets.set(zone, ruleset);
        const { data } = await client.getZoneRuleset({
          path: { zone_id: zone, ruleset_id: ruleset },
        });
        // Rules danku didn't create are returned too, without an owner: a declared rule with the
        // same cloud name (a second redirect for one name, which would never run) stops the deploy.
        return (data.result?.rules ?? []).flatMap(({ id, ref, description, expression }) => {
          if (!id) return [];
          const [marker, project, name] = ref?.split(":") ?? [];
          const owner =
            marker === "danku" && project && name
              ? { project, name, hash: description?.match(/ ([0-9a-f]{16})$/)?.[1] }
              : undefined;
          return [
            { id, name: this.cloudNameOf(expression ?? ""), owner, outputs: { zone, ruleset } },
          ];
        });
      }),
    );
    return found.flat();
  }

  static async delete({ id, outputs }: { id: string; outputs: unknown }): Promise<void> {
    const { client } = cloudflare();
    const { zone, ruleset } = outputs as Outputs;
    await client.deleteZoneRulesetRule({
      path: { zone_id: zone, ruleset_id: ruleset, rule_id: id },
    });
  }

  /** The cloud name of a rule found with this expression; the same as cloudName() for its rule. */
  static cloudNameOf(expression: string): string {
    return expression;
  }

  abstract zone(): Zone;

  /** The rule as Cloudflare takes it, without the `ref` and `description` danku adds. */
  abstract rule(): Rule;

  /** The same for every project: the rule's expression decides it. */
  override cloudName(): string {
    return (this.constructor as typeof ZoneRule).cloudNameOf(this.rule().expression ?? "");
  }

  /** Rules run only on active zones; pending ones wait for nameservers. */
  check(): void {
    const zone = this.zone();
    const status = zone.outputs?.status;
    if (status !== "active") {
      throw new CliError(
        `${this.constructor.name} "${this.name}": the domain ${zone.name} isn't active in Cloudflare yet (it's ${status}); finish adding it in the dashboard, then deploy again`,
      );
    }
  }

  async create(owner: Owner): Promise<void> {
    const { client } = cloudflare();
    const { phase, rulesets } = this.constructor as typeof ZoneRule;
    const zone = this.zone().id!;
    const rule = this.body(owner);
    const existing = rulesets.get(zone);
    // Adding a rule keeps the others; a zone without rules in this phase has no ruleset yet.
    const { data } = existing
      ? await client.createZoneRulesetRule({
          path: { zone_id: zone, ruleset_id: existing },
          body: rule,
        })
      : await client.createZoneRuleset({
          path: { zone_id: zone },
          body: { name: "default", kind: "zone", phase, rules: [rule] } as CreateZoneRulesetBody,
        });
    // Both answer with the whole ruleset.
    const ruleset = data.result?.id;
    const id = data.result?.rules?.find((it) => it.ref === rule.ref)?.id;
    if (!ruleset || !id) throw new Error("Cloudflare added a rule without returning its id");
    rulesets.set(zone, ruleset);
    this.id = id;
    this.outputs = { zone, ruleset };
  }

  async update(owner: Owner): Promise<void> {
    const { client } = cloudflare();
    const { zone, ruleset } = this.outputs!;
    await client.updateZoneRulesetRule({
      path: { zone_id: zone, ruleset_id: ruleset, rule_id: this.id! },
      body: this.body(owner),
    });
  }

  /**
   * The rule with danku's marks, since rules can't be tagged: the owner in `ref`
   * (`danku:<project>:<name>`), which the dashboard doesn't show, and the hash
   * in `description` (the rule's name there; renaming it only costs one extra update).
   */
  private body(owner: Owner): RulesetsRequestRule {
    return {
      ...this.rule(),
      ref: `danku:${owner.project}:${owner.name}`,
      description: `danku ${owner.project}/${owner.name} ${owner.hash}`,
    } as RulesetsRequestRule;
  }
}
