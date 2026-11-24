import type { ImpactedSymbol, Seed } from "../../core/domain/impact/impact-fact.ts";
import type { OutlineDeclaration } from "../../core/domain/outline/outline-fact.ts";
import { compareText } from "../../core/domain/shared/code-node.ts";
import type { Cut } from "../../core/domain/shared/fact.ts";
import type { TraceStep } from "../../core/domain/trace/trace-fact.ts";
import { cutRowLabel } from "../presentation-context.ts";
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
