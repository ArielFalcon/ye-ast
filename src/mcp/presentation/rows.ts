import type { Entrypoint } from "../../core/domain/entrypoints/entrypoint.ts";
import type { Handler } from "../../core/domain/entrypoints/http-route.ts";
import type { ImpactedSymbol, ReachedEntrypoint, Seed } from "../../core/domain/impact/impact-fact.ts";
import type { OutlineDeclaration } from "../../core/domain/outline/outline-fact.ts";
import { compareText } from "../../core/domain/shared/code-node.ts";
import type { Cut, Evidence, Finding } from "../../core/domain/shared/fact.ts";
import type { TraceStep } from "../../core/domain/trace/trace-fact.ts";
import { cutRowLabel, subjectText } from "../presentation-context.ts";
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
    label: cut.kind === "section" ? `${cutRowLabel(cut)}: ${cut.at.join(", ")}` : cutRowLabel(cut),
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

function reachedRow(reached: ReachedEntrypoint, repo?: string): Row {
  const place = placeOfHandler(reached.handler);
  const name = reached.name === undefined ? reached.kind : `${reached.kind} ${reached.name}`;
  const qualifiers: Qualifier[] = [
    { name: "depth", value: String(reached.depth) },
    ...(reached.confidence < 1 ? [{ name: "confidence", value: String(reached.confidence) }] : []),
    ...(reached.declaredAt === undefined ? [] : [{ name: "at", value: spanOf(reached.declaredAt) }]),
  ];
  const observations = reached.kind === "unknown" ? [...new Map(reached.observations.map((observation) => [unknownRow(observation, repo).key, unknownRow(observation, repo)])).values()] : [];
  return {
    key: entrypointKey(repo, reached.kind, reached.name ?? "", place),
    place,
    label: `${name} -> ${reached.handler.symbol}`,
    qualifiers,
    ...(observations.length === 0 ? {} : { children: observations }),
  };
}

/**
 * The row of an entrypoint a fact states, found by the entrypoints map or reached from a change. Its key is the
 * repository, kind, name and place, so the same entrypoint has one key whichever family states it. A UI route's guards
 * are its children, and the place its route entry is declared at is a qualifier.
 */
export function entrypointRow(source: Finding<Entrypoint> | ReachedEntrypoint, repo?: string): Row {
  if ("depth" in source) return reachedRow(source, repo);
  return source.status === "unknown" ? unknownRow(source, repo) : foundRow(source, repo);
}
