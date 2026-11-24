import type { Decision } from "../../core/domain/decisions/decision.ts";
import type { Entrypoint } from "../../core/domain/entrypoints/entrypoint.ts";
import type { Handler } from "../../core/domain/entrypoints/http-route.ts";
import type { ImpactedSymbol, ReachedEntrypoint, Seed } from "../../core/domain/impact/impact-fact.ts";
import type { OutlineDeclaration } from "../../core/domain/outline/outline-fact.ts";
import { canonicalJson } from "../../core/domain/shared/canonical-json.ts";
import { compareText } from "../../core/domain/shared/code-node.ts";
import type { Cut, Evidence, Finding } from "../../core/domain/shared/fact.ts";
import type { UnresolvedCallSite } from "../../core/domain/topology/call-site.ts";
import { linkIdentity, type Link, type UnlinkedCallSite } from "../../core/domain/topology/link.ts";
import type { OutwardName } from "../../core/domain/topology/outward-name.ts";
import type { TraceStep } from "../../core/domain/trace/trace-fact.ts";
import { FIXED_LAYER_DIRECTORY } from "../../core/ports/fixed-layer-store.port.ts";
import { WORKSPACE_MANIFEST_FILE } from "../../core/ports/workspace-defaults.port.ts";
import type { WorkspaceSource } from "../../core/ports/workspace-repos.port.ts";
import { cutRowLabel, subjectText } from "../presentation-context.ts";
import { driftText, statedRequestText, unresolvedLabel } from "../presentation.ts";
import type { Place, Qualifier, Row, Section } from "./model.ts";

export type DeclarationSource = Seed | ImpactedSymbol | TraceStep | OutlineDeclaration;

function qualifiersOf(declaration: DeclarationSource): Qualifier[] {
  if ("fanIn" in declaration) {
    const qualifiers: Qualifier[] = [{ name: "depth", value: String(declaration.depth) }];
    if (declaration.confidence < 1) qualifiers.push({ name: "confidence", value: String(declaration.confidence) });
    if (declaration.via?.derivation === "name-match") qualifiers.push({ name: "name match" });
    if (declaration.via?.derivation === "typed") qualifiers.push({ name: "typed" });
    if (declaration.fanIn > 0) qualifiers.push({ name: "fan-in", value: String(declaration.fanIn) });
    return qualifiers;
  }
  return "basis" in declaration ? [{ name: declaration.basis }] : [];
}

/** The row of a declaration; its key is the repository, file, line and symbol, so overloads and moves stay distinct. */
export function declarationRow(file: string, declaration: DeclarationSource, repo?: string): Row {
  const name = "symbol" in declaration ? declaration.symbol : declaration.name;
  const place: Place = { ...(repo === undefined ? {} : { repo }), path: file, line: declaration.line, ...(declaration.endLine === undefined ? {} : { endLine: declaration.endLine }) };
  const qualifiers = qualifiersOf(declaration);
  const children = "children" in declaration ? declaration.children : undefined;
  return {
    key: [repo ?? "", file, String(declaration.line), name].join("\0"),
    place,
    label: "kind" in declaration ? `${name} [${declaration.kind}]` : name,
    ...(qualifiers.length === 0 ? {} : { qualifiers }),
    ...(children === undefined || children.length === 0 ? {} : { children: children.map((child) => declarationRow(file, child, repo)) }),
  };
}

function cutRow(cut: Cut): Row {
  const key = ["cut", cut.kind, cut.reason, cut.subReason ?? "", String(cut.limit ?? ""), cut.at.join("\u0001")].join("\0");
  const places = cut.kind === "section" ? [] : [...cut.at, ...(cut.cause ?? [])];
  return {
    key,
    label: `${cut.kind === "section" ? `${cutRowLabel(cut)}: ${cut.at.join(", ")}` : cutRowLabel(cut)}${cut.limit === undefined ? "" : ` (limit ${cut.limit})`}`,
    ...(places.length === 0 ? {} : { children: places.map((at) => ({ key: `${key}\0${at}`, label: at })) }),
  };
}

/** The cuts as the completeness section of an answer, the cause that cut most first (ADR-0042 decision 8). */
export function cutSection(cuts: readonly Cut[], id = "cuts", title = "cuts"): Section {
  const groups = [...Map.groupBy(cuts, cutRowLabel)].toSorted(([a, ofA], [b, ofB]) => ofB.length - ofA.length || compareText(a, b));
  return { id, title, role: "completeness", layout: "list", rows: groups.flatMap(([, ofLabel]) => ofLabel.map(cutRow)) };
}

const placeOfEvidence = ({ path, line, endLine }: Evidence): Place => ({ path, line, ...(endLine === undefined ? {} : { endLine }) });

/** An evidence place with how it was found, when the extractor recorded that. */
export const evidencePlace = (evidence: Evidence): Place => ({ ...placeOfEvidence(evidence), ...(evidence.via === undefined ? {} : { via: evidence.via }), ...(evidence.confidence === undefined ? {} : { confidence: evidence.confidence }) });
const placeOfHandler = ({ path, line, endLine }: Handler): Place => ({ path, line, ...(endLine === undefined ? {} : { endLine }) });
const spanOf = ({ path, line, endLine }: Evidence): string => `${path}:${line}${endLine === undefined ? "" : `-${endLine}`}`;

function entrypointKey(repo: string | undefined, kind: string, name: string, place: Place | undefined): string {
  return [repo ?? "", kind, name, place?.path ?? "", String(place?.line ?? "")].join("\0");
}

function unknownRow(finding: Extract<Finding<Entrypoint>, { status: "unknown" }>, repo?: string): Row {
  const [first, ...others] = finding.evidence;
  const place = first === undefined ? undefined : placeOfEvidence(first);
  const rest = first?.via === undefined && first?.confidence === undefined ? others : finding.evidence;
  return {
    key: entrypointKey(repo, "unknown", `${finding.reason}${subjectText(finding.subject)}`, place),
    ...(place === undefined ? {} : { place }),
    label: `unknown (${finding.reason})${subjectText(finding.subject)}`,
    ...(rest.length === 0 ? {} : { evidence: rest.map(evidencePlace) }),
  };
}

function entrypointHandler(entrypoint: Entrypoint): Handler | undefined {
  if (entrypoint.kind !== "ui-route") return entrypoint.handler;
  return entrypoint.component === "unknown" ? undefined : entrypoint.component;
}

function guardRows(parent: string, entrypoint: Entrypoint): Row[] {
  if (entrypoint.kind !== "ui-route") return [];
  return entrypoint.guards.map((guard) => ({
    key: [parent, "guard", guard.name, guard.path ?? ""].join("\0"),
    ...(guard.path === undefined ? {} : { place: { path: guard.path } }),
    label: `guard ${guard.name}`,
    ...(guard.external === true ? { qualifiers: [{ name: "external" }] } : {}),
  }));
}

function foundRow(finding: Extract<Finding<Entrypoint>, { status: "complete" }>, repo?: string): Row {
  const entrypoint = finding.value;
  const handler = entrypointHandler(entrypoint);
  const place = handler === undefined ? undefined : placeOfHandler(handler);
  const [declaration, ...rest] = finding.evidence;
  const declared = entrypoint.kind === "ui-route" ? declaration : undefined;
  const evidence = (declared === undefined ? finding.evidence : rest).map(evidencePlace);
  const key = entrypointKey(repo, entrypoint.kind, entrypoint.name, place ?? (declaration === undefined ? undefined : placeOfEvidence(declaration)));
  const guards = guardRows(key, entrypoint);
  const qualifiers: Qualifier[] = [
    ...(declared === undefined ? [] : [{ name: "at", value: spanOf(declared) }]),
    ...(guards.length === 0 ? [] : [{ name: "guards", value: String(guards.length) }]),
  ];
  return {
    key,
    ...(place === undefined ? {} : { place }),
    label: `${entrypoint.kind} ${entrypoint.name} -> ${handler === undefined ? "component unknown" : handler.symbol}`,
    ...(qualifiers.length === 0 ? {} : { qualifiers }),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(guards.length === 0 ? {} : { children: guards }),
  };
}

export interface ReachedOptions { seeds?: readonly Seed[]; handlerSelector?: string }

function reachedRow(reached: ReachedEntrypoint, repo: string | undefined, options: ReachedOptions): Row {
  const place = placeOfHandler(reached.handler);
  const name = reached.name === undefined ? reached.kind : `${reached.kind} ${reached.name}`;
  const qualifiers: Qualifier[] = [
    { name: "depth", value: String(reached.depth) },
    ...(reached.seeds.length === 0 ? [] : [{ name: "origins", value: reached.seeds.join(", ") }]),
    ...(options.handlerSelector === undefined ? [] : [{ name: "lookup example:", value: options.handlerSelector }]),
    ...(reached.confidence < 1 ? [{ name: "confidence", value: String(reached.confidence) }] : []),
    ...(reached.declaredAt === undefined ? [] : [{ name: "at", value: spanOf(reached.declaredAt) }]),
  ];
  const observations = reached.kind === "unknown" ? [...new Map(reached.observations.map((observation) => [unknownRow(observation, repo).key, unknownRow(observation, repo)])).values()] : [];
  return {
    key: entrypointKey(repo, reached.kind, reached.name ?? "", place),
    place,
    label: `${name} -> ${reached.handler.symbol}`,
    qualifiers,
    ...(observations.length === 0 ? {} : { children: observations, childrenAreAnswer: true }),
    ...(options.seeds === undefined ? {} : { evidence: reached.seeds.flatMap((index) => { const seed = options.seeds![index]; return seed === undefined ? [] : [{ path: seed.file, line: seed.line, ...(seed.endLine === undefined ? {} : { endLine: seed.endLine }) }]; }) }),
  };
}

/**
 * The row of an entrypoint a fact states, found by the entrypoints map or reached from a change. Its key is the
 * repository, kind, name and place, so the same entrypoint has one key whichever family states it. A UI route's guards
 * are its children, and the place its route entry is declared at is a qualifier.
 */
export function entrypointRow(source: Finding<Entrypoint> | ReachedEntrypoint, repo?: string, options: ReachedOptions = {}): Row {
  const row = "depth" in source ? reachedRow(source, repo, options) : source.status === "unknown" ? unknownRow(source, repo) : foundRow(source, repo);
  return repo === undefined ? row : repositoryRow(row, repo);
}

function repositoryRow(row: Row, repo: string): Row {
  return {
    ...row,
    ...(row.place === undefined ? {} : { place: { ...row.place, repo } }),
    ...(row.evidence === undefined ? {} : { evidence: row.evidence.map((place) => ({ ...place, repo })) }),
    ...(row.children === undefined ? {} : { children: row.children.map((child) => repositoryRow(child, repo)) }),
  };
}

export function qualifiedEvidence(evidence: Evidence, repo?: string): Place {
  const owner = "repo" in evidence && typeof evidence.repo === "string" ? evidence.repo : repo;
  return { ...evidencePlace(evidence), ...(owner === undefined ? {} : { repo: owner }) };
}

export function nameRow(source: OutwardName | Decision, repo?: string): Row {
  const decision = "subject" in source ? source : undefined;
  const evidence = source.evidence.map(place => qualifiedEvidence(place, repo));
  const key = decision === undefined ? [repo ?? canonicalJson(source.evidence), source.kind, (source as OutwardName).name].join("\0") : decision.id;
  return {
    key,
    label: `${source.kind} ${decision?.subject ?? (source as OutwardName).name}`,
    evidence,
    qualifiers: [
      ...(repo === undefined ? [] : [{ name: "repository", value: repo }]),
      ...(evidence.length === 0 ? [] : [{ name: evidence.length === 1 ? "1 place" : `${evidence.length} places` }]),
      ...(decision === undefined ? [] : [...(decision.required ? [{ name: "required" }] : []), ...(decision.allowsFreeText ? [{ name: "free text allowed" }] : [])]),
    ],
    ...(decision === undefined ? {} : { childrenAreAnswer: true, children: decision.options.map(option => ({
      key: [key, "option", option.value].join("\0"), label: option.value,
      qualifiers: [...(option.basis === undefined ? [] : [{ name: option.basis }]), ...(option.recommended ? [{ name: "recommended" }] : [])],
      evidence: canonicalJson(option.evidence) === canonicalJson(decision.evidence) ? [] : option.evidence.map(place => qualifiedEvidence(place)),
    })) }),
  };
}

export function linkRow(link: Link): Row {
  const key = linkIdentity(link);
  const drift = driftText(link.drift);
  return {
    key, tier: 0,
    place: { repo: link.from.repo, path: link.from.file, line: link.from.line },
    label: `${link.from.symbol} -> ${link.to.repo} ${link.to.name}`,
    qualifiers: [{ name: link.transport }, { name: link.basis }, ...(link.confidence < 1 ? [{ name: "confidence", value: String(link.confidence) }] : []), ...(link.profiles === undefined ? [] : [{ name: "under", value: link.profiles.join(", ") }]), ...(link.authority === undefined ? [] : [{ name: "base URL undecided" }]), ...(drift === "" ? [] : [{ name: drift }])],
    childrenAreAnswer: true,
    children: [{ key: `${key}\0handler`, place: { ...link.to.handler, repo: link.to.repo }, label: `-> ${link.to.handler.symbol}` }],
    evidence: (link.propagatedThrough ?? []).map(place => ({ repo: link.from.repo, path: place.file, line: place.line, via: place.kind })),
  };
}

export function callSiteRow(site: UnlinkedCallSite | UnresolvedCallSite, repo?: string): Row {
  if ("from" in site) return {
    key: canonicalJson([site.from, site.transport, site.method, site.name, site.outcome]),
    place: { repo: site.from.repo, path: site.from.file, line: site.from.line },
    label: `${site.from.symbol} ${site.transport}${site.method === undefined ? "" : ` ${site.method}`} ${site.name}: ${site.outcome}`,
    qualifiers: [...(site.repos === undefined ? [] : [{ name: "repositories", value: site.repos.join(", ") }]), ...(site.routes === undefined ? [] : [{ name: "routes", value: site.routes.join(", ") }])],
    evidence: (site.propagatedThrough ?? []).map(place => ({ repo: site.from.repo, path: place.file, line: place.line, via: place.kind })),
  };
  return {
    key: canonicalJson([repo, site.path, site.line, site.symbol, site.transport, site.reason, site.diagnostic]),
    place: { ...(repo === undefined ? {} : { repo }), path: site.path, line: site.line, ...(site.endLine === undefined ? {} : { endLine: site.endLine }) },
    label: `${site.symbol} (${site.transport}${site.via === undefined ? "" : `, through ${site.via}`})${site.stated === undefined ? "" : ` ${statedRequestText(site)}`} ${unresolvedLabel(site)}`,
    qualifiers: [{ name: site.reason + (site.diagnostic === undefined ? "" : `/${site.diagnostic.cause}`) }, ...(site.diagnostic?.source === undefined ? [] : [{ name: site.diagnostic.source }]), ...(site.deferred ? [{ name: "deferred" }] : []), ...(site.diagnostic?.alternatives === undefined ? [] : [{ name: "declared alternatives", value: site.diagnostic.alternatives.join(", ") }])],
    evidence: [...site.evidence, ...(site.diagnostic?.unreadableSources ?? [])].map(place => qualifiedEvidence(place, repo)),
  };
}

export function repositorySourceLine(source: WorkspaceSource): string {
  const label = { request: "the request", persisted: `${FIXED_LAYER_DIRECTORY}/${WORKSPACE_MANIFEST_FILE}`, none: "nothing: this answer covers the bound repository alone" }[source];
  return `repositories declared by: ${label}${source === "none" ? " (pass repos, or persist a declaration with ye-ast init --workspace)" : ""}`;
}
