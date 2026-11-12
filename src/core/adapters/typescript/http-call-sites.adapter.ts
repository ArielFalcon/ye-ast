import ts from "typescript";
import { sourceTree } from "./source-tree.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import { compareCallSites, type CallSite, type CallSiteDiagnostic, type CallSiteReadOptions, type CallSiteReader, type HttpTarget, type PlacedCallSite, type PlacedCallSiteReader, type PlacedOrigin, type StatedRequest } from "../../domain/topology/call-site.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { requestMethodOf } from "../../domain/entrypoints/http-route.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { moduleResolverOf, type ModuleResolver } from "./module-resolver.ts";
import { buildDefines, type BuildDefines } from "./url-define.ts";
import { callUrl, joinedCallUrl, RUN_TIME_HOLE, urlText } from "../../domain/topology/path-template.ts";
import { known, prevailingCause, undecided, undecidedTarget, type Evaluated, type Undecided } from "../../domain/topology/evaluated.ts";
import { injectedClass } from "./angular-injection.ts";
import { RequestValueReading, type ValueUnit } from "./request-value-reading.ts";
import type { FrameworkValueFactory, FrameworkValues } from "../../ports/framework-values.port.ts";
import type { CellFactory, FrameworkValueCells } from "../../ports/framework-cells.port.ts";
import type { DeferredValueReader, FrameworkDeferrals } from "../../ports/framework-deferrals.port.ts";
import type { SourcePosition, SourceSpan } from "../../domain/shared/owning-body.ts";
import { declarationCounts } from "./syntax-names.ts";
import { defaultExportOf } from "./import-bindings.ts";
import { bindingNames, constructorParameters, lineOf, objectOf, ownBindings, propertyOf, sourceBindings, thisClass, typeName, unwrapped } from "./syntax.ts";
import { leafResultOf, memberOf, requestCallOf, requestGapCalls, requestShapeTrace, requestShapeUrls, resultBodyAccess, summariesOf, type RequestCall, type RequestMethod, type SummaryResolver } from "./request-summaries.ts";
import { requestValueSyntax } from "./request-value-syntax.ts";
import { readRequestValue, valueHasParameter, valueUnknown, type RequestValue } from "./request-values.ts";
import { addWrittenRoots, type WrittenRoots } from "./written-roots.ts";
import type { RequestShape, RequestSummary, ResultShape, SummaryGap } from "../../domain/topology/request-summary.ts";
import { ANONYMOUS_DEFAULT, recoveredModuleShape, type ModuleShape } from "./module-shape.ts";
import { createDeclarationLookup, type DeclarationLookup } from "./declaration-lookup.ts";

const HTTP_CLIENT_PACKAGE = "@angular/common/http";
/** A value the snapshot does not decide for no cause more specific than that. */
const UNDECIDABLE: Undecided = undecided("destination-undecidable");
const RUN_TIME: Read = known({ kind: "value" });
/** A class field the code assigns at run time, so no initializer states its value. */
const ASSIGNED_AT_RUN_TIME = Symbol("assigned at run time");
const WRITTEN_FIELDS = new WeakMap<ts.ClassDeclaration, ReadonlySet<string>>();
const VARIABLE_WRITES = new WeakMap<ts.Node, ReadonlyMap<string, VariableWrites>>();
/** What one file declares at its top level, and the classes and enums it holds, as the reader needs them. */
interface FileShape {
  source: ts.SourceFile;
  /** How often each name is declared anywhere in the file. */
  declared: ReadonlyMap<string, number>;
  bindings: ReadonlySet<string>;
  unsafeEncoder: boolean;
  consts: Map<string, ts.Expression>;
  module: ModuleShape;
  imports: ModuleShape["imports"];
  /** What `export default` holds: an expression, or the class or function it declares. */
  defaultExport?: ts.Node;
  classes: Map<string, ts.ClassDeclaration>;
  enums: Map<string, ts.EnumDeclaration>;
}

/** The names the code being evaluated binds at run time, and what the variables its body declares are initialized to. */
interface Scope {
  names: ReadonlySet<string>;
  locals: ReadonlyMap<string, ts.Expression>;
  parameters?: ReadonlyMap<string, number>;
  summary?: true;
  arguments?: ReadonlyMap<ts.ParameterDeclaration, Read>;
}

const NO_SCOPE: Scope = { names: new Set(), locals: new Map() };
const LEXICAL_SCOPES = new WeakMap<ts.Node, Scope>();
const REBOUND_NAMES = new WeakMap<ts.Node, ReadonlySet<string>>();

/** The names the code being evaluated binds at run time: a path part that names one is `{}`, never undecided. */
type RunTime = ReadonlySet<string>;

/**
 * What a path part came down to: the text it states, or a value the code being evaluated fills at run time. A `cut` text
 * stopped at the query or the fragment, so it states the URL only up to there.
 */
type Evaluation = { readonly kind: "text"; readonly text: string; readonly cut?: true; readonly holes?: readonly (number | undefined)[]; readonly encodings?: readonly boolean[] } | { readonly kind: "value"; readonly parameter?: number; readonly encoded?: true };

/** What a path part reads as: an evaluation, or why the snapshot does not decide it. */
type Read = Evaluated<Evaluation>;

type Callee = Awaited<ReturnType<SummaryResolver["calleeOf"]>>;

interface HeldClass {
  shape: FileShape;
  declaration: ts.ClassDeclaration;
}

/** A declaration an import names, with the file that declares it and the exports the resolution visited. */
interface Resolved<T> {
  shape: FileShape;
  declaration: T;
  trail: ReadonlySet<string>;
}

/** How a kind of declaration is found in a file: under the name it declares, or as what `export default` holds. */
interface DeclarationKind<T> {
  named(shape: FileShape, name: string): T | undefined;
  defaulted(node: ts.Node): T | undefined;
}

const CLASSES: DeclarationKind<ts.ClassDeclaration> = { named: (shape, name) => shape.classes.get(name), defaulted: (node) => (ts.isClassDeclaration(node) ? node : undefined) };
const ENUMS: DeclarationKind<ts.EnumDeclaration> = { named: (shape, name) => shape.enums.get(name), defaulted: () => undefined };
const CONSTANTS: DeclarationKind<ts.Expression> = { named: (shape, name) => shape.consts.get(name), defaulted: (node) => (ts.isExpression(node) ? node : undefined) };
const CALLABLES: DeclarationKind<ts.Expression | ts.FunctionDeclaration> = {
  named: (shape, name) => shape.consts.get(name) ?? functionNamed(shape, name),
  defaulted: (node) => (ts.isFunctionDeclaration(node) || ts.isExpression(node) ? node : undefined),
};

interface HeldMethod {
  shape: FileShape;
  method: ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
}

/** A type name as a file writes it: the file's imports decide which class it names. */
interface TypeNamed {
  name: string;
  shape: FileShape;
}

/** A value a name states, the file that declares it, and the names already visited to reach it. */
interface Located<E extends ts.Expression = ts.Expression> {
  shape: FileShape;
  expression: E;
  trail: ReadonlySet<string>;
}

export function createHttpCallSites(values: readonly FrameworkValueFactory[] = [], cells: readonly FrameworkValueCells[] = []): CallSiteReader & PlacedCallSiteReader {
  return { of: async (files, repo, _libraries, options) => (await readPlaced(files, repo, options, values, cells)).map(({ site, column }) => ({ ...site, ...(column === undefined ? {} : { column: column + 1 }) })), placed: (files, repo, _libraries, options) => readPlaced(files, repo, options, values, cells) };
}

/** The export of a package a callee names, when its root is an import of that package nothing in the file rebinds. */
async function packageExportOf(shape: FileShape, callee: ts.Expression, modules: ModuleResolver, written: (source: ts.SourceFile, name: string) => boolean): Promise<CellFactory | undefined> {
  const path: string[] = [];
  let root = callee;
  while (ts.isPropertyAccessExpression(root)) { path.unshift(root.name.text); root = unwrapped(root.expression); }
  if (!ts.isIdentifier(root)) return undefined;
  const imported = shape.imports.get(root.text);
  if (imported === undefined || imported.typeOnly || shape.module.reimported.has(root.text) || shape.declared.has(root.text) || lexicalScope(root).names.has(root.text) || reboundIn(shape.source).has(root.text) || written(shape.source, root.text)) return undefined;
  if (!("external" in await modules.resolve(shape.source.fileName, imported.module))) return undefined;
  return { module: imported.module, path: imported.imported === "*" ? path : [imported.imported, ...path] };
}

/** The function values a listed combinator of a registered vocabulary takes, found where the file imports the combinator from its package. */
export function createDeferredValueReader(deferrals: readonly FrameworkDeferrals[]): DeferredValueReader {
  return (files) => {
    const held = new Map(files.filter((file) => isTypeScriptSource(file.path)).map((file) => [file.path, file]));
    const modules = moduleResolverOf(files);
    const read = new Map<string, Promise<readonly SourceSpan[]>>();
    const spansOf = async (file: SourceFile): Promise<readonly SourceSpan[]> => {
      const shape = describe(file);
      const position = (at: number): SourcePosition => {
        const { line, character } = shape.source.getLineAndCharacterOfPosition(at);
        return { line: line + 1, column: character };
      };
      const spans: SourceSpan[] = [];
      for (const call of calls(shape.source)) {
        const exported = await packageExportOf(shape, unwrapped(call.expression), modules, writesImportedMember);
        const run = exported === undefined ? undefined : deferrals.map((one) => one.runOf(exported)).find((one) => one !== undefined);
        const argument = run === undefined || call.arguments[run.argument] === undefined ? undefined : unwrapped(call.arguments[run.argument]!);
        if (argument !== undefined && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) spans.push({ start: position(argument.getStart(shape.source)), end: position(argument.getEnd()) });
      }
      return spans;
    };
    return {
      of: (file) => {
        const source = held.get(file);
        if (source === undefined || deferrals.length === 0) return Promise.resolve([]);
        if (!read.has(file)) read.set(file, spansOf(source));
        return read.get(file)!;
      },
    };
  };
}

function readerOf(files: readonly SourceFile[], options?: CallSiteReadOptions, values: readonly FrameworkValueFactory[] = [], cells: readonly FrameworkValueCells[] = []): { shapes: ReadonlyMap<string, FileShape>; reader: Reader } {
  const shapes = new Map(files.filter((file) => isTypeScriptSource(file.path)).map((file) => [file.path, describe(file)]));
  const modules = moduleResolverOf(files);
  return { shapes, reader: new Reader(shapes, modules, buildDefines(files), files, options, values, cells) };
}

export function createHttpSummaryResolver(files: readonly SourceFile[], options?: CallSiteReadOptions, values: readonly FrameworkValueFactory[] = [], cells: readonly FrameworkValueCells[] = []): SummaryResolver {
  return readerOf(files, options, values, cells).reader.summaryResolver;
}

/** A call to a wrapper method, and the method it enters. */
export interface WrapperCall {
  function: ts.MethodDeclaration | ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  call: ts.CallExpression;
  forwarded: ts.CallExpression;
}

/** The expression a request carries as its body and the wrapper methods the call enters before it, outermost first. */
export interface RequestBody {
  expression: ts.Expression | undefined;
  wrappers: readonly WrapperCall[];
}

export interface RequestCallLookup {
  at(site: { file: string; line: number; column?: number; symbol: string }): ts.CallExpression | undefined;
  isRequest(call: ts.CallExpression): boolean;
  of(call: ts.CallExpression): ((RequestSummary | { kind: "direct"; result: ResultShape }) & { bodyAccess?: "json" }) | undefined;
  bodyOf(call: ts.CallExpression): RequestBody | undefined;
  bodiesOf(call: ts.CallExpression): readonly RequestBody[];
}

interface PlacedShape {
  shape: RequestShape;
  leaf: ts.CallExpression;
  calls: readonly ts.CallExpression[];
  conditional: boolean;
  bound: boolean;
  targets: readonly { call: ts.CallExpression; key: string }[];
}

async function prepareRequestCalls(files: readonly SourceFile[], options?: CallSiteReadOptions, values: readonly FrameworkValueFactory[] = [], cells: readonly FrameworkValueCells[] = []) {
  const { shapes, reader } = readerOf(files, options, values, cells);
  const summaries = await summariesOf(files, reader.summaryResolver);
  const callSummaries = new Map<ts.CallExpression, RequestSummary>();
  const directResults = new Map<ts.CallExpression, { kind: "direct"; result: ResultShape; bodyAccess?: "json" }>();
  const groups = new Map<ts.CallExpression, readonly { key: string; body: ts.Node | undefined; summary: RequestSummary | undefined }[]>();
  const direct = new Set<ts.CallExpression>();
  const allCalls = [...shapes.values()].flatMap((shape) => calls(shape.source));
  const byLine = new Map<string, ts.CallExpression[]>();
  for (const call of allCalls) {
    const file = call.getSourceFile().fileName;
    const key = `${file}\0${lineOf(call.getSourceFile(), call)}`;
    const onLine = byLine.get(key) ?? [];
    onLine.push(call);
    byLine.set(key, onLine);
    const recognized = requestCallOf(shapes.get(file)!, call);
    if (recognized.kind === "request" || (recognized.kind === "undecided" && await reader.summaryResolver.clientReceiver(file, call))) {
      direct.add(call);
      const result = await leafResultOf(file, call, reader.summaryResolver);
      if (result !== undefined) directResults.set(call, { kind: "direct", result, ...(resultBodyAccess(result) === "json" ? { bodyAccess: "json" as const } : {}) });
    }
    else {
      const callee = await reader.summaryResolver.calleeOf(file, call);
      if (callee !== undefined && !("gap" in callee)) {
        if ("candidates" in callee) groups.set(call, callee.candidates.map((candidate) => ({ key: candidate.key, body: candidate.body, summary: summaries.get(candidate.key) })));
        else {
          const summary = summaries.get(callee.key);
          if (summary !== undefined) callSummaries.set(call, summary);
        }
      }
    }
  }
  const leaves = new Map<ts.CallExpression, PlacedShape[]>();
  const bound = new Map<ts.CallExpression, PlacedShape[]>();
  const bodyChains = new Map<ts.CallExpression, readonly ts.CallExpression[][]>();
  for (const summary of summaries.values()) for (const shape of summary.shapes) {
    const trace = requestShapeTrace(shape);
    if (trace === undefined) continue;
    const outer = trace.allCalls.at(-1);
    if (outer !== undefined) {
      const held = bodyChains.get(outer) ?? [];
      if (!held.some((chain) => chain.length === trace.allCalls.length && chain.every((node, index) => node === trace.allCalls[index]))) bodyChains.set(outer, [...held, [...trace.allCalls]]);
    }
    const list = (trace.bound ? bound : leaves).get(trace.leaf) ?? [];
    if (!list.some((item) => item.shape === trace.selected)) list.push({ shape: trace.selected, leaf: trace.leaf, calls: trace.calls, conditional: trace.conditional, bound: trace.bound, targets: requestShapeTrace(trace.selected)?.targets ?? [] });
    (trace.bound ? bound : leaves).set(trace.leaf, list);
  }
  const placed = new Map<ts.CallExpression, PlacedShape[]>();
  for (const [leaf, candidates] of leaves) {
    const selected = bound.get(leaf) ?? candidates.filter(({ calls }) => calls.length === 1);
    for (const candidate of selected) {
      const call = candidate.calls.at(-1) ?? leaf;
      const list = placed.get(call) ?? [];
      if (!list.some((item) => item.shape === candidate.shape)) list.push(candidate);
      placed.set(call, list);
    }
  }
  const destinations = new Map<PlacedShape, Evaluated<string>>();
  for (const items of placed.values()) for (const item of items) {
    if (item.shape.unresolved !== undefined) { destinations.set(item, { status: "undecided", ...item.shape.unresolved, cause: item.shape.unresolved.cause === "source-not-read" ? "destination-undecidable" : item.shape.unresolved.cause }); continue; }
    if (!startsSegments(item.shape.path)) { destinations.set(item, UNDECIDABLE); continue; }
    const own = callUrl(item.shape.path);
    const base = own.origin === undefined ? await reader.baseOfRequest(item.leaf) : undefined;
    if (base?.status === "undecided") { destinations.set(item, base); continue; }
    const url = base === undefined ? own : joinedCallUrl(base.value, item.shape.path);
    destinations.set(item, known(urlText({ ...url, path: namedHoles(url.path) })));
  }
  const lookup: RequestCallLookup = {
    at(site) {
      const found = (byLine.get(`${site.file}\0${site.line}`) ?? []).filter((call) => {
        const source = call.getSourceFile();
        const at = source.getLineAndCharacterOfPosition(call.getStart(source));
        return source.fileName === site.file && at.line + 1 === site.line && symbolOf(call) === site.symbol && (site.column === undefined || at.character + 1 === site.column) && lookup.isRequest(call);
      });
      return found.length === 1 ? found[0] : undefined;
    },
    isRequest(call) { const summary = callSummaries.get(call); const group = groups.get(call); return direct.has(call) || (summary !== undefined && (summary.shapes.length > 0 || summary.gaps.length > 0)) || (group?.some((candidate) => candidate.body === undefined || candidate.summary === undefined || candidate.summary.shapes.length > 0 || candidate.summary.gaps.length > 0) ?? false); },
    of(call) {
      const directResult = directResults.get(call);
      if (directResult !== undefined) return directResult;
      const single = callSummaries.get(call);
      if (single !== undefined) {
        const occurrences = new Map(single.shapes.map((shape) => {
          const trace = requestShapeTrace(shape);
          const chain = trace?.allCalls ?? [];
          return [JSON.stringify(chain.map((node) => [node.getSourceFile().fileName, node.getStart()])), trace?.leaf] as const;
        }));
        if (occurrences.size > 1) return { ...single, result: { kind: "unknown", cause: "dispatch-disagreement", evidence: [...occurrences.values()].flatMap((leaf) => leaf === undefined ? [] : [{ path: leaf.getSourceFile().fileName, line: lineOf(leaf.getSourceFile(), leaf) }]) } };
        return { ...single, ...(resultBodyAccess(single.result) === "json" ? { bodyAccess: "json" as const } : {}) };
      }
      const group = groups.get(call);
      const selections = placed.get(call);
      if (group === undefined || selections === undefined) return undefined;
      const at = { path: call.getSourceFile().fileName, line: lineOf(call.getSourceFile(), call) };
      const gaps = group.flatMap((candidate) => candidate.body === undefined || candidate.summary === undefined ? [{ cause: "source-not-read" as const, evidence: [at] }] : [...candidate.summary.gaps]);
      if (gaps.length === 0 && groupDisagrees(call, selections, group, destinations)) gaps.push({ cause: "dispatch-disagreement", evidence: [at] });
      const results = group.flatMap((candidate) => candidate.summary === undefined ? [] : [candidate.summary.result]);
      const result = results.length === group.length && results.every((item) => JSON.stringify(item) === JSON.stringify(results[0]) && resultBodyAccess(item) === resultBodyAccess(results[0]!)) ? results[0] : { kind: "unknown" as const, cause: "dispatch-disagreement" as const, evidence: [at] };
      return { shapes: selections.map((item) => item.shape), result: result ?? { kind: "none" }, gaps, ...(result !== undefined && resultBodyAccess(result) === "json" ? { bodyAccess: "json" as const } : {}) };
    },
    bodyOf(call) { const bodies = lookup.bodiesOf(call); return bodies.length === 1 ? bodies[0] : undefined; },
    bodiesOf(call) {
      const chains = bodyChains.get(call);
      if (direct.has(call)) {
        const shape = shapes.get(call.getSourceFile().fileName);
        return shape === undefined ? [] : [{ expression: bodyExpressionOf(shape, call), wrappers: [] }];
      }
      const group = groups.get(call);
      const selected = placed.get(call) ?? [];
      if (chains === undefined || (group !== undefined && groupDisagrees(call, selected, group, destinations))) return [];
      const bodies: RequestBody[] = [];
      for (const chain of chains) {
        const leaf = chain[0];
        const shape = leaf === undefined ? undefined : shapes.get(leaf.getSourceFile().fileName);
        if (leaf === undefined || shape === undefined) return [];
        const wrappers: WrapperCall[] = [];
        for (let index = chain.length - 1; index > 0; index--) {
          const entering = chain[index]!;
          const forwarded = chain[index - 1]!;
          let owner: ts.Node | undefined = forwarded.parent;
          while (owner !== undefined && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner) && !ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) owner = owner.parent;
          if (owner === undefined) return [];
          wrappers.push({ function: owner, call: entering, forwarded });
        }
        bodies.push({ expression: bodyExpressionOf(shape, leaf), wrappers });
      }
      return bodies;
    },
  };
  return { shapes, reader, direct, placed, lookup, groups, destinations };
}

export async function createRequestCallLookup(files: readonly SourceFile[], options?: CallSiteReadOptions, values: readonly FrameworkValueFactory[] = [], cells: readonly FrameworkValueCells[] = []): Promise<RequestCallLookup> {
  return (await prepareRequestCalls(files, options, values, cells)).lookup;
}

async function readPlaced(files: readonly SourceFile[], repo: string, options?: CallSiteReadOptions, values: readonly FrameworkValueFactory[] = [], cells: readonly FrameworkValueCells[] = []): Promise<readonly PlacedCallSite[]> {
  const { shapes, reader: read, direct, placed, lookup, groups, destinations } = await prepareRequestCalls(files, options, values, cells);
  const found: PlacedCallSite[] = [];
  const forwardedLeaves = new Set([...placed.entries()].flatMap(([call, items]) => items.filter((item) => item.leaf !== call).map((item) => item.leaf)));
  const gapCoverage = new WeakMap<SummaryGap, boolean>();
  const gapAtSite = (start: SummaryGap): boolean => {
    const active = new Set<SummaryGap>();
    const stack: { gap: SummaryGap; dependencies?: SummaryGap[]; index: number }[] = [{ gap: start, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (gapCoverage.has(frame.gap)) { active.delete(frame.gap); stack.pop(); continue; }
      if (frame.dependencies === undefined) {
        const nodes = requestGapCalls(frame.gap);
        if (nodes === undefined || nodes.size === 0) { gapCoverage.set(frame.gap, false); continue; }
        active.add(frame.gap);
        const dependencies: SummaryGap[] = [];
        for (const node of nodes) {
          const summary = lookup.of(node);
          const matching = summary !== undefined && !("kind" in summary) ? summary.gaps.filter((item) => item.cause === frame.gap.cause) : [];
          if (matching.length === 0) { gapCoverage.set(frame.gap, false); break; }
          if (!placed.has(node)) dependencies.push(...matching);
        }
        frame.dependencies = dependencies;
        continue;
      }
      if (frame.index === frame.dependencies.length) { gapCoverage.set(frame.gap, true); continue; }
      const dependency = frame.dependencies[frame.index]!;
      const covered = gapCoverage.get(dependency);
      if (covered === false || active.has(dependency)) { gapCoverage.set(frame.gap, false); continue; }
      if (covered === true) { frame.index++; continue; }
      stack.push({ gap: dependency, index: 0 });
    }
    return gapCoverage.get(start) === true;
  };
  for (const shape of shapes.values()) {
    for (const call of calls(shape.source)) {
      const column = shape.source.getLineAndCharacterOfPosition(call.getStart(shape.source)).character;
      const selections = placed.get(call);
      if (direct.has(call) && selections === undefined && forwardedLeaves.has(call)) continue;
      const callSummary = direct.has(call) ? undefined : lookup.of(call);
      const summary = callSummary !== undefined && !("kind" in callSummary) ? callSummary : undefined;
      const group = groups.get(call);
      const groupGap = group?.some((candidate) => candidate.body === undefined || candidate.summary === undefined || candidate.summary.gaps.length > 0) ?? false;
      const outstanding = summary?.gaps.some((gap) => !gapAtSite(gap)) ?? false;
      const occurrences = selections === undefined ? [undefined] : group === undefined ? [...Map.groupBy(selections, ({ leaf }) => leaf).values()] : [selections];
      let identified = false;
      for (const occurrence of occurrences) {
        let target: ReadTarget | undefined;
        if (occurrence !== undefined) target = occurrence[0]?.leaf === call ? await read.directTarget(shape, call) : summaryTarget(shape, call, occurrence, summary, destinations, group);
        else if (direct.has(call)) target = await read.directTarget(shape, call);
        else if (outstanding || groupGap) target = summaryTarget(shape, call, [], summary, destinations, group);
        if (target === undefined) continue;
        if (target.target.status === "unknown" && occurrence !== undefined) {
          const method = occurrence[0]?.shape.method;
          const expressions = [...new Map(occurrence.flatMap(({ shape }) => requestShapeUrls(shape).map((url) => [JSON.stringify(url), url] as const))).values()];
          if (method !== undefined && occurrence.every((item) => item.shape.method === method) && expressions.some((parts) => parts.some((part) => part.kind === "text")) && occurrence.every((item) => item.shape.url !== undefined)) {
            target = { ...target, stated: { ...target.stated, method, expressions } };
          }
        }
        const site = siteOf(shape, call, repo, target);
        identified ||= site.target.status === "complete";
        const origins = occurrence?.flatMap(({ calls: chain }) => originsOfChain(chain)) ?? [];
        const proven = occurrence !== undefined && occurrence.length > 0 && occurrence.every((selection) => selection.bound && selection.calls.at(-1) === call) && summary !== undefined && summary.gaps.length === 0 && !groupGap && site.target.status === "complete";
        found.push({ site, column, ...(origins.length === 0 && direct.has(call) ? {} : { origins }), ...(proven ? { issuingBoundary: "site" as const } : {}) });
      }
      if (identified && summary !== undefined && summary.gaps.length > 0) {
        found.push({ site: siteOf(shape, call, repo, summaryTarget(shape, call, [], summary, destinations, group)), column, origins: [] });
      }
    }
  }
  return found.sort(({ site: a }, { site: b }) => compareCallSites(a, b));
}

function originsOfChain(chain: readonly ts.CallExpression[]): PlacedOrigin[] {
  const found: PlacedOrigin[] = [];
  for (const forwarded of chain.slice(0, -1).reverse()) {
    let owner: ts.Node | undefined = forwarded.parent;
    while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (owner !== undefined) found.push(originOf(owner, "body"));
    found.push(originOf(forwarded, "leaf"));
  }
  return found;
}

function siteOf(shape: FileShape, call: ts.CallExpression, repo: string, read: ReadTarget): CallSite {
  const start = lineOf(shape.source, call);
  const end = shape.source.getLineAndCharacterOfPosition(call.getEnd()).line + 1;
  return { repo, file: shape.source.fileName, line: start, endLine: end, symbol: symbolOf(call) ?? "(top level)", ancestors: ancestorsOf(call, shape.source), transport: "http", target: read.target, ...(read.diagnostic === undefined ? {} : { diagnostic: read.diagnostic }), ...(read.stated === undefined ? {} : { stated: read.stated }) };
}

function summaryTarget(shape: FileShape, call: ts.CallExpression, selections: readonly PlacedShape[], summary: RequestSummary | undefined, destinations: ReadonlyMap<PlacedShape, Evaluated<string>>, group?: readonly { key: string; body: ts.Node | undefined; summary: RequestSummary | undefined }[]): ReadTarget {
  const gaps = group === undefined ? selections.length === 0 ? [...(summary?.gaps ?? [])] : selections.flatMap((selection) => [...(selection.shape.gaps ?? summary?.gaps ?? [])]) : group.flatMap((candidate) => candidate.body === undefined || candidate.summary === undefined ? [{ cause: "source-not-read" as const, evidence: [placeOf(shape, call)] }] : candidate.summary.gaps);
  const leafEvidence = selections.map(({ leaf }) => {
    const source = leaf.getSourceFile();
    const at = source.getLineAndCharacterOfPosition(leaf.getStart(source));
    return { path: source.fileName, line: at.line + 1, column: at.character + 1 };
  });
  const evidence = [...new Map([placeOf(shape, call), ...leafEvidence, ...gaps.flatMap((gap) => gap.evidence)].map((item) => [JSON.stringify(item), item])).values()];
  const unknown = selections.map((item) => destinations.get(item)).find((value) => value?.status === "undecided");
  if (unknown !== undefined) for (const item of unknown.evidence) if (!evidence.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) evidence.push(item);
  const paths = [...new Set(selections.flatMap((item) => { const value = destinations.get(item); return value?.status === "known" ? [value.value] : []; }))];
  const methods = [...new Set(selections.map(({ shape: selected }) => selected.method))];
  const first = selections[0]?.shape;
  const gap = prevailingCause(gaps.map((item) => item.cause));
  if (group !== undefined && gap === undefined) {
    if (unknown === undefined && groupDisagrees(call, selections, group, destinations)) return { target: { status: "unknown", reason: "unresolved", evidence }, diagnostic: { cause: "dispatch-disagreement" } };
  }
  if (gap !== undefined || unknown !== undefined || first?.method === undefined || paths.length !== 1 || methods.length !== 1) {
    const alternatives = selections.length > 1 && selections.every((item) => item.conditional && (group !== undefined || item.leaf === selections[0]?.leaf));
    const cause = gap ?? unknown?.cause ?? (methods.length > 1 || (paths.length > 1 && !alternatives) ? "dispatch-disagreement" : "destination-undecidable");
    const path = paths.length === 1 ? paths[0] : unknown !== undefined && first?.unresolved === undefined && first !== undefined && startsSegments(first.path) ? namedHoles(callUrl(first.path).path) : undefined;
    return { target: { status: "unknown", reason: "unresolved", evidence: [...evidence, ...(unknown?.evidence ?? [])] }, diagnostic: { cause, ...(paths.length > 1 ? { alternatives: paths.sort() } : {}) }, ...(first?.method !== undefined && methods.length === 1 ? { stated: { method: first.method, ...(path === undefined ? {} : { path }) } } : {}) };
  }
  return { target: { status: "complete", value: { method: first.method, path: paths[0]! }, evidence } };
}

function groupDisagrees(call: ts.CallExpression, selections: readonly PlacedShape[], group: readonly { key: string; body: ts.Node | undefined; summary: RequestSummary | undefined }[], destinations: ReadonlyMap<PlacedShape, Evaluated<string>>): boolean {
  if (group.some((candidate) => candidate.body === undefined || candidate.summary === undefined || candidate.summary.gaps.length > 0)) return true;
  if (selections.some(({ shape }) => shape.body.kind === "unknown")) return true;
  if (selections.some((item) => destinations.get(item)?.status !== "known")) return true;
  const alternatives = group.map((candidate) => [...new Set(selections.filter((item) => item.targets.some((target) => target.call === call && target.key === candidate.key)).map((item) => JSON.stringify([item.shape.transport, item.shape.method, destinations.get(item), item.shape.body, item.shape.when])))].sort());
  return alternatives.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(alternatives[0]));
}
function describe(file: SourceFile): FileShape {
  const source = sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  const module = recoveredModuleShape(source);
  const shape: FileShape = { source, declared: declarationCounts(source), bindings: sourceBindings(source), unsafeEncoder: mayOverrideEncoder(source), consts: new Map(), module, imports: module.imports, classes: new Map(), enums: new Map() };
  for (const statement of source.statements) {
    const held = defaultExportOf(statement);
    if (held !== undefined) shape.defaultExport = held;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) shape.consts.set(declaration.name.text, declaration.initializer);
      }
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) shape.classes.set(statement.name.text, statement);
    if (ts.isEnumDeclaration(statement)) shape.enums.set(statement.name.text, statement);
  }
  return shape;
}

function calls(source: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/** Whether a name is Angular's `HttpClient`: the name alone is not enough, its import decides. */
function isAngularHttpClientName(shape: FileShape, name: string | undefined): boolean {
  if (name === undefined) return false;
  const imported = shape.imports.get(name);
  return name === "HttpClient" && imported?.module === HTTP_CLIENT_PACKAGE;
}

/** The expression the owner of the request vocabulary reads as the body a client call sends; undefined when it states none. */
function bodyExpressionOf(shape: FileShape, call: ts.CallExpression): ts.Expression | undefined {
  const recognized = requestCallOf(shape, call);
  return recognized.kind !== "not-request" && recognized.body.kind === "established" ? recognized.body.expression : undefined;
}

function memberNamed(declaration: ts.ClassDeclaration, name: string): ts.ClassElement | undefined {
  return declaration.members.find((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name);
}

/** Whether a function reads one of its own parameters anywhere in its body. */
function readsOwnParameters(method: ts.SignatureDeclaration): boolean {
  const parameters = parameterNames(method.parameters);
  if (parameters.size === 0) return false;
  const visit = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && parameters.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) return true;
    return ts.forEachChild(node, visit) === true;
  };
  return "body" in method && method.body !== undefined && visit(method.body);
}

/** The function a class member is: a method, or a property initialized with an arrow or a function expression. */
function functionOf(member: ts.Node): ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isMethodDeclaration(member)) return member;
  const initializer = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
  return initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? initializer : undefined;
}

function methodDeclared(declaration: ts.ClassDeclaration, name: string): ReturnType<typeof functionOf> | "ambiguous" {
  const members = declaration.members.filter((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name);
  if (members.length === 0) return undefined;
  const functions = members.map(functionOf);
  if (functions.some((fn) => fn === undefined)) return "ambiguous";
  const implementations = functions.filter((fn) => fn?.body !== undefined);
  if (implementations.length > 1) return "ambiguous";
  return implementations[0] ?? functions[0];
}

function parameterNames(parameters: readonly ts.ParameterDeclaration[]): RunTime {
  return new Set(parameters.flatMap((parameter) => bindingNames(parameter.name)));
}

/**
 * The lexical bindings visible at a call, with inner declarations taking precedence over outer declarations.
 */
function scopeOfCall(call: ts.CallExpression): Scope {
  return lexicalScope(call);
}

function lexicalScope(point: ts.Node): Scope {
  const node = point.parent;
  if (node === undefined || ts.isSourceFile(node)) return NO_SCOPE;
  const cached = LEXICAL_SCOPES.get(node);
  if (cached !== undefined) return cached;
  const outer = lexicalScope(node);
  const own = ownBindings(node);
  if (own.size === 0) {
    LEXICAL_SCOPES.set(node, outer);
    return outer;
  }
  const names = new Set(own.keys());
  const locals = new Map<string, ts.Expression>();
  const parameters = new Map<string, number>();
  if (ts.isFunctionLike(node) && "parameters" in node) node.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name)) parameters.set(parameter.name.text, index);
  });
  for (const [name, { initializer }] of own) if (initializer !== undefined) locals.set(name, initializer);
  for (const name of outer.names) {
    if (names.has(name)) continue;
    names.add(name);
    const initializer = outer.locals.get(name);
    if (initializer !== undefined) locals.set(name, initializer);
    const parameter = outer.parameters?.get(name);
    if (parameter !== undefined) parameters.set(name, parameter);
  }
  const scope = { names, locals, parameters };
  LEXICAL_SCOPES.set(node, scope);
  return scope;
}

/** A call's target, and the request the code states when the snapshot cannot decide where it goes. */
interface ReadTarget {
  target: Finding<HttpTarget>;
  stated?: StatedRequest;
  diagnostic?: CallSiteDiagnostic;
}

/** Reads one file's call sites, resolving the module specifiers it meets through the snapshot. */
class Reader {
  private readonly providerReading: RequestValueReading | undefined;
  private readonly providerContributions: Promise<readonly FrameworkValues[]> | undefined;
  private readonly explicitConstructions = new WeakMap<ts.ClassDeclaration, Promise<boolean>>();
  private valueSyntax: ReturnType<typeof requestValueSyntax> | undefined;
  private readonly stableBindings = new WeakMap<ts.Node, Promise<boolean>>();
  private readonly importedWrites = new WeakMap<ts.SourceFile, Map<string, boolean>>();
  private readonly unsafeEncoder: boolean;
  private readonly fileOf: (from: string, specifier: string) => Promise<string | undefined>;
  private readonly declarationOf: DeclarationLookup;
  /** The classes of the snapshot that extend a class, by the declaration their `extends` resolves to; built once, when first read. */
  private subclassIndex: Promise<ReadonlyMap<ts.ClassDeclaration, readonly HeldClass[]>> | undefined;

  async baseOfRequest(call: ts.CallExpression): Promise<Evaluated<string> | undefined> {
    const shape = this.shapes.get(call.getSourceFile().fileName);
    return shape === undefined ? undefined : this.baseUrl(shape, call);
  }

  async directTarget(shape: FileShape, call: ts.CallExpression): Promise<ReadTarget | undefined> {
    const recognized = requestCallOf(shape, call);
    if (recognized.kind === "not-request") return undefined;
    if (recognized.kind === "request") return recognized.client === "resource" ? this.resource(shape, call) : this.stated(shape, call, recognized);
    if (!(await this.summaryResolver.clientReceiver(shape.source.fileName, call))) return undefined;
    return this.stated(shape, call, recognized);
  }

  readonly summaryResolver: SummaryResolver = {
    valueFacts: (_file, expression) => this.valueOf(expression),
    evaluate: async (file, expression) => {
      const shape = this.shapes.get(file);
      if (shape === undefined) return { status: "undecided", cause: "source-not-read", evidence: [{ path: file, line: 1 }] };
      const result = await this.evaluate(shape, expression, { ...lexicalScope(expression), summary: true });
      if (result.status === "undecided" || result.value.kind === "value" && result.value.parameter === undefined || result.value.kind === "text" && holesOf(result.value).some((index) => index === undefined)) {
        const value = await this.valueOf(expression);
        if (valueHasParameter(value)) {
          const read = readRequestValue(value);
          return { status: "known", ...read, value };
        }
      }
      if (result.status === "undecided") return result;
      return { status: "known", text: written(result.value), holes: holesOf(result.value), encodings: encodingsOf(result.value) };
    },
    calleeOf: async (file, call) => {
      const shape = this.shapes.get(file);
      if (shape === undefined) return undefined;
      if (ts.isIdentifier(call.expression)) {
        if (scopeOfCall(call).names.has(call.expression.text)) return undefined;
        const target = await this.callTargetOf(shape, call.expression.text);
        if (target === undefined || !ts.isFunctionDeclaration(target.declaration) || target.declaration.name === undefined) return undefined;
        return { key: `${target.target.source.fileName}\0${target.declaration.name.text}`, file: target.target.source.fileName, body: target.declaration.body };
      }
      if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
      const receiver = await this.receiverClass(shape, call.expression.expression);
      return receiver === undefined ? undefined : this.memberCallee(shape, call, receiver, call.expression.name.text, new Set());
    },
    clientReceiver: async (file, call) => {
      const shape = this.shapes.get(file);
      if (shape === undefined || !ts.isPropertyAccessExpression(call.expression)) return false;
      const owner = await this.ownerClass(shape, call.expression.expression);
      return owner !== undefined && isAngularHttpClientName(owner.shape, owner.name);
    },
  };

  private valueOf(node: ts.Expression): Promise<RequestValue> {
    if (this.valueSyntax === undefined) {
      const roots: WrittenRoots = { paths: new Map(), packages: new Set() };
      for (const shape of this.shapes.values()) addWrittenRoots(shape.source.fileName, shape.source.text, shape.source, roots, (name) => isGlobalName(shape, NO_SCOPE, name));
      const written = (name: string): boolean => [...roots.paths.values()].some((path) => path[0] === "*" || path[0] === name && (path.length === 1 || path[1] === "prototype" || path[1] === "*"));
      this.valueSyntax = requestValueSyntax({
        propertiesSafe: !written("Object"), stringsSafe: !written("String") && !written("RegExp"), encoderSafe: !this.unsafeEncoder,
        builtin: (identifier) => { const shape = this.shapes.get(identifier.getSourceFile().fileName); return shape !== undefined && isGlobalName(shape, lexicalScope(identifier), identifier.text); },
        binding: (identifier) => {
          for (let current: ts.Node | undefined = identifier.parent; current !== undefined; current = current.parent) {
            const binding = ownBindings(current).get(identifier.text);
            if (binding === undefined) continue;
            if (ts.isParameter(binding.declaration)) {
              const parameter = binding.declaration;
              if (!ts.isFunctionLike(parameter.parent) || reboundIn(parameter.parent).has(identifier.text)) return { unsafe: true };
              return { parameter: parameter.parent.parameters.indexOf(parameter), stable: this.stableBinding(parameter), ...(parameter.initializer === undefined ? {} : { initializer: parameter.initializer }) };
            }
            if (binding.initializer === undefined) return undefined;
            const replacing = replacedBy(binding.initializer);
            if (replacing !== undefined) return { expression: binding.initializer, replacing, stable: () => this.stableBinding(binding.declaration) };
            return appendsTo(binding.initializer)?.length !== 0 ? undefined : { expression: binding.initializer, stable: () => this.stableBinding(binding.declaration) };
          }
          return undefined;
        },
        initializer: async (identifier) => {
          const shape = this.shapes.get(identifier.getSourceFile().fileName);
          const held = shape === undefined ? undefined : await this.constantAt(shape, identifier.text, new Set());
          if (held === undefined || appendsTo(held.expression)?.length !== 0) return undefined;
          if (ts.isObjectLiteralExpression(held.expression) && !(await this.stableBinding(held.expression.parent))) return undefined;
          if (ts.isRegularExpressionLiteral(held.expression) && !this.stablePattern(held)) return undefined;
          return held.expression;
        },
        callee: async (call) => {
          const callee = await this.summaryResolver.calleeOf(call.getSourceFile().fileName, call);
          return callee === undefined || "gap" in callee ? undefined : "candidates" in callee ? callee.candidates.map((candidate) => candidate.body) : [callee.body];
        },
        constant: async (expression) => {
          const shape = this.shapes.get(expression.getSourceFile().fileName);
          if (shape === undefined) return valueUnknown([]);
          const read = await this.evaluate(shape, expression, { ...lexicalScope(expression), summary: true });
          if (read.status === "known" && read.value.kind === "text" && holesOf(read.value).length === 0) return { kind: "literal", value: read.value.text };
          if (read.status === "known" && read.value.kind === "value" && read.value.parameter !== undefined) return { kind: "parameter", index: read.value.parameter };
          let evidence = read.status === "undecided" ? read.evidence : [];
          if (evidence.length === 0 && ts.isPropertyAccessExpression(expression)) {
            const held = await this.memberOf(shape, expression, new Set());
            if (held !== undefined && held !== ASSIGNED_AT_RUN_TIME) evidence = [placeOf(held.shape, held.expression.parent)];
          }
          return valueUnknown(evidence.length === 0 ? [placeOf(shape, expression)] : evidence, read.status === "undecided" ? read.cause : "destination-undecidable");
        },
      });
    }
    return this.valueSyntax(node);
  }

  private stablePattern(held: Located): boolean {
    const declaration = held.expression.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
    const statement = declaration.parent.parent;
    if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
    let safe = true;
    const visit = (node: ts.Node): void => {
      if (!safe) return;
      if (ts.isIdentifier(node) && node.text === declaration.name.getText() && node !== declaration.name) {
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
        let binding: ts.Node | undefined;
        for (let scope: ts.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
          const candidate = ownBindings(scope).get(node.text);
          if (candidate !== undefined) { binding = candidate.declaration; break; }
        }
        if (binding !== undefined && binding !== declaration) return;
        const parent = node.parent;
        safe = ts.isCallExpression(parent) && parent.arguments[0] === node && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "replace";
      }
      ts.forEachChild(node, visit);
    };
    visit(held.shape.source);
    return safe;
  }

  private stableBinding(declaration: ts.Node, trail: ReadonlySet<ts.Node> = new Set()): Promise<boolean> {
    if (trail.has(declaration)) return Promise.resolve(false);
    const cached = this.stableBindings.get(declaration);
    if (cached !== undefined) return cached;
    const compute = async (): Promise<boolean> => {
      if (!(ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) || !ts.isIdentifier(declaration.name)) return false;
      let owner: ts.Node = declaration.parent;
      while (!ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      if (ts.isVariableDeclaration(declaration) && ts.isVariableStatement(declaration.parent.parent) && declaration.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
      const name = declaration.name.text;
      const nested = new Set(trail).add(declaration);
      let safe = true;
      const visit = async (node: ts.Node, captured = false): Promise<void> => {
        if (!safe) return;
        captured ||= node !== owner && ts.isFunctionLike(node);
        if (ts.isIdentifier(node) && node.text === name && node !== declaration.name) {
          if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node || ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
          let declared: ts.Node | undefined;
          for (let scope: ts.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
            const binding = ownBindings(scope).get(name);
            if (binding !== undefined) { declared = binding.declaration; break; }
          }
          if (declared !== declaration) return;
          if (captured) { safe = false; return; }
          let usage: ts.Node = node;
          let direct = true;
          while (true) {
            const parent = usage.parent;
            if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === usage) { direct = false; usage = parent; }
            else if ((ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === usage) usage = parent;
            else break;
          }
          const parent = usage.parent;
          if (ts.isBinaryExpression(parent) && parent.left === usage && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment || ts.isDeleteExpression(parent) || (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) { safe = false; return; }
          if (direct && (ts.isVariableDeclaration(parent) && parent.initializer === usage || ts.isArrayLiteralExpression(parent) || ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isReturnStatement(parent) || ts.isExportSpecifier(parent) || ts.isExportAssignment(parent))) { safe = false; return; }
          if (direct && ts.isCallExpression(parent)) {
            const index = ts.isExpression(usage) ? parent.arguments.indexOf(usage) : -1;
            if (index >= 0) {
              const callee = await this.summaryResolver.calleeOf(parent.getSourceFile().fileName, parent);
              if (callee === undefined || "gap" in callee) { safe = false; return; }
              for (const target of "candidates" in callee ? callee.candidates : [callee]) {
                const signature = target.body?.parent;
                const called = signature !== undefined && ts.isFunctionLike(signature) ? signature.parameters[index] : undefined;
                if (called === undefined || !(await this.stableBinding(called, nested))) { safe = false; return; }
              }
            }
          }
        }
        for (const child of node.getChildren()) await visit(child, captured);
      };
      await visit(owner);
      return safe;
    };
    const result = compute();
    this.stableBindings.set(declaration, result);
    return result;
  }

  constructor(
    private readonly shapes: ReadonlyMap<string, FileShape>,
    private readonly modules: ModuleResolver,
    private readonly defines: BuildDefines,
    files: readonly SourceFile[],
    options?: CallSiteReadOptions,
    values: readonly FrameworkValueFactory[] = [],
    private readonly cells: readonly FrameworkValueCells[] = [],
  ) {
    this.unsafeEncoder = [...shapes.values()].some((shape) => shape.unsafeEncoder);
    this.fileOf = async (from, specifier) => {
      const resolved = await modules.resolve(from, specifier);
      return "file" in resolved ? resolved.file : undefined;
    };
    this.declarationOf = createDeclarationLookup(async (file) => shapes.get(file)?.module, this.fileOf, { anonymousDefault: true });
    if (options?.completeSource === true && values.length > 0) {
      this.providerReading = new RequestValueReading(files, shapes, modules, async (unit, name) => {
        const shape = shapes.get(unit.source.fileName);
        const held = shape === undefined ? undefined : await this.constantAt(shape, name, new Set());
        return held === undefined ? undefined : { unit: held.shape, expression: held.expression };
      });
      this.providerContributions = Promise.all(values.map((factory) => factory.prepare(this.providerReading!))).then((read) => read.filter((value) => value !== undefined));
    }
  }

  /** The declaration a member read through a receiver runs: a gap when the dispatch is undecided, undefined when it runs no repository code. */
  private async memberCallee(shape: FileShape, call: ts.CallExpression, receiver: HeldClass & { virtual: boolean }, name: string, reading: ReadonlySet<ts.PropertyDeclaration>): Promise<Callee> {
    const gap: Callee = { gap: { cause: "dispatch-disagreement", evidence: [placeOf(shape, call)] } };
    if (await this.assignedAbove(receiver, name)) return gap;
    const method = await this.inheritedMethod(receiver.shape, receiver.declaration, name, new Set());
    const overrides = receiver.virtual ? await this.overrides(receiver.declaration, name, new Set()) : [];
    if (method === "ambiguous" && overrides !== undefined && overrides.length === 0) {
      if (await this.externalFactoryProperty(receiver, name)) return undefined;
      const cell = await this.valueCell(shape, call, receiver, name, reading);
      if (cell !== undefined) return cell.callee;
    }
    if (method === "ambiguous" || overrides === undefined) return gap;
    if (method === undefined) return undefined;
    const candidates = [method, ...overrides].map((item) => {
      const owner = ownClassDeclaration(item.method);
      return owner?.name === undefined ? undefined : { key: `${item.shape.source.fileName}\0${owner.name.text}.${name}`, file: item.shape.source.fileName, body: item.method.body };
    });
    if (candidates.some((candidate) => candidate === undefined)) return gap;
    const held = candidates.filter((candidate) => candidate !== undefined);
    return held.length === 1 ? held[0] : { candidates: held };
  }

  /**
   * What reading a field runs when a framework's vocabulary says what its initializer holds: nothing, the callback it
   * was given, or what the field it aliases runs. Undefined when the vocabulary does not decide it.
   */
  private async valueCell(shape: FileShape, call: ts.CallExpression, receiver: HeldClass, name: string, reading: ReadonlySet<ts.PropertyDeclaration>): Promise<{ callee: Callee } | undefined> {
    if (this.cells.length === 0 || await this.assignedBelow(receiver.declaration, name, new Set())) return undefined;
    const seen = new Set<ts.ClassDeclaration>();
    for (let current: HeldClass | undefined = receiver; current !== undefined && !seen.has(current.declaration);) {
      seen.add(current.declaration);
      const members = current.declaration.members.filter((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name);
      if (members.length > 0) {
        const property = members[0];
        if (members.length !== 1 || property === undefined || !ts.isPropertyDeclaration(property) || property.initializer === undefined || reading.has(property)) return undefined;
        return this.cellValue(shape, call, current, unwrapped(property.initializer), new Set(reading).add(property));
      }
      const base = baseClassName(current.declaration);
      current = base === undefined ? undefined : await this.classOf(current.shape, base);
    }
    return undefined;
  }

  private async cellValue(shape: FileShape, call: ts.CallExpression, holder: HeldClass, value: ts.Expression, reading: ReadonlySet<ts.PropertyDeclaration>): Promise<{ callee: Callee } | undefined> {
    if (ts.isPropertyAccessExpression(value)) {
      const target = await this.aliasedClass(holder.shape, value.expression);
      return target === undefined ? undefined : { callee: await this.memberCallee(shape, call, target, value.name.text, reading) };
    }
    if (!ts.isCallExpression(value)) return undefined;
    const factory = unwrapped(value.expression);
    if (ts.isPropertyAccessExpression(factory) && this.cells.some(({ projections }) => projections.has(factory.name.text))) {
      const cell = unwrapped(factory.expression);
      const projected = ts.isCallExpression(cell) || ts.isPropertyAccessExpression(cell) ? await this.cellValue(shape, call, holder, cell, reading) : undefined;
      if (projected !== undefined) return projected;
    }
    const exported = await this.packageExport(holder.shape, factory);
    const run = exported === undefined ? undefined : this.cells.map((cells) => cells.runOf(exported)).find((one) => one !== undefined);
    if (run === undefined) return undefined;
    if (run.kind === "nothing") return { callee: undefined };
    const callback = value.arguments[run.argument] === undefined ? undefined : unwrapped(value.arguments[run.argument]!);
    if (callback === undefined || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return undefined;
    return { callee: { key: `${holder.shape.source.fileName}\0@${callback.getStart()}`, file: holder.shape.source.fileName, body: callback.body } };
  }

  /** The class an aliased field's receiver is an instance of: an injected class, or the one the receiver expression names. */
  private async aliasedClass(shape: FileShape, receiver: ts.Expression): Promise<(HeldClass & { virtual: boolean }) | undefined> {
    const target = unwrapped(receiver);
    const injected = ts.isCallExpression(target) ? injectedClass(target, shape) : undefined;
    if (injected === undefined) return this.receiverClass(shape, target);
    const found = await this.classOf(shape, injected);
    return found === undefined ? undefined : { ...found, virtual: true };
  }

  private packageExport(shape: FileShape, callee: ts.Expression): Promise<CellFactory | undefined> {
    return packageExportOf(shape, callee, this.modules, (source, name) => this.importedMemberWritten(source, name));
  }

  private async externalFactoryProperty(receiver: HeldClass, name: string): Promise<boolean> {
    if (await this.assignedBelow(receiver.declaration, name, new Set())) return false;
    const seen = new Set<ts.ClassDeclaration>();
    for (let current: HeldClass | undefined = receiver; current !== undefined && !seen.has(current.declaration);) {
      seen.add(current.declaration);
      const members = current.declaration.members.filter((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name);
      if (members.length > 0) {
        const property = members[0];
        if (members.length !== 1 || property === undefined || !ts.isPropertyDeclaration(property) || property.initializer === undefined) return false;
        const initializer = unwrapped(property.initializer);
        if (!ts.isCallExpression(initializer)) return false;
        let root: ts.Expression = unwrapped(initializer.expression);
        while (ts.isPropertyAccessExpression(root)) root = unwrapped(root.expression);
        if (!ts.isIdentifier(root)) return false;
        const imported = current.shape.imports.get(root.text);
        if (imported === undefined || imported.typeOnly || current.shape.module.reimported.has(root.text) || current.shape.declared.has(root.text) || lexicalScope(root).names.has(root.text) || reboundIn(current.shape.source).has(root.text) || this.importedMemberWritten(current.shape.source, root.text)) return false;
        if (!("external" in await this.modules.resolve(current.shape.source.fileName, imported.module))) return false;
        for (const argument of initializer.arguments) {
          const value = unwrapped(argument);
          if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) continue;
          if (!ts.isIdentifier(value) || lexicalScope(value).names.has(value.text) || reboundIn(current.shape.source).has(value.text) || await this.classOf(current.shape, value.text) === undefined) return false;
        }
        return true;
      }
      const base = baseClassName(current.declaration);
      current = base === undefined ? undefined : await this.classOf(current.shape, base);
    }
    return false;
  }

  private importedMemberWritten(source: ts.SourceFile, name: string): boolean {
    const held = this.importedWrites.get(source) ?? new Map<string, boolean>();
    if (!this.importedWrites.has(source)) this.importedWrites.set(source, held);
    if (!held.has(name)) held.set(name, writesImportedMember(source, name));
    return held.get(name)!;
  }

  private async subclassesOf(declaration: ts.ClassDeclaration): Promise<readonly HeldClass[]> {
    this.subclassIndex ??= this.indexSubclasses();
    return (await this.subclassIndex).get(declaration) ?? [];
  }

  private async indexSubclasses(): Promise<ReadonlyMap<ts.ClassDeclaration, readonly HeldClass[]>> {
    const index = new Map<ts.ClassDeclaration, HeldClass[]>();
    for (const shape of this.shapes.values()) {
      for (const declaration of shape.source.statements.filter(ts.isClassDeclaration)) {
        const base = baseClassName(declaration);
        const extended = base === undefined ? undefined : await this.classOf(shape, base);
        if (extended !== undefined) index.set(extended.declaration, [...(index.get(extended.declaration) ?? []), { shape, declaration }]);
      }
    }
    return index;
  }

  /** The request the owner of the request vocabulary reads at the call, its method folded where the code writes a value. */
  private async stated(shape: FileShape, call: ts.CallExpression, recognized: Exclude<RequestCall, { kind: "not-request" }>): Promise<ReadTarget> {
    return this.request(shape, call, recognized.path, await this.methodRead(shape, recognized.method, scopeOfCall(call)));
  }

  private async methodRead(shape: FileShape, method: RequestMethod, scope: Scope): Promise<HttpTarget["method"] | undefined> {
    if (method.kind === "established") return method.verb;
    return method.stated === undefined ? undefined : this.methodOf(shape, method.stated, scope);
  }

  /** The method a request object states, GET when it states none; undefined when the snapshot does not decide it. */
  private async requestMethod(shape: FileShape, object: ts.ObjectLiteralExpression, scope: Scope): Promise<HttpTarget["method"] | undefined> {
    const method = memberOf(object, "method");
    if (method === undefined) return "GET";
    return method.status === "undecided" ? undefined : this.methodOf(shape, method.value, scope);
  }

  /**
   * `httpResource(() => url)` is a GET of the URL; `httpResource(() => ({ url, method }))` states its method, GET when it
   * names none. A function that returns undefined requests nothing then, so the request is the one every other return
   * states; returns that disagree leave it undecided.
   */
  private async resource(shape: FileShape, call: ts.CallExpression): Promise<ReadTarget> {
    const [first] = call.arguments;
    const requests = first === undefined ? [] : ts.isArrowFunction(first) || ts.isFunctionExpression(first) ? returnsOf(first).filter(requestsSomething) : [first];
    let agreed: ReadTarget | undefined;
    for (const returned of requests) {
      const read = await this.resourceRequest(shape, call, returned);
      if (agreed !== undefined && JSON.stringify(read) !== JSON.stringify(agreed)) return unresolvedAt(shape, call);
      agreed = read;
    }
    return agreed ?? unresolvedAt(shape, call);
  }

  private async resourceRequest(shape: FileShape, call: ts.CallExpression, returned: ts.Expression): Promise<ReadTarget> {
    const scope = lexicalScope(returned);
    const described = objectOf(returned);
    if (described === undefined) return this.request(shape, call, returned, "GET", scope);
    const url = memberOf(described, "url");
    return this.request(shape, call, url?.status === "known" ? url.value : undefined, await this.requestMethod(shape, described, scope), scope);
  }

  private async methodOf(shape: FileShape, expression: ts.Expression, scope: Scope = NO_SCOPE): Promise<HttpTarget["method"] | undefined> {
    const text = textOf(await this.evaluate(shape, expression, scope));
    return text === undefined ? undefined : verbOf(text.toLowerCase());
  }

  private async request(shape: FileShape, call: ts.CallExpression, pathExpression: ts.Expression | undefined, method: HttpTarget["method"] | undefined, scope = scopeOfCall(call)): Promise<ReadTarget> {
    const read = pathExpression === undefined ? UNDECIDABLE : await this.evaluate(shape, pathExpression, scope);
    const stated = method === undefined ? {} : { stated: { method } };
    if (read.status === "undecided") return { ...unresolvedAt(shape, call, read), ...stated };
    const path = textOf(read);
    if (path === undefined || method === undefined || !startsSegments(path)) return { ...unresolvedAt(shape, call), ...stated };
    const own = callUrl(path);
    const base = own.origin === undefined ? await this.baseUrl(shape, call) : undefined;
    if (base?.status === "undecided") return { ...unresolvedAt(shape, call, base), stated: { method, path: namedHoles(own.path) } };
    const url = base === undefined ? own : joinedCallUrl(base.value, path);
    return { target: { status: "complete", value: { method, path: urlText({ ...url, path: namedHoles(url.path) }) }, evidence: [placeOf(shape, call)] } };
  }

  /** The base URL the call's options declare: undefined when they declare none. */
  private async baseUrl(shape: FileShape, call: ts.CallExpression): Promise<Evaluated<string> | undefined> {
    for (const argument of call.arguments.slice(1)) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      const declared = propertyOf(argument, "baseUrl");
      if (declared === undefined) continue;
      const read = await this.evaluate(shape, declared, scopeOfCall(call));
      if (read.status === "undecided") return read;
      const text = textOf(read);
      return text === undefined ? UNDECIDABLE : known(text);
    }
    return undefined;
  }

  /**
   * The name of the class a receiver is an instance of, with the file that names it: `this.x` through the field the class of
   * the call declares or inherits, a bare name through the binding the code around it declares, or a constant of the file.
   */
  private async ownerClass(shape: FileShape, receiver: ts.Expression): Promise<TypeNamed | undefined> {
    if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const enclosing = ownClassDeclaration(receiver);
      return enclosing === undefined ? undefined : this.memberType(shape, enclosing, receiver.name.text, new Set());
    }
    if (!ts.isIdentifier(receiver)) return undefined;
    const scope = lexicalScope(receiver);
    if (scope.names.has(receiver.text)) {
      const local = scope.locals.get(receiver.text);
      const named = local === undefined ? parameterType(receiver) : appendsTo(local)?.length === 0 ? injectedClass(local, shape) : undefined;
      return named === undefined ? undefined : { name: named, shape };
    }
    const constant = shape.consts.get(receiver.text);
    const named = constant === undefined ? undefined : injectedClass(constant, shape);
    return named === undefined ? undefined : { name: named, shape };
  }

  /** The type of the field a class declares under a name, a parameter property included, or the one its base class declares. */
  private async memberType(shape: FileShape, declaration: ts.ClassDeclaration, name: string, visited: ReadonlySet<ts.ClassDeclaration>): Promise<TypeNamed | undefined> {
    if (visited.has(declaration)) return undefined;
    const field = declaration.members.find((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name);
    const parameter = constructorParameters(declaration).find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name && ts.isParameterPropertyDeclaration(candidate, candidate.parent));
    const declared = field ?? parameter;
    if (declared !== undefined) {
      const named = (field?.initializer === undefined ? undefined : injectedClass(field.initializer, shape)) ?? (declared.type === undefined ? undefined : typeName(declared.type));
      return named === undefined ? undefined : { name: named, shape };
    }
    const base = baseClassName(declaration);
    const found = base === undefined ? undefined : await this.classOf(shape, base);
    return found === undefined ? undefined : this.memberType(found.shape, found.declaration, name, new Set(visited).add(declaration));
  }

  /**
   * What a path expression comes down to: the text it states, a value the code being evaluated fills at run time
   * (`kind: "value"`, written `{}` inside a path), or why the snapshot does not decide it. `scope` holds the names that
   * code binds.
   */
  private async evaluate(shape: FileShape, expression: ts.Expression, scope: Scope = NO_SCOPE, trail: ReadonlySet<string> = new Set()): Promise<Read> {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return stated(expression.text);
    if (ts.isTemplateExpression(expression)) {
      let text = expression.head.text;
      const holes: (number | undefined)[] = [];
      const encodings: boolean[] = [];
      for (const span of expression.templateSpans) {
        if (endsPath(text)) return cutAt(text, holes, encodings);
        const part = await this.evaluate(shape, span.expression, scope, trail);
        if (part.status === "undecided") return part;
        if (part.value.kind === "text" && part.value.cut) return cutAt(text + part.value.text, [...holes, ...holesOf(part.value)], [...encodings, ...encodingsOf(part.value)]);
        text += written(part.value) + span.literal.text;
        holes.push(...holesOf(part.value));
        encodings.push(...encodingsOf(part.value));
      }
      return known({ kind: "text", text, holes, encodings });
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = await this.evaluate(shape, expression.left, scope, trail);
      if (left.status === "known" && left.value.kind === "text" && endsPath(left.value.text)) return cutAt(left.value.text, holesOf(left.value), encodingsOf(left.value));
      const right = await this.evaluate(shape, expression.right, scope, trail);
      if (left.status === "undecided") return left;
      if (right.status === "undecided") return right;
      const holes = [...holesOf(left.value), ...holesOf(right.value)];
      const encodings = [...encodingsOf(left.value), ...encodingsOf(right.value)];
      return right.value.kind === "text" && right.value.cut ? cutAt(written(left.value) + right.value.text, holes, encodings) : known({ kind: "text", text: written(left.value) + written(right.value), holes, encodings });
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
      return this.evaluate(shape, expression.expression, scope, trail);
    }
    if (ts.isIdentifier(expression)) return this.evaluateName(shape, expression.text, scope, trail, expression);
    if (ts.isPropertyAccessExpression(expression)) return this.evaluateProperty(shape, expression, scope, trail);
    if (ts.isCallExpression(expression)) return this.evaluateCall(shape, expression, scope, trail);
    return UNDECIDABLE;
  }

  /**
   * A name the code binds is what it was bound to: the initializer of a variable declared where the call sits, a value
   * the code fills at run time, or the constant a top-level declaration or an import names. The code's own binding wins,
   * so a parameter that shadows a const of the file stays a value the code fills. An initializer the snapshot does not
   * decide is a value the code fills only when it reads one, so a value computed from nothing it holds stays undecided.
   */
  private async evaluateName(shape: FileShape, name: string, scope: Scope, trail: ReadonlySet<string>, point?: ts.Node): Promise<Read> {
    const local = scope.locals.get(name);
    if (local !== undefined) {
      const visited = `${shape.source.fileName}\0local ${local.pos}`;
      if (trail.has(visited)) return UNDECIDABLE;
      const declared = { ...lexicalScope(local), ...(scope.summary ? { summary: true as const } : {}), ...(scope.arguments === undefined ? {} : { arguments: scope.arguments }) };
      const evaluated = await this.evaluate(shape, local, declared, new Set(trail).add(visited));
      const initial = evaluated.status === "undecided" && readsRunTime(local, declared) ? RUN_TIME : evaluated;
      return this.afterWrites(shape, local, initial, trail);
    }
    if (scope.names.has(name)) {
      if (point !== undefined && scope.arguments !== undefined) {
        for (let node = point.parent; node !== undefined && !ts.isSourceFile(node); node = node.parent) {
          const binding = ownBindings(node).get(name);
          if (binding === undefined) continue;
          if (ts.isParameter(binding.declaration)) return reboundIn(node).has(name) ? UNDECIDABLE : scope.arguments.get(binding.declaration) ?? RUN_TIME;
          break;
        }
      }
      const parameter = scope.parameters?.get(name);
      return parameter === undefined ? RUN_TIME : known({ kind: "value", parameter });
    }
    const constant = await this.constantAt(shape, name, trail);
    if (constant !== undefined) return this.afterWrites(constant.shape, constant.expression, await this.evaluate(constant.shape, constant.expression, NO_SCOPE, constant.trail), constant.trail);
    if (shape.imports.has(name) || shape.bindings.has(name)) return UNDECIDABLE;
    const defined = this.defines.valueOf(shape.source.fileName, name);
    return defined === undefined ? UNDECIDABLE : stated(defined);
  }

  /** Where a name's constant lives and the trail that visited it: a declaration of this file, or one an import names. */
  private async constantAt(shape: FileShape, name: string, trail: ReadonlySet<string>): Promise<Located | undefined> {
    const local = shape.consts.get(name);
    if (local !== undefined) {
      const visited = `${shape.source.fileName}\0${name}`;
      return trail.has(visited) ? undefined : { shape, expression: local, trail: new Set(trail).add(visited) };
    }
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*") return undefined;
    const target = await this.importedShape(shape, imported.module);
    return target === undefined ? undefined : this.exported(target, imported.imported, trail);
  }

  /** The expression a module exports under a name. */
  private async exported(shape: FileShape, name: string, trail: ReadonlySet<string>): Promise<Located | undefined> {
    const found = await this.exportedAs(shape, name, CONSTANTS, trail);
    return found === undefined ? undefined : { shape: found.shape, expression: found.declaration, trail: found.trail };
  }

  /** The declaration a name stands for in a file: one the file declares, or the one an import names, through any re-export. */
  private async declaredAs<T>(shape: FileShape, name: string, kind: DeclarationKind<T>, trail: ReadonlySet<string>): Promise<Resolved<T> | undefined> {
    const own = kind.named(shape, name);
    if (own !== undefined) return { shape, declaration: own, trail };
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*") return undefined;
    const target = await this.importedShape(shape, imported.module);
    return target === undefined ? undefined : this.exportedAs(target, imported.imported, kind, trail);
  }

  /**
   * The declaration a module exports under a name, through any re-export chain (`declaration-lookup.ts`), when it is of
   * the kind asked. Undefined when the module states none, when two `export *` could supply it, and when the evaluation
   * already visited that declaration.
   */
  private async exportedAs<T>(shape: FileShape, name: string, kind: DeclarationKind<T>, trail: ReadonlySet<string>): Promise<Resolved<T> | undefined> {
    const found = await this.declarationOf(shape.source.fileName, name);
    const holder = found === undefined ? undefined : this.shapes.get(found.file);
    if (found === undefined || holder === undefined) return undefined;
    const visited = `${found.file}\0${found.name}`;
    if (trail.has(visited)) return undefined;
    const held = holder.defaultExport;
    const declaration = found.name !== ANONYMOUS_DEFAULT ? kind.named(holder, found.name) : held === undefined ? undefined : kind.defaulted(held);
    return declaration === undefined ? undefined : { shape: holder, declaration, trail: new Set(trail).add(visited) };
  }

  /**
   * A member read from a class (`this.base`, `OrderApi.BASE`), a namespace import or an object literal: the value it
   * holds. A property of a value the code fills at run time is one too; a root the code binds is read through that
   * binding first.
   */
  private async evaluateProperty(shape: FileShape, expression: ts.PropertyAccessExpression, scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    const owner = expression.expression;
    if (ts.isIdentifier(owner) && scope.names.has(owner.text)) {
      const read = await this.evaluateName(shape, owner.text, scope, trail, owner);
      return isRunTime(read) ? read : UNDECIDABLE;
    }
    if (!ts.isIdentifier(owner) && owner.kind !== ts.SyntaxKind.ThisKeyword) {
      const read = await this.evaluate(shape, owner, scope, trail);
      if (isRunTime(read)) return read;
    }
    const held = await this.memberOf(shape, expression, trail);
    if (held === ASSIGNED_AT_RUN_TIME) return RUN_TIME;
    return held === undefined ? UNDECIDABLE : this.afterWrites(held.shape, held.expression, await this.evaluate(held.shape, held.expression, NO_SCOPE, held.trail), held.trail);
  }

  /**
   * What a variable holds where the code reads it, given what its initializer holds: the initializer's path while the code
   * only extends it with a query or a fragment (`url += '?q=' + q`), undecided once it writes it any other way.
   */
  private async afterWrites(shape: FileShape, initializer: ts.Expression, initial: Read, trail: ReadonlySet<string>): Promise<Read> {
    const appended = appendsTo(initializer);
    if (appended === null) return UNDECIDABLE;
    if (appended.length === 0 || initial.status === "undecided") return initial;
    if (initial.value.kind !== "text") return UNDECIDABLE;
    if (endsPath(initial.value.text)) return cutAt(initial.value.text, holesOf(initial.value), encodingsOf(initial.value));
    for (const part of appended) {
      const text = textOf(await this.evaluate(shape, part, lexicalScope(part), trail));
      if (text === undefined || !(text.startsWith("?") || text.startsWith("#"))) return UNDECIDABLE;
    }
    return cutAt(initial.value.text, holesOf(initial.value), encodingsOf(initial.value));
  }

  private async memberOf(shape: FileShape, expression: ts.PropertyAccessExpression, trail: ReadonlySet<string>): Promise<Located | typeof ASSIGNED_AT_RUN_TIME | undefined> {
    const owner = expression.expression;
    const name = expression.name.text;
    if (owner.kind === ts.SyntaxKind.ThisKeyword) {
      const enclosing = ownClassDeclaration(owner);
      return enclosing === undefined ? undefined : await this.fieldOf(shape, enclosing, name, trail, { shape, declaration: enclosing });
    }
    if (!ts.isIdentifier(owner)) return undefined;
    const namespace = shape.imports.get(owner.text);
    if (namespace?.imported === "*") {
      const target = await this.importedShape(shape, namespace.module);
      return target === undefined ? undefined : this.exported(target, name, trail);
    }
    const found = await this.classOf(shape, owner.text);
    const field = found === undefined ? undefined : await this.fieldOf(found.shape, found.declaration, name, trail, found);
    if (field !== undefined) return field;
    const enumeration = await this.declaredAs(shape, owner.text, ENUMS, new Set());
    if (enumeration !== undefined) return enumMember(enumeration.shape, enumeration.declaration, name, trail);
    const literal = await this.objectLiteral(shape, owner.text, trail);
    if (literal === undefined) return undefined;
    const property = literal.expression.properties.find((candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate) && candidate.name.getText(literal.expression.getSourceFile()) === name);
    return property === undefined ? undefined : { shape: literal.shape, expression: property.initializer, trail: literal.trail };
  }

  /**
   * The initializer of a class member, once, whatever names the class states; a member the class does not declare is its
   * base class's. `read` is the class the code reads the member of. A field declared without an initializer or as a
   * constructor parameter, or that a class of the instance's hierarchy assigns besides its initializer, holds a value the
   * code assigns at run time.
   */
  private async fieldOf(shape: FileShape, declaration: ts.ClassDeclaration, name: string, trail: ReadonlySet<string>, read: HeldClass): Promise<Located | typeof ASSIGNED_AT_RUN_TIME | undefined> {
    const visited = `${shape.source.fileName}\0${declaration.name?.text ?? "(anonymous)"}.${name}`;
    if (trail.has(visited)) return undefined;
    const member = memberNamed(declaration, name);
    if (member === undefined) {
      const parameter = constructorParameters(declaration).find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name && ts.isParameterPropertyDeclaration(parameter, parameter.parent));
      if (parameter !== undefined) {
        if (ts.isIdentifier(parameter.name) && !(await this.assignedAbove(read, name)) && !(await this.assignedBelow(declaration, name, new Set()))) {
          const provided = await this.provided(shape, parameter.name, trail);
          if (provided !== undefined) return provided;
        }
        return ASSIGNED_AT_RUN_TIME;
      }
      const base = baseClassName(declaration);
      const found = base === undefined ? undefined : await this.classOf(shape, base);
      return found === undefined ? undefined : this.fieldOf(found.shape, found.declaration, name, new Set(trail).add(visited), read);
    }
    if (!ts.isPropertyDeclaration(member)) return undefined;
    const assigned = (await this.assignedAbove(read, name)) || (await this.assignedBelow(read.declaration, name, new Set()));
    if (member.initializer === undefined || assigned) return ASSIGNED_AT_RUN_TIME;
    return { shape, expression: member.initializer, trail: new Set(trail).add(visited) };
  }

  /** Whether the class, or a base class it extends at any depth, assigns the member through `this`. */
  private async assignedAbove(held: HeldClass, name: string): Promise<boolean> {
    const seen = new Set<ts.ClassDeclaration>();
    for (let current: HeldClass | undefined = held; current !== undefined && !seen.has(current.declaration); ) {
      if (writes(current.declaration, name)) return true;
      seen.add(current.declaration);
      const base = baseClassName(current.declaration);
      current = base === undefined ? undefined : await this.classOf(current.shape, base);
    }
    return false;
  }

  /** Whether a subclass of the class, the instance the code may run on, declares the field again or writes it. */
  private async assignedBelow(declaration: ts.ClassDeclaration, name: string, visited: Set<ts.ClassDeclaration>): Promise<boolean> {
    if (visited.has(declaration)) return false;
    visited.add(declaration);
    for (const { declaration: subclass } of await this.subclassesOf(declaration)) {
      if (memberNamed(subclass, name) !== undefined || constructorParameters(subclass).some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name && ts.isParameterPropertyDeclaration(parameter, parameter.parent)) || writes(subclass, name) || (await this.assignedBelow(subclass, name, visited))) return true;
    }
    return false;
  }

  /** The class a name states in this file, or the one an import names. */
  private classOf(shape: FileShape, name: string): Promise<HeldClass | undefined> {
    return this.declaredAs(shape, name, CLASSES, new Set());
  }

  private async objectLiteral(shape: FileShape, name: string, trail: ReadonlySet<string>): Promise<Located<ts.ObjectLiteralExpression> | undefined> {
    const local = shape.consts.get(name);
    const held = local === undefined ? undefined : objectOf(local);
    if (held !== undefined) return { shape, expression: held, trail };
    const imported = shape.imports.get(name);
    if (imported === undefined || imported.imported === "*") return undefined;
    const target = await this.importedShape(shape, imported.module);
    if (target === undefined) return undefined;
    const found = await this.exported(target, imported.imported, trail);
    const literal = found === undefined ? undefined : objectOf(found.expression);
    return literal === undefined || found === undefined ? undefined : { shape: found.shape, expression: literal, trail: found.trail };
  }

  /** A function the call names, evaluated at its one returned expression: its own parameters are the run-time values. */
  private async evaluateCall(shape: FileShape, call: ts.CallExpression, scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    const provided = await this.provided(shape, call, trail);
    if (provided !== undefined) return this.evaluate(provided.shape, provided.expression, NO_SCOPE, provided.trail);
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "toString") return this.scalarText(shape, call.arguments.length === 0 ? [call.expression.expression] : [], scope, trail);
    if (ts.isPropertyAccessExpression(call.expression)) return this.evaluateMethod(shape, call.expression, trail, call, scope);
    if (!ts.isIdentifier(call.expression)) return UNDECIDABLE;
    if (scope.names.has(call.expression.text)) return UNDECIDABLE;
    if (call.expression.text === "String" && isGlobalName(shape, scope, "String")) return this.scalarText(shape, call.arguments, scope, trail);
    if (call.expression.text === "encodeURIComponent" && isGlobalName(shape, scope, "encodeURIComponent")) {
      const [argument, ...rest] = call.arguments;
      return argument === undefined || rest.length > 0 || ts.isSpreadElement(argument) ? UNDECIDABLE : this.encoded(shape, argument, scope, trail);
    }
    const visited = `${shape.source.fileName}\0call ${call.expression.text}`;
    if (trail.has(visited)) return undecided("recursive", [placeOf(shape, call)]);
    const found = await this.callTargetOf(shape, call.expression.text);
    return found === undefined ? UNDECIDABLE : this.evaluateReturned(found.target, found.declaration, new Set(trail).add(visited));
  }

  private async provided(shape: ValueUnit, token: ts.Expression, trail: ReadonlySet<string>): Promise<Located | undefined> {
    const marker = `${shape.source.fileName}\0provider ${token.getStart(shape.source)}`;
    const reading = this.providerReading;
    if (reading === undefined || this.providerContributions === undefined || trail.has(marker)) return undefined;
    const contributions = await this.providerContributions;
    const bindings = await Promise.all(contributions.map((contribution) => contribution.valueOf(reading.at(token))));
    const targets = [...new Map(bindings.filter((binding) => binding !== undefined).map((binding) => [JSON.stringify([binding.file, binding.start, binding.end]), binding])).values()];
    if (targets.length !== 1) return undefined;
    const expression = reading.expression(targets[0]!);
    const source = this.shapes.get(targets[0]!.file);
    if (expression === undefined || source === undefined) return undefined;
    const owner = ownClassDeclaration(token);
    if (owner !== undefined && await this.constructedWithoutInjector(owner)) return undefined;
    return { shape: source, expression, trail: new Set(trail).add(marker) };
  }

  private constructedWithoutInjector(declaration: ts.ClassDeclaration): Promise<boolean> {
    let read = this.explicitConstructions.get(declaration);
    if (read === undefined) { read = this.explicitConstructionOf(declaration); this.explicitConstructions.set(declaration, read); }
    return read;
  }

  private async explicitConstructionOf(declaration: ts.ClassDeclaration): Promise<boolean> {
    const affected = new Set([declaration]);
    for (const parent of affected) for (const child of await this.subclassesOf(parent)) affected.add(child.declaration);
    for (const shape of this.shapes.values()) {
      const expressions: ts.NewExpression[] = [];
      const visit = (node: ts.Node): void => { if (ts.isNewExpression(node)) expressions.push(node); ts.forEachChild(node, visit); };
      visit(shape.source);
      for (const expression of expressions) {
        if (!ts.isIdentifier(expression.expression)) return true;
        const target = await this.classOf(shape, expression.expression.text);
        if (target !== undefined) { if (affected.has(target.declaration)) return true; continue; }
        const imported = shape.imports.get(expression.expression.text);
        if (imported === undefined || !("external" in await this.modules.resolve(shape.source.fileName, imported.module))) return true;
      }
    }
    return false;
  }

  /** `String(x)` and `x.toString()` write what a template writes for `x`. */
  private async scalarText(shape: FileShape, operands: readonly ts.Expression[], scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    const [operand, ...rest] = operands;
    return operand === undefined || rest.length > 0 ? UNDECIDABLE : this.evaluate(shape, operand, scope, trail);
  }

  /**
   * `encodeURIComponent(x)` escapes `/`, `?` and `#`, so whatever it encodes stays in one segment: a text it states whole
   * is encoded, anything else is a run-time value, unless the snapshot cannot read it and it reads nothing the code fills
   * at run time. A snapshot that may replace the global encoder leaves a text undecided: only its run-time values stay.
   */
  private async encoded(shape: FileShape, argument: ts.Expression, scope: Scope, trail: ReadonlySet<string>): Promise<Read> {
    const read = await this.evaluate(shape, argument, scope, trail);
    if (read.status === "undecided") return readsRunTime(argument, scope) ? RUN_TIME : read;
    const value = read.value;
    if (value.kind === "value") return known({ ...value, encoded: true });
    if (value.cut || value.text.includes(RUN_TIME_HOLE)) return RUN_TIME;
    if (this.unsafeEncoder) return UNDECIDABLE;
    try {
      return stated(encodeURIComponent(value.text));
    } catch {
      return UNDECIDABLE;
    }
  }

  private async callTargetOf(shape: FileShape, name: string): Promise<{ target: FileShape; declaration: ts.Expression | ts.FunctionDeclaration } | undefined> {
    const found = await this.declaredAs(shape, name, CALLABLES, new Set());
    return found === undefined ? undefined : { target: found.shape, declaration: found.declaration };
  }

  /**
   * What a method call writes: what the method of the receiver's class, or the one it inherits, returns, and every
   * override a subclass declares must write the same; `super` calls only the inherited one. A method that reads its own
   * parameters is not read, since its arguments are not substituted.
   */
  private async evaluateMethod(shape: FileShape, callee: ts.PropertyAccessExpression, trail: ReadonlySet<string>, call: ts.CallExpression, scope: Scope): Promise<Read> {
    const receiver = await this.receiverClass(shape, callee.expression);
    if (receiver === undefined || (await this.assignedAbove(receiver, callee.name.text))) return UNDECIDABLE;
    const inherited = await this.inheritedMethod(receiver.shape, receiver.declaration, callee.name.text, new Set());
    if (inherited === undefined || inherited === "ambiguous") return UNDECIDABLE;
    const overrides = receiver.virtual ? await this.overrides(receiver.declaration, callee.name.text, new Set()) : [];
    if (overrides === undefined) return UNDECIDABLE;
    const methods = [inherited, ...overrides];
    let agreed: Read | undefined;
    for (const { shape: held, method } of methods) {
      const visited = `${held.source.fileName}\0method ${method.pos}`;
      if (trail.has(visited)) return undecided("recursive", [placeOf(held, method)]);
      if (readsOwnParameters(method) && !scope.summary) return UNDECIDABLE;
      let args: Map<ts.ParameterDeclaration, Read> | undefined;
      if (scope.summary) {
        args = new Map(scope.arguments);
        for (const [index, parameter] of method.parameters.entries()) {
          const argument = call.arguments[index];
          args.set(parameter, argument === undefined ? RUN_TIME : await this.evaluate(shape, argument, scope, trail));
        }
      }
      const value = await this.evaluateReturned(held, method, new Set(trail).add(visited), args);
      if (value.status === "undecided") return value;
      if (agreed !== undefined && !sameRead(agreed, value)) return undecided("dispatch-disagreement", methods.map(({ shape: owner, method: declared }) => placeOf(owner, declared)));
      agreed = value;
    }
    return agreed ?? UNDECIDABLE;
  }

  /** The class a method call's receiver is an instance of; `virtual` unless the call is a `super` call. */
  private async receiverClass(shape: FileShape, receiver: ts.Expression): Promise<{ shape: FileShape; declaration: ts.ClassDeclaration; virtual: boolean } | undefined> {
    const enclosing = ownClassDeclaration(receiver);
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) return enclosing === undefined ? undefined : { shape, declaration: enclosing, virtual: true };
    if (receiver.kind === ts.SyntaxKind.SuperKeyword) {
      const base = enclosing === undefined ? undefined : baseClassName(enclosing);
      const found = base === undefined ? undefined : await this.classOf(shape, base);
      return found === undefined ? undefined : { ...found, virtual: false };
    }
    const named = await this.ownerClass(shape, receiver);
    const found = named === undefined ? undefined : await this.classOf(named.shape, named.name);
    return found === undefined ? undefined : { ...found, virtual: true };
  }

  /** The method a class declares or inherits under a name. */
  private async inheritedMethod(shape: FileShape, declaration: ts.ClassDeclaration, name: string, visited: Set<ts.ClassDeclaration>): Promise<HeldMethod | "ambiguous" | undefined> {
    if (visited.has(declaration)) return undefined;
    visited.add(declaration);
    const method = methodDeclared(declaration, name);
    if (method === "ambiguous") return method;
    if (method !== undefined) return { shape, method };
    const base = baseClassName(declaration);
    const found = base === undefined ? undefined : await this.classOf(shape, base);
    return found === undefined ? undefined : this.inheritedMethod(found.shape, found.declaration, name, visited);
  }

  /**
   * The methods of that name the subclasses of a class declare, at any depth; none once a subclass assigns the name
   * through `this` or declares it as something the snapshot cannot read as a function.
   */
  private async overrides(declaration: ts.ClassDeclaration, name: string, visited: Set<ts.ClassDeclaration>): Promise<HeldMethod[] | undefined> {
    if (visited.has(declaration)) return [];
    visited.add(declaration);
    const found: HeldMethod[] = [];
    for (const { shape, declaration: subclass } of await this.subclassesOf(declaration)) {
      if (writes(subclass, name)) return undefined;
      const method = methodDeclared(subclass, name);
      if (method === "ambiguous") return undefined;
      if (method !== undefined) found.push({ shape, method });
      const below = await this.overrides(subclass, name, visited);
      if (below === undefined) return undefined;
      found.push(...below);
    }
    return found;
  }

  /** What a call writes: what every return of the function it names writes, undecided when one is or two disagree. */
  private async evaluateReturned(target: FileShape, declaration: ts.Expression | ts.FunctionDeclaration | ts.MethodDeclaration, trail: ReadonlySet<string>, args?: ReadonlyMap<ts.ParameterDeclaration, Read>): Promise<Read> {
    if (!ts.isFunctionDeclaration(declaration) && !ts.isMethodDeclaration(declaration) && !ts.isArrowFunction(declaration) && !ts.isFunctionExpression(declaration)) return this.evaluate(target, declaration, NO_SCOPE, trail);
    let agreed: Read | undefined;
    for (const returned of returnsOf(declaration)) {
      const value = returned === undefined ? UNDECIDABLE : await this.evaluate(target, returned, { ...lexicalScope(returned), ...(args === undefined ? {} : { summary: true as const, arguments: args }) }, trail);
      if (value.status === "undecided") return value;
      if (agreed !== undefined && !sameRead(agreed, value)) return UNDECIDABLE;
      agreed = value;
    }
    return agreed ?? UNDECIDABLE;
  }

  private async importedShape(shape: FileShape, specifier: string): Promise<FileShape | undefined> {
    const file = await this.fileOf(shape.source.fileName, specifier);
    return file === undefined ? undefined : this.shapes.get(file);
  }
}

function baseClassName(declaration: ts.ClassDeclaration): string | undefined {
  const base = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  return base !== undefined && ts.isIdentifier(base) ? base.text : undefined;
}

function writesImportedMember(source: ts.SourceFile, name: string): boolean {
  const target = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === name;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return target(node.expression);
    return false;
  };
  const visit = (node: ts.Node): boolean => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && target(node.left)) return true;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && target(node.operand)) return true;
    if (ts.isDeleteExpression(node) && target(node.expression)) return true;
    return ts.forEachChild(node, (child) => visit(child) || undefined) === true;
  };
  return visit(source);
}

function mayOverrideEncoder(source: ts.SourceFile): boolean {
  const globalNames = new Set(["globalThis", "window", "global", "self"]);
  const globalObject = (node: ts.Node): node is ts.Expression => {
    if (ts.isIdentifier(node)) return globalNames.has(node.text);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return globalObject(node.expression);
    if (ts.isPropertyAccessExpression(node)) return globalObject(node.expression) && globalNames.has(node.name.text);
    if (ts.isElementAccessExpression(node)) return globalObject(node.expression) && (!ts.isStringLiteralLike(node.argumentExpression) || globalNames.has(node.argumentExpression.text));
    return false;
  };
  const target = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === "encodeURIComponent";
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!globalObject(node.expression)) return false;
      return ts.isPropertyAccessExpression(node) ? node.name.text === "encodeURIComponent" : !ts.isStringLiteralLike(node.argumentExpression) || node.argumentExpression.text === "encodeURIComponent";
    }
    return ts.forEachChild(node, (child) => target(child) || undefined) === true;
  };
  const visit = (node: ts.Node): boolean => {
    if (globalObject(node)) {
      const directParent = node.parent;
      if ((ts.isPropertyAccessExpression(directParent) || ts.isPropertyAssignment(directParent) || ts.isVariableDeclaration(directParent) || ts.isModuleDeclaration(directParent)) && directParent.name === node) return false;
      let reference: ts.Expression = node;
      while (true) {
        const parent = reference.parent;
        if ((ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === reference) reference = parent;
        else if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === reference && globalObject(parent)) reference = parent;
        else break;
      }
      const parent = reference.parent;
      const inspected = ts.isTypeOfExpression(parent) || ts.isSpreadAssignment(parent) || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === reference);
      const receiver = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === reference;
      if (!inspected && !receiver) return true;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && target(node.left)) return true;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && target(node.operand)) return true;
    if (ts.isDeleteExpression(node) && target(node.expression)) return true;
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer) && target(node.initializer)) return true;
    return ts.forEachChild(node, (child) => visit(child) || undefined) === true;
  };
  return visit(source);
}

/**
 * The type name a name's nearest binding declares, when that binding is a function parameter the function never assigns
 * nor declares again with a value: then it holds only its argument.
 */
function parameterType(name: ts.Identifier): string | undefined {
  for (let current: ts.Node | undefined = name.parent; current !== undefined; current = current.parent) {
    const binding = ownBindings(current).get(name.text);
    if (binding === undefined) continue;
    const declaration = binding.declaration;
    if (!ts.isParameter(declaration) || !ts.isIdentifier(declaration.name) || declaration.type === undefined) return undefined;
    return reboundIn(current).has(name.text) ? undefined : typeName(declaration.type);
  }
  return undefined;
}

/** The names a function assigns, or declares with a value, anywhere in its body. */
function reboundIn(declaration: ts.Node): ReadonlySet<string> {
  const cached = REBOUND_NAMES.get(declaration);
  if (cached !== undefined) return cached;
  const names = new Set(writesIn(declaration).keys());
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) for (const text of bindingNames(node.name)) names.add(text);
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  REBOUND_NAMES.set(declaration, names);
  return names;
}

/** What the code appends with `+=` to the variable an initializer declares; null when it writes the variable any other way. */
function appendsTo(initializer: ts.Expression): readonly ts.Expression[] | null {
  const writes = writesOf(initializer);
  return writes === undefined ? [] : writes.other || writes.replaced.length > 0 ? null : writes.appended;
}

/** The patterns of the `replace` and `replaceAll` calls through which the code rewrites the variable an initializer declares, when it writes it no other way. */
function replacedBy(initializer: ts.Expression): readonly ts.Expression[] | undefined {
  const writes = writesOf(initializer);
  return writes === undefined || writes.other || writes.appended.length > 0 || writes.replaced.length === 0 ? undefined : writes.replaced;
}

function writesOf(initializer: ts.Expression): VariableWrites | undefined {
  const declaration = initializer.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== initializer || !ts.isIdentifier(declaration.name)) return undefined;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) !== 0) return undefined;
  return writesIn(regionOf(list)).get(declaration.name.text);
}

/** Where a declaration's variable is visible: its block or loop for `let`, its function or file for `var`. */
function regionOf(list: ts.VariableDeclarationList): ts.Node {
  if ((list.flags & ts.NodeFlags.BlockScoped) !== 0) return ts.isVariableStatement(list.parent) ? list.parent.parent : list.parent;
  for (let current: ts.Node = list.parent; ; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return current;
  }
}

interface VariableWrites {
  appended: ts.Expression[];
  /** The pattern of each `replace` or `replaceAll` in a chain that rewrites the variable from itself. */
  replaced: ts.Expression[];
  other: boolean;
}

/** The assignments to each name a region makes, destructuring included: what `+=` appends, what `x = x.replace(...)` rewrites, and whether any other write exists. */
function writesIn(region: ts.Node): ReadonlyMap<string, VariableWrites> {
  const cached = VARIABLE_WRITES.get(region);
  if (cached !== undefined) return cached;
  const writes = new Map<string, VariableWrites>();
  const held = (name: string): VariableWrites => {
    let entry = writes.get(name);
    if (entry === undefined) { entry = { appended: [], replaced: [], other: false }; writes.set(name, entry); }
    return entry;
  };
  const names = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) held(node.text).other = true;
    else ts.forEachChild(node, names);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (ts.isIdentifier(node.left)) {
        const entry = held(node.left.text);
        const patterns = node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? replacementsOf(node.right, node.left.text) : undefined;
        if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) entry.appended.push(node.right);
        else if (patterns !== undefined) entry.replaced.push(...patterns);
        else entry.other = true;
      } else if (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left)) names(node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(region);
  VARIABLE_WRITES.set(region, writes);
  return writes;
}

/** The patterns of a chain of `replace` and `replaceAll` calls that starts from the variable `name`. */
function replacementsOf(chain: ts.Expression, name: string): ts.Expression[] | undefined {
  const node = unwrapped(chain);
  if (ts.isIdentifier(node)) return node.text === name ? [] : undefined;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.arguments.length !== 2 || node.questionDotToken !== undefined) return undefined;
  if (node.expression.name.text !== "replace" && node.expression.name.text !== "replaceAll") return undefined;
  const earlier = replacementsOf(node.expression.expression, name);
  return earlier === undefined ? undefined : [...earlier, node.arguments[0]!];
}

const ANY_FIELD = "*";

function writes(declaration: ts.ClassDeclaration, name: string): boolean {
  const written = writtenFields(declaration);
  return written.has(name) || written.has(ANY_FIELD);
}

/** The fields a class body writes through `this`, `ANY_FIELD` when it writes one it does not name. */
function writtenFields(declaration: ts.ClassDeclaration): ReadonlySet<string> {
  const cached = WRITTEN_FIELDS.get(declaration);
  if (cached !== undefined) return cached;
  const written = new Set<string>();
  const target = (node: ts.Expression): void => {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) written.add(node.name.text);
    if (ts.isElementAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) written.add(ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : ANY_FIELD);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) target(node.operand);
    if (ts.isDeleteExpression(node)) target(node.expression);
    if (ts.isCallExpression(node) && node.expression.getText() === "Object.assign" && node.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword) written.add(ANY_FIELD);
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  WRITTEN_FIELDS.set(declaration, written);
  return written;
}

/** Whether an expression reads a value the code fills at run time: `this`, or a name the code around it binds. */
function readsRunTime(node: ts.Node, scope: Scope): boolean {
  if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isIdentifier(node)) return scope.names.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return readsRunTime(node.expression, scope);
  if (ts.isPropertyAssignment(node)) return readsRunTime(node.initializer, scope);
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, (child) => readsRunTime(child, scope) || undefined) === true;
}

/** Whether a name is the global of that name where the code reads it: nothing the file or the code around declares or imports it. */
function isGlobalName(shape: FileShape, scope: Scope, name: string): boolean {
  return !scope.names.has(name) && !shape.imports.has(name) && !shape.bindings.has(name);
}

function functionNamed(shape: FileShape, name: string): ts.FunctionDeclaration | undefined {
  return shape.source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
}

/**
 * What a function returns from its own body, the functions it declares aside: its expression body, or the expression of
 * every `return`, with undefined for a bare `return` and for an end the body reaches without returning.
 */
function returnsOf(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression): (ts.Expression | undefined)[] {
  if (node.body === undefined) return [undefined];
  if (!ts.isBlock(node.body)) return [node.body];
  const returned: (ts.Expression | undefined)[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child)) returned.push(child.expression);
    ts.forEachChild(child, visit);
  };
  visit(node.body);
  const last = node.body.statements.at(-1);
  if (last === undefined || !(ts.isReturnStatement(last) || ts.isThrowStatement(last))) returned.push(undefined);
  return returned;
}

/** Whether a returned value states a request: `undefined`, `void x` and no value at all state none. */
function requestsSomething(returned: ts.Expression | undefined): returned is ts.Expression {
  return returned !== undefined && !(ts.isIdentifier(returned) && returned.text === "undefined") && !ts.isVoidExpression(returned);
}

/** A call whose target the snapshot does not decide: unknown at the call, with why. */
function unresolvedAt(shape: FileShape, call: ts.CallExpression, why: Undecided = UNDECIDABLE): ReadTarget {
  return undecidedTarget(why, placeOf(shape, call));
}

/** Where a node is written, as evidence. */
function placeOf(shape: FileShape, node: ts.Node) {
  return { path: shape.source.fileName, line: lineOf(shape.source, node) };
}

/**
 * An enum member whose initializer states a text. Any other initializer is undecided: it may name another member, which
 * a file constant of the same name would answer wrongly.
 */
function enumMember(shape: FileShape, declaration: ts.EnumDeclaration, name: string, trail: ReadonlySet<string>): Located | undefined {
  const member = declaration.members.find((candidate) => (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === name);
  const initializer = member?.initializer;
  return initializer !== undefined && ts.isStringLiteralLike(initializer) ? { shape, expression: initializer, trail } : undefined;
}

function verbOf(name: string): HttpTarget["method"] {
  return requestMethodOf(name.toUpperCase()) ?? "GET";
}

/**
 * Whether a text reaches the query or the fragment of a URL, after which nothing more decides the path. An evaluation stops
 * there, so its text is complete only up to that point.
 */
function endsPath(text: string): boolean {
  return text.includes("?") || text.includes("#");
}

/**
 * Whether every run-time value of a path starts a segment of it. One that starts the URL, or follows text of its segment,
 * may hold an origin, a base path or several segments, so it stands for no segment.
 */
function startsSegments(path: string): boolean {
  for (let at = path.indexOf(RUN_TIME_HOLE); at !== -1; at = path.indexOf(RUN_TIME_HOLE, at + RUN_TIME_HOLE.length)) {
    if (path[at - 1] !== "/") return false;
  }
  return true;
}

/** `:name` stands for a value the code fills, like `${expr}`. */
function namedHoles(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ? RUN_TIME_HOLE : segment))
    .join("/");
}

/** The class declaration whose instance `this` or `super` denotes at a node. */
function ownClassDeclaration(node: ts.Node): ts.ClassDeclaration | undefined {
  const owner = thisClass(node);
  return owner !== undefined && ts.isClassDeclaration(owner) ? owner : undefined;
}

/** The text a path part states. */
function stated(text: string): Read {
  return known({ kind: "text", text });
}

function cutAt(text: string, holes?: readonly (number | undefined)[], encodings?: readonly boolean[]): Read {
  return known({ kind: "text", text, cut: true, ...(holes === undefined ? {} : { holes }), ...(encodings === undefined ? {} : { encodings }) });
}

/** Whether a read is a value the code fills at run time. */
function isRunTime(read: Read): boolean {
  return read.status === "known" && read.value.kind === "value";
}

/** Whether two decided reads write the same thing. */
function sameRead(first: Read, second: Read): boolean {
  return first.status === "known" && second.status === "known"
    && first.value.kind === second.value.kind && written(first.value) === written(second.value)
    && JSON.stringify(holesOf(first.value)) === JSON.stringify(holesOf(second.value))
    && JSON.stringify(encodingsOf(first.value)) === JSON.stringify(encodingsOf(second.value));
}

/** What an evaluation writes inside a path: the text it states, or the placeholder a run-time value leaves. */
function written(evaluation: Evaluation): string {
  return evaluation.kind === "text" ? evaluation.text : RUN_TIME_HOLE;
}

function holesOf(evaluation: Evaluation): readonly (number | undefined)[] {
  return evaluation.kind === "value" ? [evaluation.parameter] : evaluation.holes ?? evaluation.text.split(RUN_TIME_HOLE).slice(1).map(() => undefined);
}

function encodingsOf(evaluation: Evaluation): readonly boolean[] {
  return evaluation.kind === "value" ? [evaluation.encoded === true] : evaluation.encodings ?? holesOf(evaluation).map(() => false);
}

/** The text a read states; undefined for a run-time value and for a part the snapshot does not decide. */
function textOf(read: Read): string | undefined {
  return read.status === "known" && read.value.kind === "text" ? read.value.text : undefined;
}

function ancestorsOf(node: ts.Node, source: ts.SourceFile): { symbol: string; line: number; endLine: number }[] {
  const ancestors: { symbol: string; line: number; endLine: number }[] = [];
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (!(ts.isClassDeclaration(current) || ts.isClassExpression(current) || ts.isMethodDeclaration(current) || ts.isPropertyDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isVariableDeclaration(current))) continue;
    const name = current.name;
    if (name === undefined || !ts.isIdentifier(name)) continue;
    ancestors.push({ symbol: name.text, line: lineOf(source, current), endLine: source.getLineAndCharacterOfPosition(current.getEnd()).line + 1 });
  }
  return ancestors;
}

export function symbolOf(node: ts.Node): string | undefined {
  let className: string | undefined;
  let member: string | undefined;
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (member === undefined && (ts.isMethodDeclaration(current) || ts.isPropertyDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || (ts.isVariableDeclaration(current) && current.initializer !== undefined && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))))) {
      const name = current.name;
      if (name !== undefined && ts.isIdentifier(name)) member = name.text;
      else if (ts.isFunctionDeclaration(current)) member = current.name?.text;
    }
    if (ts.isClassDeclaration(current) && current.name !== undefined) {
      className = current.name.text;
      break;
    }
  }
  if (className === undefined) return member;
  return member === undefined ? className : `${className}.${member}`;
}

function originOf(node: ts.Node, kind: PlacedOrigin["kind"]): PlacedOrigin {
  const source = node.getSourceFile();
  const at = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { kind, file: source.fileName, line: at.line + 1, column: at.character };
}
