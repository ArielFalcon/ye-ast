import { dependencyDiagnosticText, driftText, effectText, statedRequestText, unresolvedLabel } from "./presentation.ts";
import { canSelect, categoryRecovery, literalSelection, sharedLookup } from "./presentation-guidance.ts";
import type { ImpactOwner } from "./select-evidence.ts";
import type { CutOwner } from "../core/domain/composition/source-read.ts";
import { renderFactHeader as headerLines, renderFactStatus as statusLines, evidenceText, cutsByKind, cutCounts, cutReasonText, cutRowLabel, completeText, undecidedOf, subjectText, type StatusContext } from "./presentation-context.ts";
import type { RenderDetail, RenderContext } from "./presentation.ts";
import type { Handler } from "../core/domain/entrypoints/http-route.ts";
import type { ChangedContract } from "../core/domain/impact/changed-contracts.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { ImportedFile, ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { OutlineBinding, OutlineDeclaration, OutlineImport, OutlineUse, OutlineValue } from "../core/domain/outline/outline-fact.ts";
import { hasUnprovedUses } from "../core/domain/outline/outline-uses.ts";
import type { ExternalCalls, IssuingPlace, TraceLinked, TraceStep, TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { EntrypointMap } from "../core/domain/map/entrypoint-map.ts";
import type { ChangeFrontier, ClassifiedDifference, ConsequenceFinding, ConsequencesValue, HypothesisAnswer, ProducerConsequence, UseConsequence } from "../core/domain/contracts/consequence-fact.ts";
import { compareText } from "../core/domain/shared/code-node.ts";
import { FUNCTION_VALUE_AWAITS_JDK, type Cut, type Fact, type SnapshotRef, type WalkBounds } from "../core/domain/shared/fact.ts";
import type { LiveStaleNotice } from "../core/ports/live-queries.port.ts";
import type { RepositoryEvidence } from "../core/domain/shared/repository-evidence.ts";
import type { WorkspaceRefresh, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import { compareUnresolvedCallSites, httpTargetOf, inheritedCallerCount, statedRequestsOf, type CallSite, type InheritedCaller, type InheritedGap, type UnresolvedCallSite } from "../core/domain/topology/call-site.ts";
import type { ImpactedLink, Link, UnlinkedCallSite } from "../core/domain/topology/link.ts";
import type { RepositoryResolution } from "../core/domain/topology/remote-snapshot.ts";
import type { RepoImpact, WorkspaceImpactValue } from "../core/ports/workspace-impact-queries.port.ts";
import type { WorkspaceSource } from "../core/ports/workspace-repos.port.ts";
import { FIXED_LAYER_DIRECTORY } from "../core/ports/fixed-layer-store.port.ts";
import { WORKSPACE_MANIFEST_FILE } from "../core/ports/workspace-defaults.port.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { blockBytes as size, preferShorterText, shareExactContext } from "./presentation-sharing.ts";
import { LISTED_ITEMS } from "./render-budget.ts";
import { present as presentEntrypoints } from "./presentation/families/entrypoints.ts";
import { present as presentWorkspace } from "./presentation/families/workspace.ts";
import { present as presentDecisions } from "./presentation/families/decisions.ts";
import { write } from "./presentation/writer.ts";
import { present as presentImpact, presentWorkspace as presentWorkspaceImpact } from "./presentation/families/impact.ts";
import { cutSection } from "./presentation/rows.ts";

const NONE = "  (none)";
const ROW_NUMBER_NOTE = "select entrypoint-evidence: findingIndex is the row number";
const GUARD_NOTE = "Only each route's own guards are recorded; inherited or runtime restrictions are not established here.";
const DECISIONS_HINT = "ye_ast_decisions lists the declarations that would resolve these gaps, with evidence-backed options.";
const CUTS = "cuts:";
const NO_PROVEN_USE = "uses nothing proven outside its body; its unresolved-link cuts list the uses not proven";

/** What each source of the repositories in force is called in the text; `none` says what the answer then covers. */
const SOURCE_TEXT: Readonly<Record<WorkspaceSource, string>> = {
  request: "the request",
  persisted: `${FIXED_LAYER_DIRECTORY}/${WORKSPACE_MANIFEST_FILE}`,
  none: "nothing: this answer covers the bound repository alone",
};

/** The line that says where the repositories the answer worked over came from, so one repository is never read as all of them. */
function sourceLine(source: WorkspaceSource, reposArgument: "repos" | "workspace.repos" = "workspace.repos"): string {
  const recovery = source === "none" ? ` (pass ${reposArgument}, or persist a declaration with ye-ast init --workspace)` : "";
  return `repositories declared by: ${SOURCE_TEXT[source]}${recovery}`;
}

/** A place: its line, and the last line when the declaration spans more than one. */
function spanText(line: number, endLine?: number): string {
  return endLine === undefined ? `${line}` : `${line}-${endLine}`;
}

function placeText(path: string, line: number, endLine?: number): string {
  return `${path}:${spanText(line, endLine)}`;
}

function cutsOf(fact: Fact<unknown>): readonly Cut[] {
  return fact.status === "partial" ? fact.cuts : [];
}

/** The reason of the repository section a name holds when that section is unknown. */
function unknownSectionIn(sections: Readonly<Record<string, Fact<unknown>>>): NonNullable<StatusContext["unknownSection"]> {
  return (name) => {
    const section = Object.hasOwn(sections, name) ? sections[name] : undefined;
    return section?.status === "unknown" ? section.reason : undefined;
  };
}

/** The first `:<line>` followed by a space or the end closes the path, as `placeAt` builds the place; the rest is its reason. */
const PLACE = /^(.*?):(\d+)(?: (.*))?$/s;

/** A `Cut.at` place read back into its parts; an entry that is no place is a file with no line and no reason. */
function placeOf(place: string): { file: string; line: string; reason: string } {
  const [, file = place, line = "", reason = ""] = PLACE.exec(place) ?? [];
  return { file, line, reason };
}

/** A place after its file: the line, and the reason it could not be read when it carries one. */
function placeRest({ line, reason }: ReturnType<typeof placeOf>): string {
  return reason === "" ? line : `${line} (${reason})`;
}

/** The places of an `unresolved-link` cut: the ones in the anchor's own file as line numbers, the rest as path:line. */
function cutPlaces(cut: Cut): string {
  const [anchor, ...places] = cut.at;
  if (cut.kind !== "unresolved-link" || anchor === undefined || places.length === 0) return cut.at.join(", ");
  const file = anchor.includes("::") ? anchor.slice(0, anchor.indexOf("::")) : anchor;
  const here = places.map(placeOf).filter((place) => place.file === file && place.line !== "").map(placeRest);
  const elsewhere = places.filter((place) => { const parsed = placeOf(place); return parsed.file !== file || parsed.line === ""; });
  const lines = here.length === 0 ? [] : [`${here.length === 1 ? "line" : "lines"} ${here.join(", ")}`];
  return `${anchor}: ${[...lines, ...groupedPlaces(elsewhere)].join(", ")}`;
}

/** The places grouped under their file, so a path repeated by every place is printed once and no place is dropped. */
function groupedPlaces(places: readonly string[]): string[] {
  const byFile = new Map<string, string[]>();
  for (const place of places) {
    const { file, line, reason } = placeOf(place);
    const key = reason === "" ? file : `${file} (${reason})`;
    byFile.set(key, [...(byFile.get(key) ?? []), line].filter((part) => part !== ""));
  }
  return [...byFile].map(([head, lines]) => (lines.length === 0 ? head : lines.length === 1 ? `${head}:${lines[0]}` : `${head}: ${lines.join(", ")}`));
}

/** One cut row; details name why the cut exists. */
function cutLine(cut: Cut, detail: RenderDetail): string {
  return `  ${detail === "details" ? cutRowLabel(cut) : cut.kind} at ${cutPlaces(cut)}${cut.limit === undefined ? "" : ` (limit ${cut.limit})`}`;
}

/** The single-path cuts of one kind on one line: their limit only when all of them share it. */
function singlePathLine(kind: string, cuts: readonly Cut[]): string {
  const sorted = [...cuts].toSorted((a, b) => compareText(a.at[0] ?? "", b.at[0] ?? "") || (a.limit ?? 0) - (b.limit ?? 0));
  const limits = new Set(cuts.map((cut) => cut.limit));
  const [shared] = limits;
  const listed =
    limits.size === 1
      ? `${sorted.map((cut) => cut.at[0]).join(", ")}${shared === undefined ? "" : ` (limit ${shared})`}`
      : sorted.map((cut) => `${cut.at[0]}${cut.limit === undefined ? "" : ` (limit ${cut.limit})`}`).join(", ");
  return `  ${kind} (${cuts.length}): ${listed}`;
}

/** The files the places of a cut sit in, without their lines: a place is `path:line`, a reason following a space. */
function placeFiles(cut: Cut): string {
  const files = new Set<string>();
  for (const place of cut.at.slice(1)) files.add(placeOf(place).file);
  return [...files].sort(compareText).join(", ");
}

/** The references a file-led cut could not settle, as written, sorted and deduplicated: the reader settles each one by
 * reading it, without opening the file. */
function placeReasons(cut: Cut): string[] {
  const reasons = new Set<string>();
  for (const place of cut.at.slice(1)) {
    const { reason } = placeOf(place);
    if (reason !== "") reasons.add(reason);
  }
  return [...reasons].sort(compareText);
}

/** Where the property a `reassignable` cut's calls run may have been replaced, from its cause. */
function reassignedAt(cuts: readonly Cut[]): string {
  const places = new Set(cuts.flatMap((cut) => (cut.reason === "reassignable" ? (cut.cause ?? []).map((cause) => { const place = placeOf(cause); return `${place.file}:${place.line}`; }) : [])));
  return places.size === 0 ? "" : `; may have been reassigned at ${[...places].sort(compareText).join(", ")}`;
}

/** The declarations an unresolved reference could not be settled to, under the file that holds them, each with the files
 * its references sit in. A file that leads a cut of its own names the references it holds, and a declaration whose places
 * are exactly those of another points at it instead of printing them a second time. */
function unresolvedDeclarations(cuts: readonly Cut[]): string[] {
  const whole = new Map<string, string[]>();
  const entries: { file: string; name: string; files: string; places: string }[] = [];
  for (const cut of cuts) {
    const anchor = cut.at[0] ?? "";
    const settled = anchor.indexOf("::");
    if (settled === -1) whole.set(anchor, [...new Set([...(whole.get(anchor) ?? []), ...placeReasons(cut)])]);
    else entries.push({ file: anchor.slice(0, settled), name: anchor.slice(settled + 2), files: placeFiles(cut), places: JSON.stringify([...new Set(cut.at.slice(1))].sort(compareText)) });
  }
  entries.sort((a, b) => compareText(a.file, b.file) || compareText(a.name, b.name));
  const canonical = new Map<string, { file: string; name: string }>();
  for (const entry of entries) if (entry.files !== "" && !canonical.has(entry.places)) canonical.set(entry.places, { file: entry.file, name: entry.name });
  const byFile = new Map<string, string[]>();
  for (const entry of entries) {
    const first = canonical.get(entry.places);
    const same = first !== undefined && (first.file !== entry.file || first.name !== entry.name);
    const line =
      entry.files === "" ? entry.name
      : !same ? `${entry.name}: ${entry.files}`
      : `${entry.name} (same places as ${first.file === entry.file ? first.name : `${first.file}::${first.name}`})`;
    byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), line]);
  }
  const references = cuts.reduce((total, cut) => total + Math.max(0, cut.at.length - 1), 0);
  const files = [...new Set([...whole.keys(), ...byFile.keys()])].sort(compareText);
  const named = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  const settled = [whole.size === 0 ? undefined : named(whole.size, "file", "files"), entries.length === 0 ? undefined : named(entries.length, "declaration", "declarations")].filter((part) => part !== undefined);
  return [
    `  unresolved-link (${settled.join(", ")}, ${named(references, "reference", "references")}; mode "details" lists every place):`,
    ...files.flatMap((file) => {
      const named = whole.get(file);
      return [
        named === undefined || named.length === 0 ? `    ${file}` : `    ${file}: ${named.join(", ")}`,
        ...(named !== undefined && named.length === 0 ? ["      (the file itself)"] : []),
        ...(byFile.get(file) ?? []).map((line) => `      ${line}`),
      ];
    }),
  ];
}

/** Every cut once: those that name a single path grouped per kind with every path listed, the rest one line each. Under
 * a summary, an unresolved link keeps only what it could not settle to. */
function dependencyCutLines(cuts: readonly Cut[], detail: RenderDetail): string[] {
  return cuts.flatMap((cut) => cut.dependency === undefined ? [] : [`  ${dependencyDiagnosticText(cut.dependency)}${detail === "details" ? ` at ${cutPlaces(cut)}` : ""}`]);
}

/** Cuts, grouped once by kind; a single-path kind puts all its paths on one line (many skipped files are one fact). In
 * a summary, an unresolved link keeps only what it could not settle to. */
function cutLines(cuts: readonly Cut[], detail: RenderDetail): string[] {
  const dependencies = dependencyCutLines(cuts, detail);
  if (dependencies.length > 0) return [...dependencies, ...cutLines(cuts.filter((cut) => cut.dependency === undefined), detail)];
  return cutsByKind(cuts).flatMap(([kind, ofKind]) => {
    if (kind === "unresolved-link" && detail !== "details") return unresolvedDeclarations(ofKind);
    const single = ofKind.filter((cut) => cut.at.length === 1);
    const rest = ofKind.filter((cut) => cut.at.length > 1).toSorted((a, b) => compareText(a.at.join("\0"), b.at.join("\0")));
    const singles = detail === "details" ? [...Map.groupBy(single, cutRowLabel)].toSorted(([a], [b]) => compareText(a, b)) : single.length === 0 ? [] : [[kind, single] as const];
    return [...singles.map(([label, cuts]) => singlePathLine(label, cuts)), ...rest.map((cut) => cutLine(cut, detail))];
  });
}

/** One selector template per cut owner; row indices always refer to the original array. */
function cutContextLine(owner: CutOwner, cutIndex: number, context?: RenderContext): string {
  const example = { kind: "cut-places", owner, cutIndex } as const;
  const selectable = context === undefined || canSelect(context, example, owner.kind === "section");
  return selectable
    ? sharedLookup("Cut", "cutIndex <n>", "cutIndex", example)
    : `  Recorded cut context: ${JSON.stringify({ kind: "cut-places", owner })}; each row supplies its cutIndex.`;
}

function cutCoordinates(cuts: readonly Cut[], owner: CutOwner, detail: RenderDetail, context?: RenderContext): string[] {
  if (cuts.length === 0) return [];
  const shown = new Set<Cut["kind"]>();
  const rows = cuts.flatMap((cut, cutIndex) => {
    if (detail === "summary" && shown.has(cut.kind)) return [];
    shown.add(cut.kind);
    return [{ cutIndex, anchor: detail === "summary" ? "" : ` (anchor ${JSON.stringify(cut.at[0])})` }];
  });
  const first = rows[0]!;
  const example = { kind: "cut-places", owner, cutIndex: first.cutIndex } as const;
  const selectable = context === undefined || canSelect(context, example, owner.kind === "section");
  const literal = rows.map(({ cutIndex, anchor }) => `  ${!selectable ? "recorded coordinates" : "lookup example"}: ${literalSelection({ kind: "cut-places", owner, cutIndex })}${anchor}`);
  const shared = [
    cutContextLine(owner, first.cutIndex, context),
    ...rows.map(({ cutIndex, anchor }) => `  cutIndex ${cutIndex}${anchor}`),
  ];
  return size(shared) < size(literal) ? shared : literal;
}

function cutsBlock(cuts: readonly Cut[], detail: RenderDetail = "summary"): string[] {
  return cuts.length === 0 ? [] : [CUTS, ...cutLines(cuts, detail)];
}

function counted(label: string, items: readonly string[]): string {
  return items.length === 0 ? `${label} (0):` : `${label} (${items.length}): ${items.join(", ")}`;
}

function handlerText(handler: Handler): string {
  return `${placeText(handler.path, handler.line, handler.endLine)} ${handler.symbol}`;
}

export function renderEntrypointMap(fact: Fact<EntrypointMap>, detail: RenderDetail = "summary", context?: RenderContext): string {
  if (detail === "full") {
    if (fact.status === "unknown") return "Inspect reason and evidence; the result has no value.";
    const section = fact.value.entrypoints;
    return section.status === "unknown"
      ? "Check value.entrypoints.status, reason and evidence; this section has no value."
      : `${context?.recovery?.status === "unavailable" ? `Recovery unavailable (${context.recovery.reason}); recorded coordinates` : "Selection lookup"}: findingIndex is the zero-based position in value.entrypoints.value. Check value.entrypoints.status; match each complete finding (value.entrypoints.value[].value) by kind/name and handler or component coordinates. HTTP routes: inspect basePath status and evidence. Unknown findings carry reason and evidence; partial sections carry cuts.${section.value.some((item) => item.status === "complete" && item.value.kind === "ui-route") ? " UI routes: inspect value.entrypoints.value[].value.guards; they are the route's own, not inherited or runtime restrictions." : ""}`;
  }
  const lines = [write(presentEntrypoints(fact), detail).text];
  if (fact.status === "unknown") return lines.join("\n");
  const section = fact.value.entrypoints;
  if (section.status !== "unknown") {
    lines.push(...(section.value.length === 0 ? ["entrypoints: none"] : [ROW_NUMBER_NOTE]));
    if (section.value.some((item) => item.status === "complete" && item.value.kind === "ui-route")) lines.push(GUARD_NOTE);
  }
  lines.push(...cutCoordinates(cutsOf(fact), { kind: "fact" }, detail, context), ...cutCoordinates(cutsOf(section), { kind: "entrypoints" }, detail, context));
  return lines.join("\n");
}

function changedContractText(change: Omit<ChangedContract, "handlers">): string {
  const name = change.operationId === undefined ? "" : ` (${change.operationId})`;
  const parts = change.parts === undefined ? "" : ` ${change.parts.join(" and ")}`;
  return `${change.change} ${change.method} ${change.path}${name}${parts} at ${change.document}:${change.line}`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
function literalHandlers(value: ImpactValue, owner: ImpactOwner, context?: RenderContext): boolean {
  const handler = value.entrypoints[0]?.handler;
  if (handler === undefined || !value.entrypoints.some((entrypoint) => /\s/.test(entrypoint.handler.symbol))) return false;
  return context === undefined || canSelect(context, { kind: "handler-origins", owner, handler: { path: handler.path, symbol: handler.symbol, line: handler.line } }, owner.kind === "section");
}

function impactGuidance(value: ImpactValue, owner: ImpactOwner, context?: RenderContext): string[] {
  const handler = value.entrypoints[0]?.handler;
  const module = value.modules?.modules[0];
  const handlerExample = handler === undefined ? undefined : { kind: "handler-origins", owner, handler: { path: handler.path, symbol: handler.symbol, line: handler.line } } as const;
  const moduleExample = module === undefined ? undefined : { kind: "module-origins", owner, module: { file: module.file, snapshot: module.snapshot } } as const;
  return [
    ...(handlerExample === undefined || value.entrypoints.some((entrypoint) => /\s/.test(entrypoint.handler.symbol)) || (context !== undefined && !canSelect(context, handlerExample, owner.kind === "section")) ? [] : [value.entrypoints.length === 1 ? `  lookup example: ${literalSelection(handlerExample)}` : sharedLookup("Handler", "<path>:<line>[-<endLine>] -> <symbol>", "handler path, line and symbol (not endLine)", handlerExample)]),
    ...(moduleExample === undefined || (context !== undefined && !canSelect(context, moduleExample, owner.kind === "section")) ? [] : [value.modules!.modules.length === 1 ? `  lookup example: ${literalSelection(moduleExample)}` : sharedLookup("Module", "<file> <snapshot>", "module snapshot and file", moduleExample)]),
    ...(value.entrypoints.some((entrypoint) => entrypoint.seeds.length > 0) ? ["Origin indexes join seeds; an association is not a complete call chain."] : []),
    ...(owner.kind === "local" && context?.recovery?.status === "unavailable" ? [`Recovery unavailable (${context.recovery.reason}); recorded coordinates do not establish an executable replay.`] : []),
  ];
}

/**
 * The traversal bound a cut provably came from. Depth and hub cuts come only from symbol and module walks, and a walk
 * records its bounds in its own declared config, so a matching limit names the request's budget field. A caller-budget
 * cut may also come from an export, so it never names one; neither does any other kind.
 */
function impactCuts(cuts: readonly Cut[], detail: RenderDetail): string[] {
  if (cuts.length === 0) return [];
  const dependencies = dependencyCutLines(cuts, detail);
  if (dependencies.length > 0) return [CUTS, ...dependencies, ...impactCuts(cuts.filter((cut) => cut.dependency === undefined), detail).slice(1)];
  const groups = cutsByKind(cuts);
  if (detail === "summary") return [CUTS, ...groups.map(([kind, group]) => {
    const limits = [...new Set(group.flatMap((cut) => cut.limit === undefined ? [] : [cut.limit]))].toSorted((a, b) => a - b);
    return `  ${kind} (${group.length})${limits.length === 0 ? "" : `; ${limits.length === 1 ? "limit" : "limits"} ${limits.join(", ")}`}`;
  }), '  cuts mark missing coverage; mode "details" locates their recorded anchors and answer.json lists every place; neither extends coverage'];
  return [CUTS, ...groups.flatMap(([kind, group]) => {
    if (kind !== "unresolved-link") return cutLines(group, "details");
    const byFile = Map.groupBy(group, (cut) => (cut.at[0] ?? "").split("::")[0] ?? "");
    return [`  ${kind} (${group.length}):`, ...[...byFile].toSorted(([a], [b]) => compareText(a, b)).flatMap(([file, inFile]) => [
      `    ${file}`,
      ...[...Map.groupBy(inFile, (cut) => cut.at[0] ?? "")].toSorted(([a], [b]) => compareText(a, b)).map(([anchor, records]) => {
        const name = anchor.includes("::") ? anchor.slice(anchor.indexOf("::") + 2) : "(the file itself)";
        const places = records.reduce((total, cut) => total + Math.max(0, cut.at.length - 1), 0);
        const reasons = anchor.includes("::") ? [] : [...new Set(records.flatMap(placeReasons))].sort(compareText);
        const limits = [...new Set(records.flatMap((cut) => cut.limit === undefined ? [] : [cut.limit]))].toSorted((a, b) => a - b);
        const why = [...new Set(records.map(cutReasonText))].sort(compareText).join(", ");
        return `      ${name}: ${records.length} ${records.length === 1 ? "cut" : "cuts"} (${why}), ${places} reference ${places === 1 ? "place" : "places"}${limits.length === 0 ? "" : `; limits ${limits.join(", ")}`}${reasons.length === 0 ? "" : `; ${reasons.join(", ")}`}${reassignedAt(records)}`;
      }),
    ])];
  }), ...referencePlacesNote(cuts)];
}

/** Details list every place of the other kinds; only unresolved-link reference places are counted instead. */
function referencePlacesNote(cuts: readonly Cut[]): string[] {
  return cuts.some((cut) => cut.kind === "unresolved-link") ? ['  reference places counted; answer.json includes every place'] : [];
}

function walkBoundRemedies(cuts: readonly Cut[], walk: WalkBounds | undefined): string[] {
  return ([["depth", "depth"], ["hub", "hubFanIn"]] as const).flatMap(([kind, field]) => {
    const limit = walk?.[field];
    return limit !== undefined && cuts.some((cut) => cut.kind === kind && cut.limit === limit)
      ? [`  ${kind} cuts stopped at the walk bound budget.${field} ${limit}; a new query with a larger budget.${field} walks further at more cost; it does not filter this result.`]
      : [];
  });
}

function impactLookups(value: ImpactValue, path: string, context?: RenderContext): string[] {
  const lines: string[] = [];
  if (value.entrypoints.length > 0) lines.push(`  Reached entrypoints: ${path}.entrypoints by kind/name and handler.path, handler.symbol, handler.line; seeds are zero-based indexes into ${path}.seeds (associated origins, not a call chain).`);
  if (value.symbols.length > 0) lines.push(`  Dependencies: ${path}.symbols by file, symbol, line. via.file/symbol is the recorded dependency; via.lines are lines of that symbol's own file (via.resource when present), not of via.file. Keep via.basis, via.derivation and confidence: a name-match may be no dependence.`);
  if (value.seeds.length > 0 && value.entrypoints.length === 0) lines.push(`  Walk origins: ${path}.seeds by file, symbol, line; basis tells requested targets from change-derived origins.`);
  if (value.modules !== undefined && (value.modules.origins.length > 0 || value.modules.modules.length > 0)) lines.push(`  Modules: ${path}.modules.modules; origin indexes join ${path}.modules.origins. Module dependencies are not symbol impact.`);
  if ((value.changedEntrypoints?.length ?? 0) > 0) lines.push(`  Entrypoints added, removed or altered by the diff: ${path}.changedEntrypoints by change, kind/name and handler; not the reached ones.`);
  if (lines.length > 0 && context?.recovery?.status !== "unavailable") lines.unshift(`  Selection lookup: use handler path, symbol and line with owner ${path === "value" ? '{kind:"local"}' : '{kind:"section",repo:<repository key>}'}${context?.tool === "callers" || value.modules === undefined ? "." : "; modules: file and snapshot (base or head), same owner."}`);
  return lines;
}

function impactCutLookup(cuts: readonly Cut[], path: string, context?: RenderContext, walk?: WalkBounds): string[] {
  if (cuts.length === 0) return [];
  const example = { kind: "cut-places", owner: { kind: "fact" }, cutIndex: 0 } as const;
  return [
    ...(context !== undefined && canSelect(context, example, false) ? [`  lookup example: ${literalSelection(example)}`] : []),
    `  ${context?.recovery?.status === "unavailable" ? "Recorded coordinates" : "Selection lookup"}: cutIndex is the zero-based position in ${path}; owner names the fact, entrypoints section, repository section or indexed read.
  Before treating this as exhaustive, inspect ${path} by kind and anchor (at): a limit says where coverage stopped; full JSON does not extend it.`,
    ...(cuts.some((cut) => cut.kind === "unresolved-link") ? [`  unresolved-link in ${path}: at[0] is the unresolved file/declaration anchor, the rest potential references, not verified calls.`] : []),
    ...walkBoundRemedies(cuts, walk),
  ];
}

function impactSnapshotGuide(snapshot: SnapshotRef, mergeBase?: string, context?: RenderContext, hasBaseModules = false): string {
  if (context?.tool === "callers" && snapshot.kind === "sha") return `  Repeat callers with repo ${JSON.stringify(snapshot.repo)} and revision ${JSON.stringify(snapshot.sha)}, same scope and targets.`;
  if (snapshot.kind === "live") return `  A fresh live query on repo ${JSON.stringify(snapshot.repo)} captures current state; compare its head and stateId with this identity. A past live state cannot be requested.`;
  const selector = mergeBase === undefined ? `revision ${JSON.stringify(snapshot.sha)}` : `head ${JSON.stringify(snapshot.sha)} and base ${JSON.stringify(mergeBase)}`;
  return `  Repeat with repo ${JSON.stringify(snapshot.repo)} and the same snapshot (${selector}), same scope and change selection. For callers/outline/importers on head evidence use revision ${JSON.stringify(snapshot.sha)}${hasBaseModules ? "; base-side modules: their recorded merge-base revision" : ""}.`;
}

function baseModuleGuides(value: ImpactValue, repo: string, mergeBase = value.mergeBase, path = "value", reuseLocalBase = false, full = false): string[] {
  const modules = (value.modules?.modules ?? []).filter((module) => module.snapshot === "base");
  if (modules.length === 0) return [];
  const literalCoordinate = mergeBase === undefined ? "revision unavailable" : `revision ${JSON.stringify(mergeBase)}`;
  const coordinate = reuseLocalBase && Buffer.byteLength("the base recorded below") < Buffer.byteLength(literalCoordinate) ? "the base recorded below" : literalCoordinate;
  const literal = modules.map((module) => `  Base module: repo ${JSON.stringify(repo)}, ${coordinate}, file ${JSON.stringify(module.file)}; use outline only at that recorded merge base.`);
  const shared = [`  Base modules: repo ${JSON.stringify(repo)}, ${coordinate}; inspect ${path}.modules.modules[] for each base module's file; use outline only at that recorded merge base.`];
  const listed = [`  Base modules (${modules.length}): repo ${JSON.stringify(repo)}, ${coordinate}; each base module's file is in the module dependencies above where listed, and answer.json lists every one; use outline only at that recorded merge base.`];
  const bounded = full ? shared : listed;
  return size(bounded) < size(literal) ? bounded : literal;
}

/**
 * An unknown impact has no value, and no mode adds the missing analysis. The text header already prints its reason and
 * evidence; only the guide of `answer.json` points at their result fields.
 */
function unknownImpactGuide(fact: Fact<unknown> & { status: "unknown" }, detail: RenderDetail, context?: RenderContext): string[] {
  const narrower = context?.tool === "callers" ? "fewer targets" : "a narrower changed selection";
  return [
    "Analysis is unknown, not a verified absence of impact; no mode adds the missing analysis.",
    ...(fact.reason === "deadline" ? [`  It hit its deadline: a narrower scope or ${narrower} may let a new query finish.`] : []),
    ...(detail === "full" ? ["  reason and evidence in the result JSON hold its diagnostic; there is no value."] : []),
  ];
}

function localImpactGuide(fact: Fact<ImpactValue> & { status: "complete" | "partial" }, context?: RenderContext): string[] {
  const lookups = impactLookups(fact.value, "value", context);
  if (lookups.length === 0 && fact.status === "complete") return ["There are no recorded consequences or walk origins within the declared scope and change selection."];
  return [
    "Investigation guide:",
    "  Paths are relative to the result JSON.",
    ...lookups,
    ...(lookups.length === 0 ? ["  There are no recorded consequences or walk origins in this answer. Read inputs.declaredScope and inputs.declaredConfig before interpreting that scoped emptiness."] : []),
    ...impactCutLookup(cutsOf(fact), "cuts", context, fact.inputs.declaredConfig.walk),
    ...localQueryCoordinates(fact, context, "full"),
  ];
}

function localQueryCoordinates(fact: Fact<ImpactValue> & { status: "complete" | "partial" }, context: RenderContext | undefined, mode: RenderDetail): string[] {
  return [
    ...baseModuleGuides(fact.value, fact.snapshot.repo, fact.value.mergeBase, "value", fact.snapshot.kind === "sha" && fact.value.mergeBase !== undefined && context?.tool !== "callers", mode === "full"),
    impactSnapshotGuide(fact.snapshot, fact.value.mergeBase, context, fact.value.modules?.modules.some((module) => module.snapshot === "base")),
  ];
}

function workspaceImpactGuide(fact: Fact<WorkspaceImpactValue> & { status: "complete" | "partial" }, context?: RenderContext): string[] {
  const { value } = fact;
  const trigger = value.sections[value.trigger.repo];
  const originPath = `value.sections[${JSON.stringify(value.trigger.repo)}].value.impact`;
  const otherImpacts = Object.entries(value.sections).flatMap(([repo, section]) => repo === value.trigger.repo || section.status === "unknown" || section.value.impact === undefined ? [] : [section.value.impact]);
  return [
    "Investigation guide:",
    "  Paths are relative to the result JSON.",
    ...(Object.keys(value.sections).length === 0 ? [] : ["  Select value.sections by exact repository key. Before using a section's evidence check section.status and, when present, section.reason/cuts and section.value.reads[].fact status/reason; an unknown section has no value."]),
    ...(trigger?.status !== "unknown" && trigger?.value.impact !== undefined ? [`  The originating walk is at ${originPath}.`, ...impactLookups(trigger.value.impact, originPath, context)] : []),
    ...(otherImpacts.length === 0 ? [] : ["  Other repository walks: value.sections[repo].value.impact when present; entrypoints[].seeds index that walk's own seeds, never across repositories."]),
    ...(value.links.length === 0 ? [] : ["  Cross-repository consequences: filter value.links by link.from (repo/file/symbol/line) or link.to (repo/name/handler). reach lists link.id values, nearest the change first, the link numbers the text prints. Keep direction, basis and confidence; reach does not prove a path inside a repository."]),
    ...(value.workspace.unserved.length === 0 ? [] : ["  Missing service coverage: value.workspace.unserved and, for the call sites sent onward, section.value.unmatched and section.value.external (section.value.unrelated counts the others). ye_ast_workspace lists them with outward-name evidence and candidate repositories; adding workspace.repos changes coverage, it does not filter this fact."]),
    ...impactCutLookup(cutsOf(fact), "cuts", context, fact.inputs.declaredConfig.walk),
    ...(Object.values(value.sections).some((section) => section.status === "partial") ? ["  Repository-local limits are in value.sections[repo].cuts and its section.value.reads[].fact; a complete read does not resolve an unknown contributing one."] : []),
    ...(crossRepository(value) ? [workspaceOwnerGuide("full")] : []),
    ...workspaceBaseModuleGuides(value, "full"),
    ...new Set(value.links.map(({ link }) => {
      const snapshot = value.repositorySnapshots.find((entry) => entry.repo === link.to.repo)?.snapshot;
      const coordinate = snapshot === undefined ? "snapshot unavailable" : snapshot.kind === "sha" ? `revision ${JSON.stringify(snapshot.sha)}` : `earlier live head ${JSON.stringify(snapshot.head)} stateId ${JSON.stringify(snapshot.stateId)}; a fresh live query must be compared`;
      return `  Destination: repo ${JSON.stringify(link.to.repo)}, ${coordinate}, file ${JSON.stringify(link.to.handler.path)}, symbol ${JSON.stringify(link.to.handler.symbol)}.`;
    })),
    workspaceSnapshotGuide(fact, context),
  ];
}

function workspaceOwnerGuide(mode: RenderDetail): string {
  const snapshots = mode === "full" ? "value.repositorySnapshots" : "the repositories line";
  return `  For callers or outline on head evidence choose the recorded owner with repo and its own snapshot from ${snapshots}; base-side modules use their walk's recorded merge base. An undeclared owner needs a host registration update or an instance bound to that clone. A symbol name may match several declarations.`;
}

/** Evidence owned by a repository other than the bound one: only then does a follow-up query need to choose an owner. */
function crossRepository(value: WorkspaceImpactValue): boolean {
  return value.links.length > 0 || Object.entries(value.sections).some(([repo, section]) => repo !== value.trigger.repo && section.status !== "unknown" && section.value.impact !== undefined);
}

function impactHasRecords(value: ImpactValue): boolean {
  return value.seeds.length + value.symbols.length + value.entrypoints.length + (value.modules?.modules.length ?? 0) + (value.changedEntrypoints?.length ?? 0) > 0;
}

function workspaceBaseModuleGuides(value: WorkspaceImpactValue, mode: RenderDetail): string[] {
  return Object.entries(value.sections).flatMap(([repo, section]) => section.status === "unknown" || section.value.impact === undefined ? [] : baseModuleGuides(section.value.impact, repo, section.value.impact.mergeBase ?? (repo === value.trigger.repo ? value.trigger.mergeBase : undefined), `value.sections[${JSON.stringify(repo)}].value.impact`, false, mode === "full"));
}

function workspaceSnapshotGuide(fact: Fact<WorkspaceImpactValue> & { status: "complete" | "partial" }, context?: RenderContext): string {
  const { value } = fact;
  return impactSnapshotGuide(fact.snapshot, value.trigger.mergeBase, context, Object.values(value.sections).some((section) => section.status !== "unknown" && section.value.impact?.modules?.modules.some((module) => module.snapshot === "base")));
}

/**
 * Summary and details carry no fact JSON, so JSON paths belong to the guide of `answer.json`, and each omitted category
 * already names what recovers it; the text keeps only the coordinates a follow-up query needs.
 */
function textModeGuide(coordinates: readonly string[]): string[] {
  return ["Investigation guide:", ...coordinates];
}

export function renderImpact(fact: Fact<ImpactValue>, detail: RenderDetail = "summary", context?: RenderContext): string {
  if (detail === "full") return (fact.status === "unknown" ? unknownImpactGuide(fact, detail, context) : localImpactGuide(fact, context)).join("\n");
  const lines = [write(presentImpact(fact, fact.status !== "unknown" && literalHandlers(fact.value, { kind: "local" }, context)), detail).text];
  if (fact.status === "unknown") return [...lines, ...unknownImpactGuide(fact, detail, context)].join("\n");
  lines.push(...impactGuidance(fact.value, { kind: "local" }, context), ...cutCoordinates(cutsOf(fact), { kind: "fact" }, detail, context), ...walkBoundRemedies(cutsOf(fact), fact.inputs.declaredConfig.walk), ...(fact.status === "partial" || fact.value.modules !== undefined || fact.value.entrypoints.some((entrypoint) => entrypoint.seeds.length > 1) || fact.value.symbols.some((symbol) => symbol.depth > 1 || symbol.via?.basis === "contains" || symbol.via?.basis === "dispatch") ? textModeGuide(localQueryCoordinates(fact, context, detail)) : []));
  return lines.join("\n");
}

/** Importer-specific wording; the shared policy supplies general mode conventions. */
function importerPathRecovery(): string {
  return '    File paths omitted; use mode: "details" to list them, or answer.json for the original structured fact.';
}

function importerFiles(entry: ImportedFile, detail: RenderDetail): { lines: string[]; omitted: boolean; listed: boolean } {
  const modules: readonly (readonly [string, readonly string[] | undefined])[] = [
    ["importers", entry.importers], ["reexporters", entry.reexporters], ["dynamic importers", entry.dynamicImporters], ["type importers", entry.typeImporters],
  ];
  const modulePaths = new Set(modules.flatMap(([, files]) => files ?? []));
  const memberships = new Map<string, string[]>();
  const add = (path: string, label: string, index: number): void => {
    const labels = memberships.get(path) ?? [];
    labels.push(`${label}[${index}]`);
    memberships.set(path, labels);
  };
  for (const [label, files] of modules) files?.forEach((path, index) => add(path, label, index));
  entry.users.forEach((path, index) => add(path, modulePaths.has(path) ? "users" : "additional users", index));
  entry.unresolvedNamers.forEach((path, index) => add(path, memberships.has(path) ? "also unresolved name matches" : "unresolved name matches", index));
  const heading = `    related files (${memberships.size} distinct)`;
  const listing = [...memberships].map(([path, labels]) => {
    const lines = [...new Set(entry.places?.filter((place) => place.file === path).map((place) => place.line) ?? [])].sort((a, b) => a - b);
    return `    ${JSON.stringify(path)}: ${labels.join(", ")}${lines.length ? ` at ${lines.join(", ")}` : ""}`;
  });
  const counts = [
    ...modules.flatMap(([label, files]) => files === undefined ? [] : [`    ${label} (${files.length})`]),
    `    users (${entry.users.length}; ${entry.users.filter((path) => !modulePaths.has(path)).length} additional)`,
    `    unresolved name matches (${entry.unresolvedNamers.length})`,
  ];
  const notes = entry.unresolvedNamers.length === 0 ? [] : ["    Unresolved name matches do not establish additional dependencies."];
  const omitted = detail === "summary" && memberships.size > LISTED_ITEMS;
  return { lines: [heading, ...(omitted ? counts : listing), ...notes], omitted, listed: !omitted && memberships.size > 0 };
}

export function renderImporters(fact: Fact<ImportersValue>, detail: RenderDetail = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : "Select value.files by file; inspect importers and users for recorded links and unresolvedNamers for unconfirmed matches. Inspect places for recorded relationship lines; related files without a place have no recorded line. Inspect cuts for partial results.";
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  let omitted = false;
  let explained = false;
  for (const entry of fact.value.files) {
    const block = importerFiles(entry, detail);
    if (block.listed && !explained) {
      lines.push("  Indices are zero-based positions in each original category; additional users have no module category.");
      explained = true;
    }
    lines.push(`  ${entry.file}`, ...block.lines);
    omitted ||= block.omitted;
  }
  if (omitted) lines.push(importerPathRecovery());
  const entries = fact.value.files;
  const hasPlaces = entries.some((entry) => (entry.places?.length ?? 0) > 0);
  const paths = (entry: ImportedFile): string[] => [...entry.importers, ...(entry.reexporters ?? []), ...(entry.dynamicImporters ?? []), ...(entry.typeImporters ?? []), ...entry.users, ...entry.unresolvedNamers];
  if (!hasPlaces && entries.some((entry) => paths(entry).length > 0)) lines.push("  These relationships are paths only; no relationship line locations were recorded.");
  else if (hasPlaces && entries.some((entry) => paths(entry).some((path) => !entry.places?.some((place) => place.file === path)))) lines.push("  Relationship lines are recorded where a place was read; a related file without one names no recorded line.");
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}

/** Each declaration on its own line, its children under it one level deeper. */
function outlineLines(declarations: readonly OutlineDeclaration[], indent: string): string[] {
  return declarations.flatMap((declaration) => [`${indent}${spanText(declaration.line, declaration.endLine)} ${declaration.name} [${declaration.kind}]${declaration.placement === undefined ? "" : ` (unplaced: ${declaration.placement.reason} at ${declaration.placement.at.line}:${declaration.placement.at.column})`}`, ...outlineLines(declaration.children ?? [], `${indent}  `)]);
}

/**
 * One line per target and statement form, its bindings after a colon: `name:line` when the declaration is in the target
 * file, `name:file:line` when a re-export leads elsewhere, the bare name when no declaration is proven.
 */
function importLines(imports: readonly OutlineImport[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const item of imports) {
    const key = `${importTarget(item)}${item.kind === "reexport" ? " re-export" : ""}${item.form === undefined ? "" : ` ${item.form}`}`;
    const names = groups.get(key) ?? new Set<string>();
    for (const binding of item.bindings) names.add(bindingText(binding, item.target.kind === "repository" ? item.target.file : undefined));
    groups.set(key, names);
  }
  return [...groups].toSorted(([a], [b]) => compareText(a, b)).map(([key, names]) => `      ${key}${names.size === 0 ? "" : `: ${[...names].toSorted(compareText).join(", ")}`}`);
}

/**
 * One line per use: `name → file:line` for a declaration, the package or the global otherwise, then relations and use
 * lines. No use is "nothing" only when no use is unproved.
 */
function useLines(uses: readonly OutlineUse[], unproved: boolean): string[] {
  if (uses.length === 0) return [unproved ? `    ${NO_PROVEN_USE}` : "    uses nothing outside its body"];
  return ["    uses:", ...uses.map((use) => {
    const target = "declaration" in use ? `${use.declaration.name} → ${use.declaration.file}:${use.declaration.line}` : "module" in use ? `${use.module} (package)` : `${use.global} (global)`;
    const at = use.at.length === 0 ? "" : `; at ${[...new Set(use.at.map(({ line }) => line))].join(", ")}`;
    return `      ${target} (${use.relations.join(", ")}${at})`;
  })];
}

function importTarget({ target, specifier }: OutlineImport): string {
  if (target.kind === "repository") return target.file;
  if (target.kind === "external") return `${target.module} (package)`;
  return `${specifier ?? "computed module"} (unresolved: ${target.reason})`;
}

function bindingText({ local, imported, typeOnly, declaration }: OutlineBinding, targetFile: string | undefined): string {
  const name = local === undefined ? imported : local === imported ? local : `${imported} as ${local}`;
  const place = declaration === undefined ? "" : declaration.file === targetFile ? `:${declaration.line}` : `:${declaration.file}:${declaration.line}`;
  return `${typeOnly ? "type " : ""}${name}${place}`;
}

export function renderOutline(fact: Fact<OutlineValue>, detail: RenderDetail = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : fact.value.focus !== undefined ? "Select value.focus: one entry per matched declaration with file, selector, path when its binding is proven (a dotted declaration path), ancestors outermost first (kind, name, line, endLine), declaration (kind, name, line, endLine and children of the same shape), omitted, how many of the file's declarations were left out, and uses, what the declaration's own body uses outside itself in order of first use: a declaration (file, name, kind, line, endLine), a module (package) or a global, each with relations (edge kinds) and at (use lines and columns); a member on a local value is not a use. Imports are not listed. Inspect value.unheld for unavailable files and cuts when partial: an unresolved-link cut at[0] \"file::path\" names the focused declaration, then each place \"file:line spelling\" of a use no binding proves." : "Select value.files by file; declarations are the top-level ones and contain name, kind, line, endLine and, when a contains edge places declarations inside one, children of the same shape; imports list each module statement or runtime reference with line, endLine, specifier, kind, form, typeOnly, target (repository file, external module, or unresolved with reason) and bindings (local, imported, typeOnly, and the declaration reached with file, name, kind, line, endLine when proven). Inspect value.unheld for unavailable files and cuts when partial: an unresolved-link cut names a binding whose declaration is not proven.";
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  for (const match of fact.value.focus ?? []) {
    lines.push(`  ${match.file}:${match.selector} matches ${match.path ?? `${match.declaration.name} at ${match.declaration.line}-${match.declaration.endLine}`} (${match.omitted} other declarations of the file omitted)`);
    match.ancestors.forEach((ancestor, depth) => lines.push(...outlineLines([ancestor], `    ${"  ".repeat(depth)}`)));
    lines.push(...outlineLines([match.declaration], `    ${"  ".repeat(match.ancestors.length)}`));
    if (match.uses !== undefined) lines.push(...useLines(match.uses, hasUnprovedUses(cutsOf(fact), match.file, match.path ?? match.selector)));
  }
  for (const entry of fact.value.files ?? []) {
    lines.push(`  ${entry.file}`);
    lines.push(...(entry.declarations.length === 0 ? ["    declares nothing"] : outlineLines(entry.declarations, "    ")));
    if (entry.imports.length > 0) lines.push("    imports:", ...importLines(entry.imports));
  }
  if (fact.value.unheld.length > 0) lines.push(`unheld files (${fact.value.unheld.length}): ${fact.value.unheld.join(", ")}; their declarations are unknown.`);
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}

const TRACE_FULL_GUIDE = "Select value.steps in pre-order: id, parent, depth, file, symbol, kind, line, endLine, at (the call in the parent), via, deferred, seen (the id that expanded it), leaves (folded terminal declarations with file, start, end) and external (calls leaving the repository by module), alternatives (every body a body-less method may run, when proven; one expands below it via dispatch) and effects (each HTTP request, published message or data operation a declared client makes in its body: kind http with target method, path and base, kind message with target protocol and destination, or kind data with operation, access and optional proven target, at its line). With workspace, value.links and value.unlinked retain matches at executed effects, and at effects marked deferred (a request inside a function value that a combinator such as defer or switchMap takes, which runs later, if at all; the match then carries deferred: true; a match the workspace sites at an outer caller is also retained when the trace reaches the leaf calls that issue its request, listed in issuedAt), and value.repositorySnapshots pins both endpoints; match basis does not prove host ownership. value.roots lists the root step ids per target; value.readingPlan.ranges lists file, start, end and the step ids each range covers, with the total lines. When partial, an unresolved-link cut is at[0] \"file:line spelling\" followed by its candidates, each \"file::Owner.member\" by containment path.";

const TRACE_BRANCHES = "branches are not evaluated: every call in a body is listed, whichever branch makes it";

function traceRootLines(value: TraceValue): string[] {
  const byId = new Map(value.steps.map((step) => [step.id, step]));
  return [
    `roots (${value.steps.filter((step) => step.parent === undefined).length}):`,
    ...value.roots.map(({ target, steps }) => {
      const roots = steps.map((id) => byId.get(id)!).map((step) => `#${step.id} ${step.symbol} [${step.kind}] ${placeText(step.file, step.line, step.endLine)}`);
      return `  ${target} matches ${steps.length}: ${roots.join(", ")}`;
    }),
  ];
}

/** The ranges to open: one per line in details; in summary one line per file, files in their first appearance. */
function readingPlanLines(value: TraceValue, detail: RenderDetail): string[] {
  const { ranges, lines } = value.readingPlan;
  const span = (start: number, end: number): string => (end === start ? `${start}` : `${start}-${end}`);
  const listed = detail === "details"
    ? ranges.map(({ file, start, end }) => `  ${placeText(file, start, end === start ? undefined : end)}`)
    : [...Map.groupBy(ranges, ({ file }) => file)].map(([file, inFile]) => {
        const count = inFile.reduce((sum, { start, end }) => sum + end - start + 1, 0);
        return `  ${file}: ${inFile.map(({ start, end }) => span(start, end)).join(", ")} (${count} ${count === 1 ? "line" : "lines"})`;
      });
  return [`reading plan (${ranges.length} ${ranges.length === 1 ? "range" : "ranges"}, ${lines} lines):`, ...listed];
}

/** Every effect of the trace, in pre-order, then the requests whose destination is undecided; a trace with neither says so. */
function effectLines(steps: readonly TraceStep[]): string[] {
  const effects = steps.flatMap((step) => (step.effects ?? []).map((effect) => `${effectText(effect)} at ${placeText(step.file, effect.line)}`));
  const requests = steps.flatMap((step) => (step.unresolvedEffects ?? []).map((site) => `${statedRequestText(site)} at ${placeText(step.file, site.line)}${site.deferred === true ? " (deferred)" : ""}`));
  return [
    ...(effects.length === 0 && requests.length > 0 ? [] : [`effects (${effects.length})${effects.length === 0 ? "" : `: ${effects.join(", ")}`}`]),
    ...(requests.length === 0 ? [] : [`unresolved requests (${requests.length}, destination undecided): ${requests.join(", ")}`]),
  ];
}

function externalText(group: ExternalCalls): string {
  return `${group.kind === "import" ? group.module : group.kind}: ${group.names.join(", ")}`;
}

/** Each step on its own line under its parent: the call's line, then its span when its file is not its parent's. */
function traceTreeLines(steps: readonly TraceStep[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps.flatMap((step) => {
    const indent = `  ${"  ".repeat(step.depth)}`;
    const parent = step.parent === undefined ? undefined : byId.get(step.parent);
    const span = parent?.file === step.file ? "" : ` (${placeText(step.file, step.line, step.endLine)})`;
    const notes = [step.via !== undefined && step.via !== "call" ? step.via : undefined, step.deferred ? "deferred" : undefined, step.seen === undefined ? undefined : `seen #${step.seen}`].filter((note) => note !== undefined);
    const leaves = step.leaves ?? [];
    return [
      `${indent}#${step.id} ${step.at?.line ?? step.line} ${step.symbol}${step.parent === undefined ? ` [${step.kind}]` : ""}${span}${notes.length === 0 ? "" : ` ${notes.join(", ")}`}`,
      ...(leaves.length === 0 ? [] : [`${indent}  leaves: ${leaves.map((leaf) => (leaf.deferred ? `${leaf.symbol} (deferred)` : leaf.symbol)).join(", ")}`]),
      ...(step.external === undefined ? [] : [`${indent}  external: ${step.external.map(externalText).join("; ")}`]),
      ...(step.effects === undefined ? [] : [`${indent}  effects: ${step.effects.map((effect) => `${effectText(effect)} at ${effect.line}`).join("; ")}`]),
      ...(step.unresolvedEffects === undefined ? [] : [`${indent}  unresolved requests (URL expressions, not proven destinations):`, ...step.unresolvedEffects.map((site) => `${indent}${unresolvedLine(site, "details")}`)]),
      ...(step.alternatives === undefined ? [] : [`${indent}  dispatch alternatives (${step.alternatives.length}): ${step.alternatives.map((body) => placeText(body.file, body.start, body.end)).join(", ")}`]),
    ];
  });
}

/** An unresolved call of a trace: why it is cut, the place and spelling leading the cut, then its candidates. */
function tracePlaceOf(cut: Cut): { why: string; file: string; line: string; spelling: string; candidates: readonly string[]; cause: readonly string[] } {
  const [place = "", ...candidates] = cut.at;
  const { file, line, reason } = placeOf(place);
  return { why: cutReasonText(cut), file, line, spelling: reason, candidates, cause: cut.cause ?? [] };
}

type TracePlace = ReturnType<typeof tracePlaceOf>;

const TRACE_PLACES_OMITTED = '    Call places omitted; mode "details" lists them, answer.json gives the structured fact.';

/** The name a call ends with, so calls of one member through different receivers share a line. */
function trailingName(spelling: string): string {
  return /[\w$]+$/.exec(spelling.trimEnd())?.[0] ?? spelling.trim();
}

/** The constructs a cut's cause places stand at, each counted with the files it sits in. */
function causeCounts(cause: readonly string[]): string {
  return [...Map.groupBy(cause.map(placeOf), ({ reason }) => reason)]
    .toSorted(([a], [b]) => compareText(a, b))
    .map(([construct, places]) => {
      const files = new Set(places.map(({ file }) => file)).size;
      return `${places.length} ${construct} in ${files} ${files === 1 ? "file" : "files"}`;
    })
    .join(", ");
}

/** A cause of several cuts, by its places, numbered in the order its first cut appears. */
function sharedCauses(places: readonly TracePlace[]): ReadonlyMap<string, number> {
  const counts = Map.groupBy(places.filter(({ cause }) => cause.length > 0), ({ cause }) => cause.join(", "));
  return new Map([...counts].filter(([, sharing]) => sharing.length > 1).map(([cause], index) => [cause, index + 1]));
}

/** Each unresolved call with every candidate and, where the cut has one, the places of its cause, or the number of the cause several cuts share. */
function tracePlaceLine(place: TracePlace, shared: ReadonlyMap<string, number>): string {
  const number = shared.get(place.cause.join(", "));
  const cause = place.cause.length === 0 ? "" : `; cause: ${number === undefined ? place.cause.join(", ") : `#${number}`}`;
  return `    ${place.why}: ${place.file}:${place.line} ${place.spelling}${place.candidates.length === 0 ? "" : ` (${place.candidates.join(", ")})`}${cause}`;
}

/** What declares the library signatures that settle a function value passed to a library call (ADR-0063, ADR-0044 decision 5), named on a cut with one implementation, the one that releases. */
const JDK_NEXT_STEP = '  next: declare a JDK (--jdk on ye-ast trace or ye-ast mcp) so the function values of undeclared library calls are read; a one-implementation port is followed once none of them may implement it';

/** A candidate without its file: `src/a.ts::Store.get` reads `Store.get`. */
function candidatePath(candidate: string): string {
  const separator = candidate.indexOf("::");
  return separator === -1 ? candidate : candidate.slice(separator + 2);
}

/** The causes whose calls a summary counts as one line when that is shorter than a line per name: template expressions the page plan does not cover, and receivers the walk could not prove. */
const COUNTED_CAUSES: readonly string[] = ["page-unplanned", "receiver-unproven"];

/**
 * One line per reason, trailing name and candidate set, most calls first, then by name: why they are cut, its calls, its
 * files and its candidates by containment path, counted when that is shorter or when two candidates share a path. The
 * calls of a counted cause collapse to one line of calls, files and names when that line is shorter than theirs.
 */
function traceCallGroupLines(places: readonly TracePlace[]): string[] {
  const named = [...Map.groupBy(places, (place) => JSON.stringify([place.why, trailingName(place.spelling), place.candidates.toSorted(compareText), causeCounts(place.cause)]))]
    .map(([key, inGroup]) => ({ key, why: inGroup[0]!.why, name: trailingName(inGroup[0]!.spelling), candidates: inGroup[0]!.candidates.toSorted(compareText), cause: causeCounts(inGroup[0]!.cause), calls: inGroup.length, files: new Set(inGroup.map(({ file }) => file)).size }))
    .map((group) => {
      const shown = [...new Set(group.candidates.map(candidatePath))].sort(compareText);
      const listed = shown.join(", ");
      const counted = `${group.candidates.length} ${group.candidates.length === 1 ? "candidate" : "candidates"}`;
      const listable = shown.length === group.candidates.length && preferShorterText(listed, counted) === listed;
      const could = group.candidates.length === 0 ? "" : listable ? ` → could be: ${listed}` : ` → ${counted}`;
      return { ...group, line: `    ${group.why}: ${group.name} ×${group.calls} in ${group.files} ${group.files === 1 ? "file" : "files"}${could}${group.cause === "" ? "" : `; cause: ${group.cause}`}` };
    });
  const collapsed = [...Map.groupBy(places.filter(({ why }) => COUNTED_CAUSES.includes(why.split(" ")[0]!)), (place) => place.why)].flatMap(([why, inCause]) => {
    const files = new Set(inCause.map(({ file }) => file)).size;
    const names = new Set(inCause.map(({ spelling }) => trailingName(spelling))).size;
    const line = `    ${why}: ${inCause.length} calls in ${files} ${files === 1 ? "file" : "files"}, ${names} ${names === 1 ? "name" : "names"}`;
    const own = named.filter((group) => group.why === why);
    return own.length > 1 && size([line]) < size(own.map((group) => group.line)) ? [{ key: why, why, name: "", calls: inCause.length, line, replaces: own }] : [];
  });
  const replaced = new Set(collapsed.flatMap(({ replaces }) => replaces));
  return [...named.filter((group) => !replaced.has(group)), ...collapsed]
    .sort((a, b) => b.calls - a.calls || compareText(a.name, b.name) || compareText(a.key, b.key))
    .map(({ line }) => line);
}

/** The calls no rule settled: grouped by call in summary, then the modes that list each place; one per line with every candidate in details. */
function traceCutLines(cuts: readonly Cut[], detail: RenderDetail): string[] {
  const unresolved = cuts.filter((cut) => cut.kind === "unresolved-link").map(tracePlaceOf);
  const lines = cutLines(cuts.filter((cut) => cut.kind !== "unresolved-link"), detail);
  if (unresolved.length === 0) return lines.length === 0 ? [] : [CUTS, ...lines];
  const shared = sharedCauses(unresolved);
  const places = detail === "details" ? [...unresolved.map((place) => tracePlaceLine(place, shared)), ...[...shared].map(([cause, number]) => `    cause #${number}: ${cause}`)] : [...traceCallGroupLines(unresolved), TRACE_PLACES_OMITTED];
  const followable = cuts.some((cut) => cut.at.length === 2 && cut.cause?.some((place) => placeOf(place).reason === FUNCTION_VALUE_AWAITS_JDK));
  return [CUTS, ...lines, `  unresolved-link (${unresolved.length} ${unresolved.length === 1 ? "call" : "calls"}):`, ...places, ...(followable ? [JDK_NEXT_STEP] : [])];
}

export function renderTrace(fact: Fact<TraceValue>, detail: RenderDetail = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : TRACE_FULL_GUIDE;
  const lines = headerLines(fact);
  if (fact.status === "unknown") return lines.join("\n");
  lines.push(...traceRootLines(fact.value), ...traceSettledLine(fact.value), ...effectLines(fact.value.steps), TRACE_BRANCHES, ...readingPlanLines(fact.value, detail));
  if (detail === "details") lines.push("steps:", ...traceTreeLines(fact.value.steps));
  if (fact.value.repositorySnapshots !== undefined) lines.push(...linkMapLines(fact.value.links ?? [], fact.value.unlinked ?? [], detail, "links from placed trace requests"));
  lines.push(...traceCutLines(cutsOf(fact), detail));
  return lines.join("\n");
}

/** One line when requested ranges held no token (ADR-0043 decision 3). */
function traceSettledLine(value: TraceValue): string[] {
  return value.settled === undefined ? [] : [`${value.settled.length} requested ranges hold no token`];
}

/** What a line says of a request whose path the snapshot states after a base URL it does not decide (ADR-0054). */
export const BASE_UNDECIDED = "base URL undecided";

/** One link as every answer lists it: its number, both ends, the basis and what the answer adds about how it was reached. */
function linkLine(link: TraceLinked<Link>, number: number | undefined, reached = ""): string {
  const confidence = link.confidence < 1 ? `, confidence ${link.confidence}` : "";
  const profiles = link.profiles === undefined ? "" : `, under ${link.profiles.join(", ")}`;
  const authority = link.authority === undefined ? "" : `, ${BASE_UNDECIDED}`;
  const drift = driftText(link.drift);
  return `  - ${number}. ${link.from.repo}:${placeText(link.from.file, link.from.line)} ${link.from.symbol} -> ${link.to.repo} ${link.to.name} -> ${handlerText(link.to.handler)} (${link.basis}${confidence}${profiles}${authority}${drift === "" ? "" : `, ${drift}`}${link.deferred === true ? ", runs later, if at all" : ""}${issuedText(link.issuedAt)}${reached})`;
}

/** The leaf calls a trace reached that issue a request the workspace sites at an outer caller. */
function issuedText(leaves: readonly IssuingPlace[] | undefined): string {
  return leaves === undefined ? "" : `, issued at ${leaves.map(({ file, line }) => placeText(file, line)).join(", ")}`;
}

function impactedLinkLine({ link, direction, reach, operations }: ImpactedLink, indexes: ReadonlyMap<string, number>): string {
  const chain = reach.length === 0 ? "" : `; reach: ${reach.map((id) => indexes.get(id) ?? id).join(", ")}`;
  return `${linkLine(link, indexes.get(link.id), `, ${direction}${chain}`)}${(operations ?? []).map((operation) => `; calls the operation ${changedContractText(operation)}`).join("")} [linkId ${JSON.stringify(link.id)}]`;
}

/** Whether an answer prints each link of a list, numbered, rather than counting them: the rule a candidate pointing into the list shares. */
const linksListed = (links: readonly Link[], detail: RenderDetail): boolean => detail === "details" || links.length <= LISTED_ITEMS;

/**
 * The links of a workspace map: each one in details, and in summary up to the listed bound, beyond which the count per
 * caller, callee and transport (RFC-0017); the call sites the join reached without a link are always listed.
 */
function linkMapLines(links: readonly TraceLinked<Link>[], unlinked: readonly TraceLinked<UnlinkedCallSite>[], detail: RenderDetail, label = "links between the repositories read"): string[] {
  const literal = links.map((link, index) => linkLine(link, index + 1));
  const pairs = new Map<string, number>();
  for (const { from, to, transport } of links) pairs.set(`${from.repo} -> ${to.repo} ${transport}`, (pairs.get(`${from.repo} -> ${to.repo} ${transport}`) ?? 0) + 1);
  const counted = [...[...pairs].map(([pair, count]) => `  - ${pair}: ${count}`), `  ${categoryRecovery({ details: "lists each link" })}`];
  const listed = linksListed(links, detail) ? literal : counted;
  return [
    `${label} (${links.length}):`, ...listed,
    ...(unlinked.length === 0 ? [] : [`call sites the join reached without a link (${unlinked.length}):`, ...unlinked.map(({ from, transport, method, outcome, name, repos, routes, deferred, issuedAt }) => `  - ${from.repo}:${placeText(from.file, from.line)} ${from.symbol} ${transport}${method === undefined ? "" : ` ${method}`} ${name}: ${outcome}${repos === undefined ? "" : ` (${repos.join(", ")})`}${routes === undefined ? "" : ` routes ${routes.join(", ")}`}${deferred === true ? " (runs later, if at all)" : ""}${issuedText(issuedAt)}`)]),
  ];
}

function callSiteLine(site: CallSite): string {
  const { target } = site;
  const requests = statedRequestsOf(site).map(({ method, path }) => `${method} ${path}`);
  const named = requests.length > 0 ? requests.join(", ") : target.status === "complete" && "destination" in target.value ? `${target.value.protocol} ${target.value.destination}` : "unknown";
  return `      - ${placeText(site.file, site.line)} ${site.symbol} -> ${named}${requests.length > 0 && httpTargetOf(site) === undefined ? ` (${BASE_UNDECIDED})` : ""}`;
}

function callSiteBlock(label: string, sites: readonly CallSite[]): string[] {
  return sites.length === 0 ? [] : [`    ${label} (${sites.length}):`, ...sites.map(callSiteLine)];
}

function unrelatedText({ unmatched, external, unresolved }: NonNullable<RepoImpact["unrelated"]>): string {
  return [["unmatched", unmatched], ["external", external], ["unresolved", unresolved]].filter(([, count]) => count !== 0).map(([label, count]) => `${count} ${label}`).join(", ");
}

function repoImpactLines(repo: string, section: Fact<RepoImpact>, detail: RenderDetail, context?: RenderContext): string[] {
  if (section.status === "unknown") return [`  ${repo}: unknown (${section.reason})`];
  const { value } = section;
  return [
    `  ${repo}: ${section.status}`,
    ...value.reads.flatMap(({ kind, fact }) => fact.status === "unknown" ? [`    ${kind}: unknown (${fact.reason})`] : []),
    ...callSiteBlock("call sites that land in what the walk reached", value.callSites),
    ...callSiteBlock("unmatched", value.unmatched),
    ...callSiteBlock("external", value.external),
    ...(value.unrelated === undefined ? [] : [`    not in this question: ${unrelatedText(value.unrelated)}; ye_ast_workspace lists them`]),
    ...(value.unresolved.length === 0 ? [] : [`    unresolved call sites (${value.unresolved.length}):`, ...unresolvedListing(value.unresolved, detail).map((line) => `  ${line}`)]),
    ...inheritedBlock(value.inherited ?? [], detail, "    "),
  ];
}

export function renderWorkspaceImpact(fact: Fact<WorkspaceImpactValue>, detail: RenderDetail = "summary", context?: RenderContext): string {
  if (detail === "full") return (fact.status === "unknown" ? unknownImpactGuide(fact, detail, context) : [...workspaceImpactGuide(fact, context), REQUEST_SITE_GUIDE]).join("\n");
  const literalOwners = new Set(fact.status === "unknown" ? [] : Object.entries(fact.value.sections).flatMap(([repo, section]) => section.status !== "unknown" && section.value.impact !== undefined && literalHandlers(section.value.impact, { kind: "section", repo }, context) ? [repo] : []));
  const presentation = presentWorkspaceImpact(fact, literalOwners);
  const lines = [write({ ...presentation, sections: presentation.sections.filter((section) => section.role === "answer") }, detail).text];
  if (fact.status === "unknown") return [...lines, ...unknownImpactGuide(fact, detail, context)].join("\n");
  const { value } = fact;
  if (context?.recovery?.status === "unavailable") lines.push(`Recovery unavailable (${context.recovery.reason}); recorded coordinates do not establish an executable replay.`);
  lines.push(counted("repositories", value.repositorySnapshots.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  lines.push(sourceLine(value.workspace.source));
  lines.push(`bound repository: ${value.trigger.repo}`);
  lines.push(`gateway prefixes (${value.workspace.gateways.length}):`, ...value.workspace.gateways.map(({ prefix, repo, basis }) => `  - ${prefix} -> ${repo} (${basis})`));
  const stale = value.workspace.unmatchedGateways;
  if (stale.length > 0) lines.push(`declared gateways that matched nothing (${stale.length}):`, ...stale.map(({ prefix, repo }) => `  - ${prefix} -> ${repo}`));

  const linkIndexes = new Map(value.links.map(({ link }, index) => [link.id, index + 1]));
  if (value.links.some(({ direction }) => direction === "downstream")) lines.push("Downstream links identify invoked destinations; a destination is not necessarily affected by the change.");
  lines.push(`links across and inside repositories (${value.links.length}):${value.links.some(({ reach }) => reach.length > 0) ? " reach lists link numbers nearest to the change first" : ""}`, ...value.links.map((link) => impactedLinkLine(link, linkIndexes)));
  lines.push("per repository:", ...value.workspace.repos.flatMap((repo) => (value.sections[repo] === undefined ? [] : repoImpactLines(repo, value.sections[repo] as Fact<RepoImpact>, detail, context))));
  const unserved = counted("no local repository serves", value.workspace.unserved);
  const unservedSummary = `no local repository serves (${value.workspace.unserved.length}): ${categoryRecovery({ answerJson: "includes all" })} names`;
  lines.push(value.workspace.unserved.length > 0 && size([unservedSummary]) <= size([unserved]) ? unservedSummary : unserved);
  const remainingText = write({ status: [], snapshots: [], sections: presentation.sections.filter((section) => section.role !== "answer") }, detail).text;
  if (remainingText !== "") lines.push(remainingText);
  if (value.workspace.unserved.length > 0 || stale.length > 0) lines.push(DECISIONS_HINT);
  lines.push(...cutCoordinates(cutsOf(fact), { kind: "fact" }, detail, context), ...walkBoundRemedies(cutsOf(fact), fact.inputs.declaredConfig.walk));
  for (const repo of value.workspace.repos) {
    const section = value.sections[repo];
    if (section === undefined || section.status === "unknown") continue;
    if (section.value.impact !== undefined) lines.push(...impactGuidance(section.value.impact, { kind: "section", repo }, context));
    lines.push(...cutCoordinates(cutsOf(section), { kind: "section", repo }, detail, context), ...walkBoundRemedies(cutsOf(section), section.inputs.declaredConfig.walk));
  }

  const recorded = value.links.length > 0 || Object.values(value.sections).some((section) => section.status !== "unknown" && section.value.impact !== undefined && impactHasRecords(section.value.impact));
  if (fact.status === "partial" || recorded) lines.push(...textModeGuide([...(crossRepository(value) ? [workspaceOwnerGuide(detail)] : []), ...workspaceBaseModuleGuides(value, detail), workspaceSnapshotGuide(fact, context)]));
  return lines.join("\n");
}

/** The line that opens the text of a live answer the working tree has moved past. */
export function renderStale(notice: LiveStaleNotice): string {
  return `stale: the working tree changed after this answer, which reflects state ${notice.stateId}: ${notice.changed.join(", ")}`;
}

/** A remote the query refreshed: whether it verified it, and why not. */
function remoteLine({ repo, url, freshness }: WorkspaceRefresh["freshness"][number]): string {
  if (freshness.status === "verified") return `remote: ${repo} ${url} verified`;
  const last = freshness.lastVerifiedAt === undefined ? "" : `, last verified ${freshness.lastVerifiedAt}`;
  return `remote: ${repo} ${url} unverified (${freshness.reason}${last})${freshness.detail === undefined ? "" : `: ${freshness.detail}`}`;
}

/** The sha a refreshed repository was read at, and the rule step that chose it. */
function pinnedLine({ repo, asked, step, consulted, tie, sha }: RepositoryResolution): string {
  const asking = asked === undefined ? "" : ` asked ${asked}`;
  const refs = consulted.length === 0 ? "" : ` (consulted ${consulted.map((ref) => (ref.sha === undefined ? ref.branch : `${ref.branch} ${ref.sha}`)).join(", ")})`;
  const tied = tie === undefined ? "" : ` (tie: ${tie.join(", ")})`;
  return `pinned: ${repo}${asking} by ${step} -> ${sha ?? "unpinned"}${refs}${tied}`;
}

/** The response-level lines a refreshed answer opens with, before the fact. */
export function renderRefresh(refresh: WorkspaceRefresh): string[] {
  return [...refresh.freshness.map(remoteLine), ...refresh.resolution.map(pinnedLine)];
}

const REQUEST_SITE_GUIDE = "A wrapper request is sited at the call supplying its parameters; the stated request names the path written in code. For a suffix-only match, inspect the gateway prefix or server configuration that would declare the full path.";

/** The unresolved call sites under the file that holds them, sorted, each with the request it writes when the code states it. */
function unresolvedFiles(sites: readonly UnresolvedCallSite[], detail: RenderDetail): string[] {
  const sorted = [...sites].toSorted(compareUnresolvedCallSites);
  return [...Map.groupBy(sorted, (site) => site.path)].flatMap(([path, inFile]) => [
    `    ${path}`,
    ...[...Map.groupBy(inFile, (site) => `${site.reason}${site.diagnostic === undefined ? "" : `/${site.diagnostic.cause}`}${site.diagnostic?.source === undefined ? "" : ` source=${site.diagnostic.source}`}`)].flatMap(([reason, group]) => [
      ...(detail === "details" ? [`      ${reason}:`] : []),
      ...group.map((site) => unresolvedLine(site, detail)),
    ]),
  ]);
}

function unresolvedListing(sites: readonly UnresolvedCallSite[], detail: RenderDetail): string[] {
  return [...unresolvedFiles(sites, detail), ...(sites.length === 0 ? [] : [`    ${REQUEST_SITE_GUIDE}`])];
}

function unresolvedLine(site: UnresolvedCallSite, detail: RenderDetail): string {
  const through = site.via === undefined ? "" : `, through ${site.via}`;
  const stated = site.stated === undefined ? "" : ` ${statedRequestText(site)}`;
  const evidence = detail === "details" ? ` <- ${site.evidence.map(evidenceText).join(", ")}${site.diagnostic?.unreadableSources === undefined ? "" : `; unreadable libraries: ${site.diagnostic.unreadableSources.map(evidenceText).join(", ")}`}${site.diagnostic?.alternatives === undefined ? "" : `; chosen at run time, declared alternatives: ${site.diagnostic.alternatives.join(", ")}`}` : ` ${unresolvedLabel(site)}`;
  return `      ${spanText(site.line, site.endLine)} ${site.symbol} (${site.transport}${through}${site.deferred === true ? ", deferred" : ""})${stated}${evidence}`;
}

function inheritedCallerLine({ path, line, endLine, symbol, stated, deferred, through }: InheritedCaller, transport: InheritedGap["transport"], detail: RenderDetail): string {
  const request = stated === undefined ? "" : ` ${statedRequestText({ stated, transport, symbol })}`;
  const via = detail === "details" && through !== undefined ? ` <- ${through.map(evidenceText).join(", ")}` : "";
  return `${placeText(path, line, endLine)} ${symbol}${deferred === true ? " (deferred)" : ""}${request}${via}`;
}

/**
 * The gaps a repository's calls inherit, one entry per cause: the cause once, how many calls and files inherit it, and
 * the calls themselves in details (a summary lists those that state a request).
 */
function inheritedBlock(gaps: readonly InheritedGap[], detail: RenderDetail, indent: string): string[] {
  if (gaps.length === 0) return [];
  const calls = inheritedCallerCount(gaps);
  return [`${indent}inherited gaps (${calls} ${calls === 1 ? "call" : "calls"} from ${gaps.length} ${gaps.length === 1 ? "cause" : "causes"}):`, ...inheritedCauses(gaps, detail, `${indent}  `)];
}

function inheritedCauses(gaps: readonly InheritedGap[], detail: RenderDetail, indent: string): string[] {
  const unlisted = detail !== "details" && gaps.some(({ callers }) => callers.some(({ stated }) => stated === undefined));
  return [
    ...gaps.flatMap((gap) => {
      const files = new Set(gap.callers.map(({ path }) => path)).size;
      const through = gap.via === undefined ? "" : `, through ${gap.via}`;
      const listed = detail === "details" ? gap.callers : gap.callers.filter(({ stated }) => stated !== undefined);
      return [
        `${indent}${evidenceText(gap.causePlace)} ${unresolvedLabel(gap)} (${gap.transport}${through}): ${gap.callers.length} ${gap.callers.length === 1 ? "call" : "calls"} in ${files} ${files === 1 ? "file" : "files"}`,
        ...listed.map((caller) => `${indent}  ${inheritedCallerLine(caller, gap.transport, detail)}`),
      ];
    }),
    ...(unlisted ? [`${indent}calls not listed; ${categoryRecovery({ details: "lists every call", answerJson: "retains all recorded calls" })}`] : []),
  ];
}

export function renderWorkspace(fact: Fact<Omit<WorkspaceValue, "repositories">>, detail: RenderDetail = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : "Match value.sections by repository and check each section status, reason and cuts; value.repositorySnapshots identifies each revision. Inspect value.candidates by name and repo for basis and evidence, value.unserved for unmatched names, value.undecidedBase for the names written only after an undecided base, value.links for the links between repositories, value.internalLinks for those inside one repository and value.unlinked for the call sites without one. " + REQUEST_SITE_GUIDE;
  return [write(presentWorkspace(fact), detail).text, ...(fact.status === "unknown" ? [] : [...(fact.value.unserved.length === 0 ? [] : [DECISIONS_HINT]), REQUEST_SITE_GUIDE])].join("\n");
}

function repositoryEvidenceText(evidence: RepositoryEvidence): string {
  return `${evidence.repo}:${evidenceText(evidence)}`;
}

export function renderDecisions(fact: Fact<DecisionValue>, detail: RenderDetail = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : "Select value.decisions by kind and subject; inspect evidence, options[].basis and options[].recommended; value.undecidedBase lists the names written only after an undecided base, which raise no decision. Match evidence repositories to value.repositories snapshots.";
  return write(presentDecisions(fact), detail).text;
}

const CONSEQUENCES_FULL_GUIDE = "Match value.answers by index (the order asked, or sorted by operation and property for a change) and check each answer's status, reason and cuts; findings[].value.chain and verdict.witness hold the chains and witnesses, and an unknown finding carries its reason and places. A change's value.change.derivation holds every classified difference (rule, level, operation, property, places) and the derivation frontiers; answers[].derivedFrom.rules names the rules a derived answer follows; value.repositorySnapshots names the snapshot of every repository read.";

/** The counted text when it is no longer than listing what it counts, the listing otherwise; a tie keeps the count (RFC-0017 section 1). Details always lists. */
function elided(counts: readonly string[], listing: readonly string[], detail: RenderDetail): string[] {
  return detail === "details" || size(listing) < size(counts) ? [...listing] : [...counts];
}

function hypothesisText(hypothesis: HypothesisAnswer["hypothesis"]): string {
  const entries = (Array.isArray(hypothesis.change) ? hypothesis.change : [hypothesis.change]) as readonly unknown[];
  return `${hypothesis.method} ${hypothesis.path} ${hypothesis.target} ${hypothesis.property} ${entries.map((entry) => (typeof entry === "string" ? entry : canonicalJson(entry))).join(" + ")}`;
}

function countedBy(labels: readonly string[]): string {
  return [...Map.groupBy(labels, (label) => label)].toSorted(([a, ofA], [b, ofB]) => ofB.length - ofA.length || compareText(a, b)).map(([label, group]) => `${group.length} ${label}`).join(", ");
}

const findingKind = (finding: ConsequenceFinding<UseConsequence | ProducerConsequence>): string =>
  finding.status === "unknown" ? `unknown (${finding.reason})` : finding.value.verdict.kind;

/** How an answer names the empty access path, which is the body itself. */
export const ROOT_PATH_TEXT = "(whole body)";
const accessPathText = (path: string): string => (path === "" ? ROOT_PATH_TEXT : path);

/** The places of a finding, the first ones listed and the rest counted with the mode that lists every one. */
function findingPlaces(evidence: readonly RepositoryEvidence[]): string {
  const left = evidence.length - LISTED_ITEMS;
  return `${evidence.slice(0, LISTED_ITEMS).map(repositoryEvidenceText).join(", ")}${left > 0 ? `, and ${left} more places (answer.json lists every one)` : ""}`;
}

function findingLine(finding: ConsequenceFinding<UseConsequence | ProducerConsequence>): string {
  const places = findingPlaces(finding.evidence);
  if (finding.status === "unknown") return `    - unknown (${finding.reason})${places === "" ? "" : ` at ${places}`}`;
  const { value } = finding;
  const call = `${value.link.call.file}:${value.link.call.line} ${value.link.call.symbol} -> ${value.link.handler.repo}:${placeText(value.link.handler.path, value.link.handler.line)} ${value.link.handler.symbol}`;
  if ("operation" in value) {
    const { verdict } = value;
    return `    - use ${verdict.kind}${verdict.kind === "review" ? ` (${verdict.reason})` : ""} at ${places}; reads ${accessPathText(value.path)}, changed ${accessPathText(value.changed)}; via ${call}${verdict.kind === "incompatible" ? `; witness ${verdict.witness}` : ""}`;
  }
  const { verdict } = value;
  const witness = verdict.kind === "incompatible" ? `; witness ${verdict.witness.value} at ${verdict.witness.at.path}:${verdict.witness.at.line}` : "";
  return `    - producer ${verdict.kind}${verdict.kind === "review" ? ` (${verdict.reason})` : ""} at ${places || value.repo}; writes ${accessPathText(value.path)}; via ${call}${witness}`;
}

/** The line of a finding, or a pointer to the earlier finding it repeats when the pointer is the shorter text. */
function findingListed(finding: ConsequenceFinding<UseConsequence | ProducerConsequence>, label: string, seen: Map<string, string>): string {
  const line = findingLine(finding);
  const key = canonicalJson(finding);
  const first = seen.get(key);
  if (first === undefined) { seen.set(key, label); return line; }
  const pointer = `    - same as ${first}`;
  return size([pointer]) < size([line]) ? pointer : line;
}

function answerLines(answer: HypothesisAnswer, index: number, detail: RenderDetail, seen: Map<string, string>): string[] {
  const head = `  ${index + 1}. ${hypothesisText(answer.hypothesis)}`;
  if (answer.status === "unknown") return [`${head}: unknown (${answer.reason}): ${answer.detail}`];
  const status = answer.status === "partial" ? `partial (cuts: ${cutCounts(answer.cuts)})` : completeText(undecidedOf(answer.findings));
  const open = `${head}: ${status}${answer.silent === undefined ? "" : `; ${answer.silent} silent uses`}`;
  const listing = [open, ...(answer.findings.length === 0 ? ["    (no findings)"] : answer.findings.map((finding, at) => findingListed(finding, `answer ${index + 1}, finding ${at + 1}`, seen)))];
  const counts = [`${open}; ${answer.findings.length === 0 ? "no findings" : `${answer.findings.length} findings: ${countedBy(answer.findings.map(findingKind))}`}${answer.findings.length === 0 ? "" : `; ${categoryRecovery({ details: "lists each with its place", answerJson: "retains the chains and witnesses" })}`}`];
  return elided(counts, listing, detail);
}

function frontierLine(frontier: ChangeFrontier): string {
  const subject = [frontier.operation, frontier.target, frontier.property, frontier.side === undefined ? undefined : `at ${frontier.side}`].filter((part) => part !== undefined && part !== "").join(" ");
  return `    - ${frontier.kind} (${frontier.reason})${subject === "" ? "" : ` ${subject}`}${frontier.detail === undefined ? "" : `: ${frontier.detail}`}${frontier.evidence.length === 0 ? "" : ` at ${frontier.evidence.map(repositoryEvidenceText).join(", ")}`}`;
}

function differenceLine({ level, rule, operation, property, subject, base, head, places }: ClassifiedDifference): string {
  const value = (written: unknown) => (written === undefined ? "absent" : JSON.stringify(written));
  const about = subject === undefined ? "" : base === undefined && head === undefined ? ` (${subject})` : ` (${subject}: ${value(base)} -> ${value(head)})`;
  return `    - ${level} ${rule} ${operation}${property ? ` ${property}` : ""}${about} at ${repositoryEvidenceText((places.head ?? places.base)!)}`;
}

function derivationLines(value: NonNullable<ConsequencesValue["change"]>, detail: RenderDetail): string[] {
  const { derivation } = value;
  const lines = [`change: ${value.base} -> ${value.head} (commits ${value.snapshots.base} -> ${value.snapshots.head})`, "derivation:", ...statusLines(derivation, "  ")];
  if (derivation.status === "unknown") return lines;
  const { differences, frontiers } = derivation.value;
  const classified = [`  differences (${differences.length}): ${countedBy(differences.map(({ level }) => level))}; ${categoryRecovery({ details: "lists each with its rule and place" })}`];
  lines.push(...(differences.length === 0 ? ["  differences (0):"] : elided(classified, [`  differences (${differences.length}):`, ...differences.map(differenceLine)], detail)));
  const counts = [`  frontiers (${frontiers.length}): ${countedBy(frontiers.map((frontier) => `${frontier.kind} (${frontier.reason})`))}; ${categoryRecovery({ details: "lists them with their places" })}`];
  lines.push(...(frontiers.length === 0 ? ["  frontiers (0):"] : elided(counts, [`  frontiers (${frontiers.length}):`, ...frontiers.map(frontierLine)], detail)));
  return lines;
}

/** The undecided findings of every answer, and the reason of the answer or derivation section a section cut names. */
function consequencesStatus(value: ConsequencesValue): StatusContext {
  const sections = new Map<string, { status: string; reason?: string }>(value.answers.map((answer, index) => [`answers.${index}`, answer]));
  if (value.change !== undefined) sections.set("change.derivation", value.change.derivation);
  return {
    undecided: value.answers.reduce((total, answer) => total + (answer.status === "unknown" ? 0 : undecidedOf(answer.findings)), 0),
    unknownSection: (name) => { const section = sections.get(name); return section?.status === "unknown" ? section.reason : undefined; },
  };
}

/** One composite answer: the hypotheses (or the change) of one workspace read, each with its verdicts and the places it could not follow. */
export function renderContractConsequences(fact: Fact<ConsequencesValue>, detail: RenderDetail = "summary"): string {
  if (detail === "full") return fact.status === "unknown" ? "Inspect reason and evidence; the result has no value." : CONSEQUENCES_FULL_GUIDE;
  const lines = headerLines(fact, fact.status === "unknown" ? {} : consequencesStatus(fact.value));
  if (fact.status === "unknown") return lines.join("\n");
  const { value } = fact;
  lines.push(counted("repositories", value.repositorySnapshots.map(({ repo, snapshot }) => `${repo}@${snapshot.kind === "sha" ? snapshot.sha : snapshot.stateId}`)));
  if (value.change !== undefined) lines.push(...derivationLines(value.change, detail));
  const seen = new Map<string, string>();
  lines.push(`answers (${value.answers.length}):`, ...(value.answers.length === 0 ? [NONE] : value.answers.flatMap((answer, index) => answerLines(answer, index, detail, seen))));
  lines.push(...cutsBlock(cutsOf(fact), detail));
  return lines.join("\n");
}
