import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { buildProgram } from "./consumer-flow.index.ts";
import { consumerFlowReader } from "./consumer-flow.adapter.ts";
import { createRequestOriginReader } from "./request-origins.adapter.ts";
import { createRequestCallLookup } from "./http-call-sites.adapter.ts";
import type { FrameworkPlugin } from "../../ports/framework-plugin.port.ts";
import type { ConsumerReading, ConsumerContribution, ContinuationClaim } from "../../ports/consumer-contribution.port.ts";
import type { Carrier, FlowFrontier, FlowResult } from "../../domain/contracts/consumer-flow.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { siteFile, siteLine } from "../../domain/contracts/consumer-flow.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { CAPABILITY_ABSENT } from "../../domain/shared/fact.ts";
import { manifestsOf, projectOf } from "./angular-projects.ts";

export class TypeScriptReading implements ConsumerReading {
  readonly language = "typescript" as const;
  readonly #program: ReturnType<typeof buildProgram>;
  constructor(program: ReturnType<typeof buildProgram>, readonly files: readonly SourceFile[]) { this.#program = program; }
  program(): ReturnType<typeof buildProgram> { return this.#program; }
}

const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));

function contributions(carrier: Carrier, base: FlowResult, stages: readonly ConsumerContribution[]): FlowResult {
  const results = stages.flatMap((stage) => { const result = stage.follow(carrier); return result === undefined ? [] : [result]; });
  const groups = new Map<string, ContinuationClaim[]>();
  for (const claim of results.flatMap((result) => result.claims)) {
    const key = canonicalJson([claim.site, claim.offset, claim.context]);
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  const next = results.flatMap((result) => result.flow.next);
  const frontiers: FlowFrontier[] = results.flatMap((result) => result.flow.frontiers);
  for (const claims of groups.values()) {
    const destinations = new Set(claims.map((claim) => canonicalJson([...new Set(claim.next.map(({ carrier, returnsTo }) => canonicalJson({ carrier, returnsTo })))].sort())));
    if (destinations.size === 1) {
      const paths = claims.flatMap((claim) => claim.next.map((item) => ({ ...item, evidence: [...(item.evidence ?? []), ...claim.evidence] })));
      next.push(...new Map(sorted(paths).map((item) => [canonicalJson(item), item])).values());
    } else for (const at of sorted(claims.flatMap((claim) => claim.evidence))) frontiers.push({ at, cause: "path-conflict", reason: "unresolved", hops: [] });
  }
  if (carrier.site.kind === "input" && results.length === 0 && base.frontiers.length === 0) {
    frontiers.push({ at: { path: siteFile(carrier.site), line: 1 }, cause: "unsupported-binding", reason: "no-extractor", hops: [] });
  }
  const byEvidence = <T>(values: readonly T[], evidence: (value: T) => { path: string; line: number; column?: number } | undefined): T[] => [...values].sort((a, b) => {
    const left = evidence(a), right = evidence(b);
    return compareText(left?.path ?? "", right?.path ?? "") || (left?.line ?? 0) - (right?.line ?? 0) || (left?.column ?? 0) - (right?.column ?? 0) || compareText(canonicalJson(a), canonicalJson(b));
  });
  return { uses: [...base.uses, ...byEvidence(results.flatMap((result) => result.flow.uses), (use) => use.site)], next: [...base.next, ...byEvidence(next, (item) => item.hops[0]?.evidence)], frontiers: [...base.frontiers, ...byEvidence(frontiers, (frontier) => frontier.at)] };
}

export interface ConsumerReadersDeps {
  buildProgram: typeof buildProgram;
  createRequestCallLookup?: typeof createRequestCallLookup;
}

const defaultDeps: ConsumerReadersDeps = { buildProgram, createRequestCallLookup };

/** Both readers hold one program for this reading; origin-specific preparation stays lazy. */
export async function createConsumerReaders(files: readonly SourceFile[], repo: string, deps: ConsumerReadersDeps = defaultDeps, plugins?: readonly FrameworkPlugin[]) {
  let held: ReturnType<typeof buildProgram> | undefined;
  const program = () => (held ??= deps.buildProgram(files));
  const reading = new TypeScriptReading(program(), files);
  let heldLookup: ReturnType<typeof createRequestCallLookup> | undefined;
  const lookupOf: typeof createRequestCallLookup = () => (heldLookup ??= (deps.createRequestCallLookup ?? createRequestCallLookup)(files));
  const [built, lookup] = await Promise.all([reading.program(), lookupOf(files)]);
  const manifests = manifestsOf(files);
  const projectAllows = (dependency: string, file: string): boolean => {
    const project = projectOf(file, manifests);
    return project === undefined || project.dependencies.has(dependency);
  };
  const applies = (plugin: FrameworkPlugin, file: string): boolean => {
    const unit = built.index.units.get(file);
    return unit !== undefined && [plugin.signal, ...(plugin.consumer?.signals ?? [])].some((signal) => projectAllows(signal.dependency, file) && [...unit.imports.values()].some((one) => one.module === signal.module));
  };
  const applicable = plugins?.filter((plugin) => plugin.languages.includes(reading.language) && [...built.index.units.keys()].some((file) => applies(plugin, file))) ?? [];
  const prepared = await Promise.all(applicable.map(async (plugin) => ({ plugin, stage: plugin.absent?.includes("consumer") === true ? undefined : await plugin.consumer?.prepare(reading, repo) })));
  const base = consumerFlowReader(built, repo, lookup);
  return {
    flow: { follow: (carrier: Carrier): FlowResult => {
      const file = siteFile(carrier.site);
      const stages = prepared.flatMap(({ plugin, stage }) => {
        if (stage === undefined) return [];
        if (carrier.site.kind !== "return") return applies(plugin, file) ? [stage] : [];
        const related = stage.associations?.filter(({ site }) => canonicalJson(site) === canonicalJson(carrier.site)) ?? [];
        const uncertain = stage.uncertainFiles?.filter((one) => one.file === file) ?? [];
        if (related.length > 0 || uncertain.length > 0) return [...related, ...uncertain].some((one) => projectAllows(one.dependency, file)) ? [stage] : [];
        return applies(plugin, file) ? [stage] : [];
      });
      const result = contributions(carrier, base.follow(carrier), stages);
      const absent = prepared.some(({ plugin }) => plugin.absent?.includes("consumer") === true && applies(plugin, siteFile(carrier.site)));
      if (!absent) return result;
      return { ...result, frontiers: [...result.frontiers.filter((one) => one.reason !== "no-extractor"), { at: { path: file, line: siteLine(carrier.site) ?? 1 }, cause: "unmodelled-flow" as const, reason: CAPABILITY_ABSENT, hops: [] }] };
    } },
    origins: createRequestOriginReader(files, program, lookupOf),
  };
}
