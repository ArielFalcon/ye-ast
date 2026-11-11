import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { Evidence } from "../../domain/shared/fact.ts";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { requestMethodOf } from "../../domain/entrypoints/http-route.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { objectOf, ownBindings, propertyOf, sourceBindings } from "./syntax.ts";
import { recoveredModuleShape, type ModuleShape } from "./module-shape.ts";
import { known, undecided, type Evaluated } from "../../domain/topology/evaluated.ts";
import { RUN_TIME_HOLE } from "../../domain/topology/path-template.ts";
import type { BodySource, ForwardingRow, PathCondition, RequestShape, RequestSummary, ResultShape, SummaryCause, SummaryGap } from "../../domain/topology/request-summary.ts";
import { sourceTree } from "./source-tree.ts";
import { requestSummaryGraph } from "./request-summary-graph.ts";
import { applyRequestValue, readRequestValue, UNKNOWN_VALUE, type RequestValue } from "./request-values.ts";

export type DeclarationKey = string;

/** A path the resolver states: its text, and `holes` with one entry per `{}` of the text, in order. */
export interface PathRead {
  status: "known";
  text: string;
  holes: readonly (number | undefined)[];
  encodings?: readonly boolean[];
  value?: RequestValue;
  unresolved?: SummaryGap;
}

export interface SummaryResolver {
  valueFacts?(file: string, expression: ts.Expression): Promise<RequestValue>;
  /**
   * What an expression states in a declaration's scope: its text with `{}` per run-time value, and `holes` with one entry
   * per `{}` in order, the declaration parameter index that value is (undefined when it is not a parameter), or why not.
   */
  evaluate(file: string, expression: ts.Expression): Promise<PathRead | { status: "undecided"; cause: SummaryCause; evidence: readonly Evidence[] }>;
  /** The declaration a call resolves to, an explicit gap when dispatch is ambiguous, or undefined outside the snapshot. */
  calleeOf(file: string, call: ts.CallExpression): Promise<{ key: DeclarationKey; file: string; body: ts.Node | undefined } | { candidates: readonly { key: DeclarationKey; file: string; body: ts.Node | undefined }[] } | { gap: SummaryGap } | undefined>;
  /** Whether the call's receiver is an Angular `HttpClient`, typed by the B11 reader (fields, parameters, inherited fields). It answers receiver typing only; it does not decide what a request is. */
  clientReceiver(file: string, call: ts.CallExpression): Promise<boolean>;
}

/**
 * The closed table of calls that hand a value on without being a declaration of their own. `defer`, `from`,
 * `firstValueFrom`, `signal`, `computed`, `asReadonly`, `resource` and `linkedSignal` are the constructs the TypeScript
 * pack knows; a construct outside the table contributes nothing.
 */
export const FORWARDING_ROWS: readonly ForwardingRow[] = [
  { name: "defer", carries: { kind: "argument", index: 0 }, callback: [], returns: { kind: "container", container: "observable" } },
  { name: "from", carries: { kind: "argument", index: 0 }, returns: { kind: "container", container: "observable" } },
  { name: "firstValueFrom", carries: { kind: "argument", index: 0 }, returns: { kind: "same" } },
  { name: "signal", carries: { kind: "argument", index: 0 }, returns: { kind: "container", container: "signal" } },
  { name: "computed", carries: { kind: "argument", index: 0 }, callback: [], returns: { kind: "container", container: "signal" } },
  { name: "asReadonly", carries: { kind: "receiver" }, returns: { kind: "same" } },
  { name: "resource", carries: { kind: "argument", index: 0 }, returns: { kind: "container", container: "resource" } },
  { name: "linkedSignal", carries: { kind: "argument", index: 0 }, returns: { kind: "container", container: "signal" } },
];

interface Declaration {
  key: DeclarationKey;
  file: string;
  body: ts.Node;
  parameters: readonly string[];
  signature: ts.Node;
}

/** One argument a call writes, folded in the caller's scope: its text and the parameter each hole reads. */
interface Argument {
  /** The folded text, `{}` for a run-time value; undefined when the snapshot does not decide it. */
  text: string | undefined;
  /** One entry per `{}` of `text`, in order: the caller's parameter index, or undefined for another run-time value. */
  holes: readonly (number | undefined)[];
  /** The truthiness a literal states; undefined when the argument is not a literal, so it decides nothing. */
  encodings: readonly boolean[];
  truthy: boolean | undefined;
  /** The verb a literal argument states, when it is one. */
  verb: HttpMethod | undefined;
  /** The caller's own parameter the argument is, when it is one. */
  parameter: number | undefined;
}

/** A call from one declaration to another, with the arguments the caller writes, each folded in the caller's scope. */
interface Edge {
  callee: DeclarationKey;
  /** The declaration that makes the call, by its declaration place, and the call itself. */
  caller: Evidence;
  call: Evidence;
  args: readonly Argument[];
  values?: readonly RequestValue[];
  /** The callee is a declaration of the snapshot whose body the snapshot could not read. */
  unread: boolean;
  node: ts.CallExpression;
}

/** The verbs a client receiver is called with to make a request: `HttpClient`'s, and `fetch` of a client wrapper. */
export const VERBS: ReadonlySet<string> = new Set(["get", "head", "post", "put", "patch", "delete", "options", "request"]);
const MEMBER_FETCH = "fetch";
const HTTP_CLIENT_PACKAGE = "@angular/common/http";
/** What a file's syntax states that decides which client a call names: its imports, and the names it binds itself. */
export interface RequestFileShape {
  imports: ModuleShape["imports"];
  bindings: ReadonlySet<string>;
}

/** The verb a request states: established by what the code writes, or undecided, with the expression that states it when one does. */
export type RequestMethod = { kind: "established"; verb: HttpMethod } | { kind: "undecided"; stated?: ts.Expression };

/** The body a request sends, with the call argument that carries it: the expression, no body, or a carrier the syntax does not read. */
export type RequestBodyRead = { kind: "established"; expression: ts.Expression; argument: number } | { kind: "none" } | { kind: "unknown"; argument: number };

/**
 * Whether a call is a request of the client vocabulary. A global `fetch` and an `httpResource` imported from Angular are
 * requests; a call that spells a client verb on a receiver is undecided until the receiver's type is known, which is a
 * fact of its own; every other call, a `fetch` or an `httpResource` the file binds itself included, is not a request.
 */
export type RequestCall =
  | { kind: "request"; client: "fetch" | "resource"; path: ts.Expression | undefined; method: RequestMethod; body: RequestBodyRead }
  | { kind: "not-request" }
  | { kind: "undecided"; reason: "receiver-type"; verb: string; path: ts.Expression | undefined; method: RequestMethod; body: RequestBodyRead };

const NOT_REQUEST: RequestCall = { kind: "not-request" };
const NO_BODY: RequestBodyRead = { kind: "none" };
const GET: RequestMethod = { kind: "established", verb: "GET" };
const FILE_SHAPES = new WeakMap<ts.SourceFile, RequestFileShape>();

export function requestFileShapeOf(tree: ts.SourceFile): RequestFileShape {
  let shape = FILE_SHAPES.get(tree);
  if (shape === undefined) {
    shape = { imports: recoveredModuleShape(tree).imports, bindings: sourceBindings(tree) };
    FILE_SHAPES.set(tree, shape);
  }
  return shape;
}

/** The one answer to "is this call a request", with its method and body, read against the shape of the file that writes it. */
export function requestCallOf(shape: RequestFileShape, call: ts.CallExpression): RequestCall {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === "fetch") return isGlobalAt(shape, call, callee.text) ? fetchRequest(call) : NOT_REQUEST;
  if (isHttpResource(shape, callee)) return { kind: "request", client: "resource", path: undefined, method: resourceMethod(call), body: NO_BODY };
  if (!ts.isPropertyAccessExpression(callee)) return NOT_REQUEST;
  const verb = callee.name.text;
  if (verb === MEMBER_FETCH) return { kind: "undecided", reason: "receiver-type", verb, path: call.arguments[0], method: GET, body: NO_BODY };
  if (!VERBS.has(verb)) return NOT_REQUEST;
  if (verb !== "request") return { kind: "undecided", reason: "receiver-type", verb, path: call.arguments[0], method: literalMethod(undefined, verb), body: BODY_VERBS.has(verb) ? argumentBody(call, 1) : NO_BODY };
  const [first, second] = call.arguments;
  const sent = first !== undefined && ts.isNewExpression(first) && isHttpPackageName(shape, first.expression, "HttpRequest") ? first.arguments : undefined;
  const [method, path] = sent ?? [first, second];
  return { kind: "undecided", reason: "receiver-type", verb, path, method: method === undefined ? { kind: "undecided" } : literalMethod(method, undefined), body: NO_BODY };
}

/** `fetch(url, init)`: the method and the body the init object states; GET with no body without an init. */
function fetchRequest(call: ts.CallExpression): RequestCall {
  const [path, init] = call.arguments;
  if (init === undefined) return { kind: "request", client: "fetch", path, method: GET, body: NO_BODY };
  const object = objectOf(init);
  if (object === undefined) return { kind: "request", client: "fetch", path, method: { kind: "undecided" }, body: { kind: "unknown", argument: 1 } };
  const method = memberOf(object, "method");
  const body = memberOf(object, "body");
  return {
    kind: "request",
    client: "fetch",
    path,
    method: method === undefined ? GET : method.status === "undecided" ? { kind: "undecided" } : literalMethod(method.value, undefined),
    body: body === undefined ? NO_BODY : body.status === "undecided" ? { kind: "unknown", argument: 1 } : { kind: "established", expression: body.value, argument: 1 },
  };
}

/** `httpResource(() => url)` is a GET; a function that returns anything else states its method in what it returns. */
function resourceMethod(call: ts.CallExpression): RequestMethod {
  const [first] = call.arguments;
  return first !== undefined && ts.isArrowFunction(first) && !ts.isBlock(first.body) && objectOf(first.body) === undefined ? GET : { kind: "undecided" };
}

/** The verb a literal or a verb name states; undecided, with the expression, when the code writes a value. */
function literalMethod(expression: ts.Expression | undefined, verbName: string | undefined): RequestMethod {
  const node = expression === undefined ? undefined : unwrap(expression);
  const text = verbName ?? (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);
  const verb = text === undefined ? undefined : requestMethodOf(text.toUpperCase());
  return verb !== undefined ? { kind: "established", verb } : expression === undefined ? { kind: "undecided" } : { kind: "undecided", stated: expression };
}

function argumentBody(call: ts.CallExpression, argument: number): RequestBodyRead {
  const expression = call.arguments[argument];
  return expression === undefined ? NO_BODY : { kind: "established", expression, argument };
}

/** Whether a name is the global of that name where a node reads it: nothing around it, in its file or its imports binds it. */
function isGlobalAt(shape: RequestFileShape, node: ts.Node, name: string): boolean {
  if (shape.imports.has(name) || shape.bindings.has(name)) return false;
  for (let scope = node.parent; scope !== undefined && !ts.isSourceFile(scope); scope = scope.parent) if (ownBindings(scope).has(name)) return false;
  return true;
}

/** Whether an expression names `httpResource` or one of its variants (`httpResource.text`), imported from Angular. */
function isHttpResource(shape: RequestFileShape, callee: ts.Expression): boolean {
  const named = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  return isHttpPackageName(shape, named, "httpResource");
}

function isHttpPackageName(shape: RequestFileShape, expression: ts.Expression, name: string): boolean {
  if (!ts.isIdentifier(expression)) return false;
  const imported = shape.imports.get(expression.text);
  return imported?.module === HTTP_CLIENT_PACKAGE && imported.imported === name;
}

/**
 * The expression an object literal states for a member, a shorthand's name included; undecided when a spread or a
 * computed name after it may state the member instead.
 */
export function memberOf(object: ts.ObjectLiteralExpression, name: string): Evaluated<ts.Expression> | undefined {
  let found: Evaluated<ts.Expression> | undefined;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property) || (property.name !== undefined && ts.isComputedPropertyName(property.name))) found = undecided("destination-undecidable");
    else if (property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) {
      found = ts.isPropertyAssignment(property) ? known(property.initializer) : ts.isShorthandPropertyAssignment(property) ? known(property.name) : undecided("destination-undecidable");
    }
  }
  return found;
}

/** The call each shape states at its leaf, so a hop names the leaf's call and not the caller's. */
const LEAF_CALLS = new WeakMap<RequestShape, Evidence>();
/** The declarations a shape has passed through, so a cycle is not entered twice and a hop chain stays finite. */
const SHAPE_ORIGINS = new WeakMap<RequestShape, ReadonlySet<DeclarationKey>>();
/** The parameter that fills a shape's verb, for a leaf whose verb is a value. */
const METHOD_PARAMETERS = new WeakMap<RequestShape, number>();
interface ShapeTrace {
  leaf: ts.CallExpression;
  selected: RequestShape;
  calls: readonly ts.CallExpression[];
  allCalls: readonly ts.CallExpression[];
  targets: readonly { call: ts.CallExpression; key: DeclarationKey }[];
  bound: boolean;
  conditional: boolean;
}
const SHAPE_TRACES = new WeakMap<RequestShape, ShapeTrace>();
const SHAPE_ENCODINGS = new WeakMap<RequestShape, readonly boolean[]>();
const SHAPE_VALUES = new WeakMap<RequestShape, RequestValue>();
const GAP_CALLS = new WeakMap<SummaryGap, Set<ts.CallExpression>>();
function atCall(gap: SummaryGap, call: ts.CallExpression): SummaryGap {
  const calls = GAP_CALLS.get(gap) ?? new Set<ts.CallExpression>();
  calls.add(call);
  GAP_CALLS.set(gap, calls);
  return gap;
}
export function requestGapCalls(gap: SummaryGap): ReadonlySet<ts.CallExpression> | undefined {
  return GAP_CALLS.get(gap);
}
export function requestShapeTrace(shape: RequestShape): ShapeTrace | undefined {
  return SHAPE_TRACES.get(shape);
}
const SUMMARIES = new WeakMap<readonly SourceFile[], WeakMap<SummaryResolver, Promise<ReadonlyMap<DeclarationKey, RequestSummary>>>>();

/**
 * The request shapes and gaps of every declaration in the snapshot: its own leaves, plus each call to another declaration
 * substituted into that declaration's shapes, grown to a fixpoint. A call to a declaration the snapshot does not hold
 * contributes nothing: the pack cannot claim that an unread callee issues a request. Memoized by the `files` array and
 * the resolver's identity: one read computes it once.
 */
export function summariesOf(files: readonly SourceFile[], resolver: SummaryResolver): Promise<ReadonlyMap<DeclarationKey, RequestSummary>> {
  let byResolver = SUMMARIES.get(files);
  if (byResolver === undefined) {
    byResolver = new WeakMap();
    SUMMARIES.set(files, byResolver);
  }
  const cached = byResolver.get(resolver);
  if (cached !== undefined) return cached;
  const computed = computeSummaries(files, resolver);
  byResolver.set(resolver, computed);
  return computed;
}

async function computeSummaries(files: readonly SourceFile[], resolver: SummaryResolver): Promise<ReadonlyMap<DeclarationKey, RequestSummary>> {
  const bodies = declarationsOf(files);
  const own = new Map<DeclarationKey, RequestShape[]>();
  const edges = new Map<DeclarationKey, Edge[]>();
  const scanned = new Map<DeclarationKey, SummaryGap[]>();
  const disagreements = new Map<DeclarationKey, SummaryGap[]>();
  const returns = new Map<DeclarationKey, ts.Expression[]>();
  for (const [key, declarations] of bodies) {
    if (declarations.length > 1) {
      own.set(key, []);
      edges.set(key, []);
      scanned.set(key, []);
      disagreements.set(key, [{ cause: "dispatch-disagreement", evidence: declarations.map((declaration) => placeOf(declaration.file, declaration.signature)) }]);
      continue;
    }
    const [declaration] = declarations;
    if (declaration === undefined) continue;
    const found = await scan(declaration, resolver);
    own.set(key, found.shapes);
    edges.set(key, found.edges);
    scanned.set(key, found.gaps);
    returns.set(key, found.returns);
  }
  const graph = requestSummaryGraph(edges);
  const shapes = new Map<DeclarationKey, RequestShape[]>(own);
  const substitutionGaps = new Map<DeclarationKey, SummaryGap[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of bodies.keys()) {
      const current = shapes.get(key) ?? [];
      const grown = [...current];
      for (const edge of edges.get(key) ?? []) {
        const candidates = shapes.get(edge.callee) ?? [];
        for (const inner of candidates) {
          const origins = SHAPE_ORIGINS.get(inner) ?? new Set<DeclarationKey>();
          if (origins.has(key)) continue;
          const trace = SHAPE_TRACES.get(inner);
          const conditionalHole = trace?.conditional === true && candidates.some((candidate) => SHAPE_TRACES.get(candidate)?.leaf === trace.leaf && candidate.holes.some((index) => index !== undefined && edge.args[index] !== undefined));
          const substituted = substitute(inner, edge, conditionalHole);
          if (substituted.kind === "gap") {
            recordGap(substitutionGaps, key, atCall({ cause: substituted.cause, evidence: [edge.call] }, edge.node));
            continue;
          }
          if (substituted.kind !== "shape") continue;
          SHAPE_ORIGINS.set(substituted.shape, new Set([...origins, key]));
          if (!grown.some((existing) => sameRequest(existing, substituted.shape))) grown.push(substituted.shape);
        }
      }
      if (grown.length !== current.length) {
        shapes.set(key, grown.sort(compareShapes));
        changed = true;
      }
    }
  }
  const ownGaps = new Map<DeclarationKey, SummaryGap[]>();
  for (const key of bodies.keys()) {
    const calls = edges.get(key) ?? [];
    ownGaps.set(key, [...(disagreements.get(key) ?? []), ...(scanned.get(key) ?? []), ...unreadGaps(calls), ...(substitutionGaps.get(key) ?? [])]);
  }
  const seeds = new Set([...bodies.keys()].filter((key) => (own.get(key)?.length ?? 0) > 0 || (ownGaps.get(key)?.length ?? 0) > 0));
  const requestReachable = graph.requestReachable(seeds);
  for (const key of bodies.keys()) {
    if (!requestReachable.has(key)) continue;
    const recursive = (edges.get(key) ?? []).filter((edge) => graph.isRecursive(key, edge.callee)).map((edge): SummaryGap => atCall({ cause: "recursive", evidence: [edge.call] }, edge.node));
    ownGaps.set(key, [...(ownGaps.get(key) ?? []), ...recursive]);
  }
  const causes = graph.causeIndex(new Map([...ownGaps].map(([key, gaps]) => [key, gaps.map((gap) => gap.cause)])));
  const gapsOf = new Map<DeclarationKey, SummaryGap[]>();
  for (const key of bodies.keys()) {
    gapsOf.set(key, distinctGaps([...(ownGaps.get(key) ?? []), ...calledGaps(edges.get(key) ?? [], causes.forCaller(key))]));
  }
  const results = await resultsOf(bodies, returns, edges, resolver);
  const summaries = new Map<DeclarationKey, RequestSummary>();
  for (const key of bodies.keys()) {
    summaries.set(key, { shapes: shapes.get(key) ?? [], result: results.get(key) ?? { kind: "none" }, gaps: gapsOf.get(key) ?? [] });
  }
  return summaries;
}

/**
 * The result of each declaration, read from its returns alone: a request call is a body, a call to a declaration with a
 * result keeps it, a projection carries its access path, a forwarding call names its container, returns that disagree are
 * unknown. A call site elsewhere in the body states a gap, never the result.
 */
async function resultsOf(
  bodies: ReadonlyMap<DeclarationKey, readonly Declaration[]>,
  returns: ReadonlyMap<DeclarationKey, readonly ts.Expression[]>,
  edges: ReadonlyMap<DeclarationKey, readonly Edge[]>,
  resolver: SummaryResolver,
): Promise<Map<DeclarationKey, ResultShape>> {
  const results = new Map<DeclarationKey, ResultShape>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, declarations] of bodies) {
      if (results.has(key)) continue;
      const declaration = declarations[0];
      if (declaration === undefined) continue;
      const decided: ResultShape | undefined =
        declarations.length > 1
          ? { kind: "unknown", cause: "dispatch-disagreement", evidence: declarations.map((each) => placeOf(each.file, each.signature)) }
          : await agreedResult(returns.get(key) ?? [], declaration.file, { file: declaration.file, key, edges, results, resolver });
      if (decided === undefined) continue;
      results.set(key, decided);
      changed = true;
    }
  }
  return results;
}

/** The body a returned expression carries: a request call's own body, or the body a called declaration returns. */
interface ReturnScope {
  file: string;
  key: DeclarationKey;
  edges: ReadonlyMap<DeclarationKey, readonly Edge[]>;
  results: ReadonlyMap<DeclarationKey, ResultShape>;
  resolver: SummaryResolver;
}

/** The one result a set of returns states: their common body, none, or an unknown result naming why they disagree. */
async function agreedResult(expressions: readonly ts.Expression[], file: string, scope: ReturnScope): Promise<ResultShape | undefined> {
  const found: ResultShape[] = [];
  for (const expression of expressions) {
    const body = await bodyOf(expression, scope);
    if (body === undefined) return undefined;
    found.push(body);
  }
  if (found.length === 0) return { kind: "none" };
  const distinct = distinctResults(found);
  const first = distinct[0];
  if (distinct.length > 1 || first === undefined) return { kind: "unknown", cause: "dispatch-disagreement", evidence: expressions.map((expression) => placeOf(file, expression)) };
  return first;
}

async function bodyOf(expression: ts.Expression, scope: ReturnScope): Promise<ResultShape | undefined> {
  const { file, key, edges, results, resolver } = scope;
  const node = unwrap(expression);
  if (!ts.isCallExpression(node)) return { kind: "none" };
  const leaf = await leafResultOf(file, node, resolver);
  if (leaf !== undefined) return leaf;
  const projection = await projectionOf(node, scope);
  if (projection !== undefined) return projection;
  const calls = (edges.get(key) ?? []).filter((candidate) => candidate.node === node);
  if (calls.length > 0) {
    if (calls.some((edge) => edge.unread)) return { kind: "unknown", cause: "source-not-read", evidence: [placeOf(file, node)] };
    const candidates = calls.map((edge) => results.get(edge.callee));
    if (candidates.some((candidate) => candidate === undefined)) return undefined;
    const decided = distinctResults(candidates as ResultShape[]);
    return decided.length === 1 ? decided[0] : { kind: "unknown", cause: "dispatch-disagreement", evidence: [placeOf(file, node)] };
  }
  const target = await resolver.calleeOf(file, node);
  if (target !== undefined && "gap" in target) return { kind: "unknown", ...target.gap };
  const row = forwardingRowOf(node);
  if (row !== undefined) return forwardingResult(node, row, scope);
  return { kind: "none" };
}

/** The body a client leaf carries, with the container and the way the response is observed; undefined when it is no leaf. */
async function leafResultOf(file: string, call: ts.CallExpression, resolver: SummaryResolver): Promise<ResultShape | undefined> {
  const recognized = requestCallOf(requestFileShapeOf(call.getSourceFile()), call);
  if (recognized.kind === "not-request") return undefined;
  if (recognized.kind === "request") return { kind: "body", container: recognized.client === "resource" ? "resource" : "promise", observed: "body" };
  if (!(await resolver.clientReceiver(file, call))) return undefined;
  const observed = observedOf(call);
  if (observed === undefined) return { kind: "unknown", cause: "destination-undecidable", evidence: [placeOf(file, call)] };
  return { kind: "body", container: "observable", observed };
}

/**
 * How a request call observes its response: `response` when its options object states `observe: 'response'`, `body` when
 * it states nothing else, and undefined when the options the code writes do not decide it.
 */
function observedOf(call: ts.CallExpression): "body" | "response" | undefined {
  const options = call.arguments[1];
  if (options === undefined) return "body";
  if (!ts.isObjectLiteralExpression(options)) return undefined;
  if (options.properties.some((property) => ts.isSpreadAssignment(property))) return undefined;
  const observe = propertyOf(options, "observe");
  if (observe === undefined) return "body";
  if (!ts.isStringLiteral(observe)) return undefined;
  return observe.text === "response" ? "response" : observe.text === "body" ? "body" : undefined;
}

/** `x.pipe(map(fn))` carries the body of `x` projected to the access path `fn` returns, or an unknown result. */
async function projectionOf(call: ts.CallExpression, scope: ReturnScope): Promise<ResultShape | undefined> {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "pipe") return undefined;
  let callback: ts.Expression | undefined;
  for (const argument of call.arguments) {
    if (ts.isCallExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === "map") {
      callback = argument.arguments[0];
      break;
    }
  }
  if (callback === undefined) return undefined;
  const source = await bodyOf(call.expression.expression, scope);
  if (source === undefined) return undefined;
  if (source.kind !== "body") return source;
  const projection = projectionPathOf(callback);
  if (projection === undefined) return { kind: "unknown", cause: "destination-undecidable", evidence: [placeOf(scope.file, callback)] };
  return { ...source, projection };
}

/** The access path a projection returns over its own parameter, or undefined when it returns something else. */
function projectionPathOf(expression: ts.Expression): readonly string[] | undefined {
  const fn = unwrap(expression);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
  const [parameter] = fn.parameters;
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) return undefined;
  const body = ts.isBlock(fn.body) ? onlyReturnOf(fn.body) : fn.body;
  return body === undefined ? undefined : accessPathOf(body, parameter.name.text);
}

function accessPathOf(expression: ts.Expression, root: string): readonly string[] | undefined {
  const segments: string[] = [];
  let current = unwrap(expression);
  while (ts.isPropertyAccessExpression(current)) {
    if (!ts.isIdentifier(current.name)) return undefined;
    segments.unshift(current.name.text);
    current = unwrap(current.expression);
  }
  if (segments.length === 0 || !ts.isIdentifier(current) || current.text !== root) return undefined;
  return segments;
}

/** The one expression a block returns, when it has exactly one; a block with none or several states no single path. */
function onlyReturnOf(block: ts.Block): ts.Expression | undefined {
  const found = returnExpressionsOf(block);
  return found.length === 1 ? found[0] : undefined;
}

/** The call that hands a value on from the closed table, or undefined when the call matches no row. */
export function forwardingRowOf(call: ts.CallExpression): ForwardingRow | undefined {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name === undefined ? undefined : FORWARDING_ROWS.find((row) => row.name === name);
}

/**
 * The expression a forwarding row carries: the argument or receiver the code writes, the `loader`/`stream` a resource's
 * options object holds, or undefined when the call does not write the position the row names.
 */
function carriedOf(call: ts.CallExpression, row: ForwardingRow): ts.Expression | undefined {
  if (row.carries.kind === "receiver") return ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
  const argument = call.arguments[row.carries.index];
  if (argument === undefined) return undefined;
  if (row.name !== "resource") return argument;
  if (!ts.isObjectLiteralExpression(argument)) return undefined;
  return propertyOf(argument, "loader") ?? propertyOf(argument, "stream");
}

/** The result a forwarding call states: the carried outcome in the row's container, never a guess at another position. */
async function forwardingResult(call: ts.CallExpression, row: ForwardingRow, scope: ReturnScope): Promise<ResultShape | undefined> {
  const carried = carriedOf(call, row);
  if (carried === undefined) return { kind: "unknown", cause: "destination-undecidable", evidence: [placeOf(scope.file, call)] };
  const outcome = await carriedOutcome(carried, row, scope);
  if (outcome === undefined) return undefined;
  if (row.returns.kind === "same") return outcome.kind === "body" ? { ...outcome, container: "plain" } : outcome;
  if (row.returns.container === "signal") return { kind: "unknown", cause: "destination-undecidable", evidence: [placeOf(scope.file, call)] };
  return outcome.kind === "body" ? { ...outcome, container: row.returns.container } : outcome;
}

/** The outcome of the expression a row carries: a callback's body for the rows that carry one, the expression otherwise. */
async function carriedOutcome(carried: ts.Expression, row: ForwardingRow, scope: ReturnScope): Promise<ResultShape | undefined> {
  const fn = unwrap(carried);
  const enters = (row.callback !== undefined || row.name === "resource") && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn));
  if (!enters || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return bodyOf(fn, scope);
  if (!ts.isBlock(fn.body)) return bodyOf(fn.body, scope);
  return agreedResult(returnExpressionsOf(fn.body), scope.file, scope);
}

/** A call whose callee body the snapshot could not read leaves the caller's request unknown at that call, never absent. */
function unreadGaps(edges: readonly Edge[]): SummaryGap[] {
  return edges.filter((edge) => edge.unread).map((edge) => atCall({ cause: "source-not-read", evidence: [edge.call] }, edge.node));
}

/** The gaps a declaration inherits from the declarations it reaches, each at the call that reaches it. */
function calledGaps(edges: readonly Edge[], causes: (callee: DeclarationKey) => ReadonlySet<SummaryCause>): SummaryGap[] {
  const inherited = new Map<string, SummaryGap>();
  for (const edge of edges) {
    for (const cause of causes(edge.callee)) {
      const key = `${cause}\0${edge.call.path}\0${edge.call.line}`;
      const at = inherited.get(key) ?? { cause, evidence: [edge.call] };
      inherited.set(key, atCall(at, edge.node));
    }
  }
  return [...inherited.values()];
}

/** One gap per cause at each place, ordered by the first place it names, so the same snapshot gives the same gaps. */
function distinctGaps(gaps: readonly SummaryGap[]): SummaryGap[] {
  const byPlace = new Map<string, SummaryGap>();
  for (const gap of gaps) {
    const key = `${gap.cause}\0${placeKey(gap)}`;
    const previous = byPlace.get(key);
    if (previous === undefined) byPlace.set(key, gap);
    else for (const call of GAP_CALLS.get(gap) ?? []) atCall(previous, call);
  }
  return [...byPlace.values()].sort((a, b) => compareText(firstPlace(a), firstPlace(b)) || compareText(a.cause, b.cause));
}

function firstPlace(gap: SummaryGap): string {
  const [first] = gap.evidence;
  return first === undefined ? "" : `${first.path}:${first.line}`;
}

function placeKey(gap: SummaryGap): string {
  return gap.evidence.map((evidence) => `${evidence.path}:${evidence.line}`).join("|");
}

function recordGap(gaps: Map<DeclarationKey, SummaryGap[]>, key: DeclarationKey, gap: SummaryGap): void {
  gaps.set(key, [...(gaps.get(key) ?? []), gap]);
}

function distinctResults(results: readonly ResultShape[]): ResultShape[] {
  const seen = new Map<string, ResultShape>();
  for (const result of results) seen.set(JSON.stringify(result), result);
  return [...seen.values()];
}

function sameRequest(a: RequestShape, b: RequestShape): boolean {
  const aCalls = SHAPE_TRACES.get(a)?.allCalls;
  const bCalls = SHAPE_TRACES.get(b)?.allCalls;
  return (
    a.transport === b.transport &&
    a.method === b.method &&
    a.path === b.path &&
    JSON.stringify(a.holes) === JSON.stringify(b.holes) &&
    JSON.stringify(a.unresolved) === JSON.stringify(b.unresolved) &&
    SHAPE_VALUES.get(a) === SHAPE_VALUES.get(b) &&
    JSON.stringify(SHAPE_ENCODINGS.get(a) ?? []) === JSON.stringify(SHAPE_ENCODINGS.get(b) ?? []) &&
    JSON.stringify(a.body) === JSON.stringify(b.body) &&
    JSON.stringify(a.when) === JSON.stringify(b.when) &&
    JSON.stringify(a.hops) === JSON.stringify(b.hops) &&
    (aCalls === undefined || bCalls === undefined || (aCalls.length === bCalls.length && aCalls.every((call, index) => call === bCalls[index])))
  );
}

/** The order the summary states its shapes in: transport, method, path, then condition, so the same snapshot gives the same bytes. */
function compareShapes(a: RequestShape, b: RequestShape): number {
  return compareText(a.transport, b.transport) || compareText(a.method ?? "", b.method ?? "") || compareText(a.path, b.path) || compareText(conditionText(a), conditionText(b));
}

function conditionText(shape: RequestShape): string {
  return shape.when === undefined ? "" : `${shape.when.parameter}:${shape.when.test}`;
}

type Substitution = { kind: "shape"; shape: RequestShape } | { kind: "dropped" } | { kind: "gap"; cause: SummaryCause };

/**
 * Replaces the holes of a callee's shape with the arguments the call writes, in source order: an argument's own holes flow
 * into the shape bound to the caller's parameter. A literal argument decides a condition; a condition the argument leaves
 * undecided stays on the caller's parameter when the argument is one, and keeps both shapes with no condition otherwise.
 * A verb only a value states and no argument fills is a gap at the call.
 */
function substitute(shape: RequestShape, edge: Edge, conditionalHole = false): Substitution {
  const pieces = shape.path.split(RUN_TIME_HOLE);
  const written: string[] = [pieces[0] ?? ""];
  const holes: (number | undefined)[] = [];
  const encodings: boolean[] = [];
  pieces.slice(1).forEach((part, index) => {
    const parameter = shape.holes[index];
    const argument = parameter === undefined ? undefined : edge.args[parameter];
    if (SHAPE_ENCODINGS.get(shape)?.[index]) {
      written.push(RUN_TIME_HOLE, part);
      holes.push(undefined);
      encodings.push(false);
      return;
    }
    if (argument?.text !== undefined) {
      written.push(argument.text, part);
      holes.push(...argument.holes);
      encodings.push(...argument.encodings);
      return;
    }
    written.push(RUN_TIME_HOLE, part);
    holes.push(argument?.parameter);
    encodings.push(false);
  });
  const method = substitutedMethod(shape, edge);
  if (method === undefined) return { kind: "gap", cause: "destination-undecidable" };
  const sourceValue = SHAPE_VALUES.get(shape);
  const value = sourceValue === undefined || edge.values === undefined ? undefined : applyRequestValue(sourceValue, edge.values);
  const reduced = value === undefined ? undefined : readRequestValue(value);
  const path = reduced?.text ?? written.join("");
  if (reduced !== undefined) { holes.splice(0, holes.length, ...reduced.holes); encodings.splice(0, encodings.length, ...reduced.encodings); }
  const body = substitutedBody(shape.body, edge);
  const hops = [...shape.hops, { function: edge.caller, call: edge.call, forwarded: LEAF_CALLS.get(shape) ?? edge.call }];
  const decided = shape.when === undefined ? undefined : decide(shape.when, edge);
  if (decided !== undefined && !decided.keeps) return { kind: "dropped" };
  const when = decided?.condition;
  const result: RequestShape = when === undefined ? { transport: shape.transport, method, path, holes, body, hops } : { transport: shape.transport, method, path, holes, body, hops, when };
  const unresolved = reduced === undefined ? shape.unresolved : reduced.unresolved;
  if (unresolved !== undefined) result.unresolved = unresolved;
  if (value !== undefined) SHAPE_VALUES.set(result, value);
  SHAPE_ENCODINGS.set(result, encodings);
  const trace = SHAPE_TRACES.get(shape);
  if (trace !== undefined) {
    const binds = !trace.bound && (conditionalHole || (reduced === undefined ? shape.holes.some((index) => index !== undefined && edge.args[index] !== undefined) : reduced.supplied.some((index) => edge.args[index] !== undefined)));
    const calls = trace.bound ? trace.calls : [...trace.calls, edge.node];
    const targets = [...trace.targets, { call: edge.node, key: edge.callee }];
    SHAPE_TRACES.set(result, binds
      ? { ...trace, selected: result, calls, allCalls: [...trace.allCalls, edge.node], targets, bound: true }
      : { ...trace, calls, allCalls: [...trace.allCalls, edge.node], targets });
  }
  return { kind: "shape", shape: result };
}

/** The verb the call states for a shape whose leaf took it from an argument; undefined when no argument states one. */
function substitutedMethod(shape: RequestShape, edge: Edge): HttpMethod | undefined {
  if (shape.method !== undefined) return shape.method;
  const parameter = METHOD_PARAMETERS.get(shape);
  return parameter === undefined ? undefined : edge.args[parameter]?.verb;
}

/** Whether the call decides the shape's condition, and the condition it leaves behind. */
function decide(when: PathCondition, edge: Edge): { keeps: boolean; condition?: PathCondition } {
  const argument = edge.args[when.parameter];
  if (argument?.truthy !== undefined) return { keeps: argument.truthy === (when.test === "truthy") };
  if (argument?.parameter !== undefined) return { keeps: true, condition: { parameter: argument.parameter, test: when.test } };
  return { keeps: true };
}

/**
 * A body the callee takes from its parameter, as the caller's own parameter when the call passes one, none when the call
 * passes a value it states, and unknown otherwise.
 */
function substitutedBody(body: BodySource, edge: Edge): BodySource {
  if (body.kind !== "parameter") return body;
  const argument = edge.args[body.index];
  if (argument?.parameter !== undefined) return { kind: "parameter", index: argument.parameter };
  return argument?.text !== undefined ? { kind: "none" } : { kind: "unknown", index: body.index };
}

/** Every declaration of the snapshot by key; a key that two bodies declare keeps both, so the summary never picks one. */
function declarationsOf(files: readonly SourceFile[]): Map<DeclarationKey, Declaration[]> {
  const found = new Map<DeclarationKey, Declaration[]>();
  const add = (declaration: Declaration): void => {
    found.set(declaration.key, [...(found.get(declaration.key) ?? []), declaration]);
  };
  for (const file of files) {
    if (!isTypeScriptSource(file.path)) continue;
    const tree = sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
    const ownedFunctions = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.body !== undefined && ts.isIdentifier(member.name)) {
            add({ key: `${file.path}\0${node.name.text}.${member.name.text}`, file: file.path, body: member.body, parameters: parameterNames(member.parameters), signature: member });
          }
          if (ts.isPropertyDeclaration(member) && member.initializer !== undefined && ts.isIdentifier(member.name)) {
            const fn = unwrap(member.initializer);
            if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
              ownedFunctions.add(fn);
              add({ key: `${file.path}\0${node.name.text}.${member.name.text}`, file: file.path, body: fn.body, parameters: parameterNames(fn.parameters), signature: member });
            }
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        add({ key: `${file.path}\0${node.name.text}`, file: file.path, body: node.body, parameters: parameterNames(node.parameters), signature: node });
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        if (!ownedFunctions.has(node)) {
          add({ key: `${file.path}\0@${node.getStart(tree)}`, file: file.path, body: node.body, parameters: parameterNames(node.parameters), signature: node });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return found;
}

function parameterNames(parameters: readonly ts.ParameterDeclaration[]): readonly string[] {
  return parameters.flatMap((parameter) => (ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
}

/** The leaves and the edges of one declaration: its request calls, and its calls to other declarations, not entering nested functions. */
async function scan(declaration: Declaration, resolver: SummaryResolver): Promise<{ shapes: RequestShape[]; edges: Edge[]; gaps: SummaryGap[]; returns: ts.Expression[] }> {
  const shapes: RequestShape[] = [];
  const edges: Edge[] = [];
  const gaps: SummaryGap[] = [];
  const returns: ts.Expression[] = [];
  if (!ts.isBlock(declaration.body)) returns.push(declaration.body as ts.Expression);
  const visit = async (node: ts.Node, inCallback: boolean): Promise<void> => {
    if (node !== declaration.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (!inCallback && ts.isReturnStatement(node) && node.expression !== undefined) returns.push(node.expression);
    if (ts.isCallExpression(node)) {
      const leaf = await leafOf(declaration, node, resolver);
      if (leaf.kind === "shapes") shapes.push(...leaf.shapes);
      else if (leaf.kind === "gap") gaps.push(atCall(leaf.gap, node));
      else {
        const edge = await edgeOf(declaration, node, resolver);
        if (edge !== undefined && "gap" in edge) gaps.push(atCall(edge.gap, node));
        else if (edge !== undefined) edges.push(...edge);
        else {
          const row = forwardingRowOf(node);
          const carried = row === undefined ? undefined : carriedOf(node, row);
          if (row !== undefined && carried === undefined) gaps.push(atCall({ cause: "destination-undecidable", evidence: [placeOf(declaration.file, node)] }, node));
          else if (carried !== undefined) {
            const fn = unwrap(carried);
            if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && (row?.callback !== undefined || row?.name === "resource")) await visit(fn.body, true);
          }
        }
      }
    }
    for (const child of node.getChildren()) await visit(child, inCallback);
  };
  await visit(declaration.body, false);
  return { shapes, edges, gaps, returns };
}

/** A request of the client vocabulary, with its path folded in the declaration's own scope. */
type Leaf = { kind: "shapes"; shapes: readonly RequestShape[] } | { kind: "gap"; gap: SummaryGap } | { kind: "none" };

/**
 * A request of the client vocabulary: its path folded in the declaration's own scope, one shape per branch when the path
 * splits on a parameter, or a gap at the call when the path is undecided or writes a brace the code wrote.
 */
async function leafOf(declaration: Declaration, call: ts.CallExpression, resolver: SummaryResolver): Promise<Leaf> {
  const recognized = requestCallOf(requestFileShapeOf(call.getSourceFile()), call);
  if (recognized.kind === "not-request") return { kind: "none" };
  if (recognized.kind === "request" && recognized.client === "resource") return resourceLeaf(declaration, call, resolver);
  if (recognized.kind === "undecided" && !(await resolver.clientReceiver(declaration.file, call))) return { kind: "none" };
  if (recognized.path === undefined) return { kind: "gap", gap: { cause: "destination-undecidable", evidence: [placeOf(declaration.file, call)] } };
  const { method } = recognized;
  const methodParameter = method.kind === "undecided" && method.stated !== undefined ? parameterIndexOf(declaration, method.stated) : undefined;
  return shapesOfCall(declaration, call, recognized.path, method.kind === "established" ? method.verb : undefined, methodParameter, bodySourceOf(declaration, recognized.body), resolver);
}

/**
 * `httpResource(() => url)` is a GET of the URL the function returns. A function whose body is one expression states its
 * path; any other argument does not state one, so the call is a gap at it.
 */
async function resourceLeaf(declaration: Declaration, call: ts.CallExpression, resolver: SummaryResolver): Promise<Leaf> {
  const [first] = call.arguments;
  const returned = first !== undefined && ts.isArrowFunction(first) && !ts.isBlock(first.body) ? first.body : undefined;
  if (returned === undefined) return { kind: "gap", gap: { cause: "destination-undecidable", evidence: [placeOf(declaration.file, call)] } };
  return shapesOfCall(declaration, call, returned, "GET", undefined, { kind: "none" }, resolver);
}

/** The shapes one leaf call states, one per branch of its path, or the gap that stops it. */
async function shapesOfCall(
  declaration: Declaration,
  call: ts.CallExpression,
  pathArgument: ts.Expression,
  method: HttpMethod | undefined,
  methodParameter: number | undefined,
  body: BodySource,
  resolver: SummaryResolver,
): Promise<Leaf> {
  const brace = writtenBrace(pathArgument);
  if (brace !== undefined) return { kind: "gap", gap: { cause: "destination-undecidable", evidence: [{ ...placeOf(declaration.file, call), via: `literal ${brace}` }] } };
  const split = splitPath(declaration, pathArgument);
  if (split.kind === "gap") return { kind: "gap", gap: { cause: "destination-undecidable", evidence: [placeOf(declaration.file, call)] } };
  const shapes: RequestShape[] = [];
  for (const branch of split.branches) {
    const read = await readBranch(declaration, branch, resolver);
    if (read.status === "undecided") return { kind: "gap", gap: { cause: read.cause, evidence: [placeOf(declaration.file, call), ...read.evidence] } };
    const shape: RequestShape = { transport: "http", method, path: read.text, holes: read.holes, body, hops: [], ...(branch.when === undefined ? {} : { when: branch.when }) };
    if (read.unresolved !== undefined) shape.unresolved = read.unresolved;
    if (read.value !== undefined) SHAPE_VALUES.set(shape, read.value);
    SHAPE_ENCODINGS.set(shape, read.encodings);
    LEAF_CALLS.set(shape, placeOf(declaration.file, call));
    SHAPE_TRACES.set(shape, { leaf: call, selected: shape, calls: [call], allCalls: [call], targets: [], bound: false, conditional: shape.when !== undefined });
    SHAPE_ORIGINS.set(shape, new Set([declaration.key]));
    if (methodParameter !== undefined) METHOD_PARAMETERS.set(shape, methodParameter);
    shapes.push(shape);
  }
  return { kind: "shapes", shapes };
}

type PathPart = { kind: "text"; text: string } | { kind: "expression"; node: ts.Expression };

interface Branch {
  parts: readonly PathPart[];
  when?: PathCondition;
}

type PathSplit = { kind: "branches"; branches: readonly Branch[] } | { kind: "gap" };

/**
 * The path as its branches: a conditional inside the path whose test is one of the declaration's parameters splits it,
 * keeping the text the code writes around it (`'/items' + (all ? '' : '/' + id)`), and any other conditional is a gap.
 */
function splitPath(declaration: Declaration, expression: ts.Expression): PathSplit {
  const node = unwrap(expression);
  if (!hasParameterConditional(declaration, node)) return { kind: "branches", branches: [{ parts: [{ kind: "expression", node }] }] };
  if (ts.isConditionalExpression(node)) {
    const parameter = parameterIndexOf(declaration, node.condition);
    if (parameter === undefined) return { kind: "gap" };
    if (hasParameterConditional(declaration, node.whenTrue) || hasParameterConditional(declaration, node.whenFalse)) return { kind: "gap" };
    return {
      kind: "branches",
      branches: [
        { parts: [{ kind: "expression", node: node.whenTrue }], when: { parameter, test: "truthy" } },
        { parts: [{ kind: "expression", node: node.whenFalse }], when: { parameter, test: "falsy" } },
      ],
    };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = splitPath(declaration, node.left);
    const right = splitPath(declaration, node.right);
    if (left.kind === "gap" || right.kind === "gap") return { kind: "gap" };
    if (left.branches.length > 1 && right.branches.length > 1) return { kind: "gap" };
    return {
      kind: "branches",
      branches: left.branches.flatMap((from) =>
        right.branches.map((to) => {
          const when = from.when ?? to.when;
          return when === undefined ? { parts: [...from.parts, ...to.parts] } : { parts: [...from.parts, ...to.parts], when };
        }),
      ),
    };
  }
  if (ts.isTemplateExpression(node)) {
    const spans = node.templateSpans.map((span) => splitPath(declaration, span.expression));
    const splitting = spans.filter((span) => span.kind === "branches" && span.branches.length > 1);
    if (spans.some((span) => span.kind === "gap") || splitting.length > 1) return { kind: "gap" };
    const index = spans.findIndex((span) => span.kind === "branches" && span.branches.length > 1);
    if (index === -1) return { kind: "branches", branches: [{ parts: [{ kind: "expression", node }] }] };
    const chosen = spans[index];
    if (chosen === undefined || chosen.kind !== "branches") return { kind: "gap" };
    return {
      kind: "branches",
      branches: chosen.branches.map((branch) => {
        const parts: PathPart[] = [{ kind: "text", text: node.head.text }];
        node.templateSpans.forEach((span, at) => {
          const piece = spans[at];
          if (at === index) parts.push(...branch.parts);
          else if (piece?.kind === "branches") parts.push(...(piece.branches[0]?.parts ?? []));
          parts.push({ kind: "text", text: span.literal.text });
        });
        return branch.when === undefined ? { parts } : { parts, when: branch.when };
      }),
    };
  }
  return { kind: "gap" };
}

/** Whether a conditional that tests one of the declaration's own parameters sits anywhere in the path expression. */
function hasParameterConditional(declaration: Declaration, node: ts.Node): boolean {
  if (ts.isConditionalExpression(node) && parameterIndexOf(declaration, node.condition) !== undefined) return true;
  return ts.forEachChild(node, (child) => (hasParameterConditional(declaration, child) ? true : undefined)) ?? false;
}

/** The text and holes one branch states: its literal segments written as the code writes them, its expressions folded. */
async function readBranch(declaration: Declaration, branch: Branch, resolver: SummaryResolver): Promise<(PathRead & { encodings: readonly boolean[] }) | { status: "undecided"; cause: SummaryCause; evidence: readonly Evidence[] }> {
  let text = "";
  const holes: (number | undefined)[] = [];
  const encodings: boolean[] = [];
  const values: RequestValue[] = [];
  let declarative = false;
  for (const part of branch.parts) {
    if (part.kind === "text") {
      text += part.text;
      values.push({ kind: "literal", value: part.text });
      continue;
    }
    const node = unwrap(part.node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      text += node.text;
      values.push({ kind: "literal", value: node.text });
      continue;
    }
    const read = await resolver.evaluate(declaration.file, part.node);
    if (read.status === "undecided") return read;
    text += read.text;
    declarative ||= read.value !== undefined;
    if (read.value !== undefined) values.push(read.value);
    else {
      const parts = read.text.split(RUN_TIME_HOLE);
      values.push({ kind: "literal", value: parts[0] ?? "" });
      for (let index = 1; index < parts.length; index++) {
        const parameter = read.holes[index - 1];
        values.push(parameter === undefined ? UNKNOWN_VALUE : { kind: "parameter", index: parameter }, { kind: "literal", value: parts[index] ?? "" });
      }
    }
    holes.push(...read.holes);
    encodings.push(...(read.encodings ?? read.holes.map(() => false)));
  }
  if (!declarative) return { status: "known", text, holes, encodings };
  const value = values.reduce<RequestValue>((left, right) => ({ kind: "operation", operator: "+", operands: [left, right] }), { kind: "literal", value: "" });
  return { status: "known", ...readRequestValue(value), value };
}

/**
 * The text of a literal segment the code writes when it contains a brace: a literal's `{` or `}` is the code's own text,
 * which a run-time `{}` of the resolver can be mistaken for, so the summary never substitutes through it. Every literal
 * segment counts: a concatenation, a template's own text and a literal it substitutes.
 */
function writtenBrace(expression: ts.Expression): string | undefined {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return /[{}]/.test(node.text) ? node.text : undefined;
  if (ts.isTemplateExpression(node)) {
    if (/[{}]/.test(node.head.text)) return node.head.text;
    for (const span of node.templateSpans) {
      if (/[{}]/.test(span.literal.text)) return span.literal.text;
      const inner = writtenBrace(span.expression);
      if (inner !== undefined) return inner;
    }
    return undefined;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return writtenBrace(node.left) ?? writtenBrace(node.right);
  return undefined;
}

const BODY_VERBS: ReadonlySet<string> = new Set(["post", "put", "patch"]);

/**
 * The body a request sends as the summary states it: the declaration's own parameter when the body is one, no body for a
 * literal or an absent body, and unknown for any other expression.
 */
function bodySourceOf(declaration: Declaration, body: RequestBodyRead): BodySource {
  if (body.kind !== "established") return body.kind === "none" ? body : { kind: "unknown", index: body.argument };
  const argument = body.expression;
  if (ts.isLiteralExpression(argument) || argument.kind === ts.SyntaxKind.NullKeyword || argument.kind === ts.SyntaxKind.TrueKeyword || argument.kind === ts.SyntaxKind.FalseKeyword) return { kind: "none" };
  const parameter = parameterIndexOf(declaration, argument);
  return parameter === undefined ? { kind: "unknown", index: body.argument } : { kind: "parameter", index: parameter };
}

/** The index of the declaration's parameter a condition is, or undefined when the condition reads something else. */
function parameterIndexOf(declaration: Declaration, condition: ts.Expression): number | undefined {
  const node = unwrap(condition);
  if (!ts.isIdentifier(node)) return undefined;
  const index = declaration.parameters.indexOf(node.text);
  return index === -1 ? undefined : index;
}

/** Whether a literal states a truth value: only a literal may decide a condition; any other argument leaves it undecided. */
function literalTruth(expression: ts.Expression): boolean | undefined {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text !== "";
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return false;
  return ts.isIdentifier(node) && node.text === "undefined" ? false : undefined;
}

/** The verb a literal argument states, when it is one. */
function literalVerb(expression: ts.Expression): HttpMethod | undefined {
  const node = unwrap(expression);
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? requestMethodOf(node.text.toUpperCase()) : undefined;
}

/** A call to another declaration of the snapshot, with its arguments folded in the caller's scope. */
async function edgeOf(declaration: Declaration, call: ts.CallExpression, resolver: SummaryResolver): Promise<readonly Edge[] | { gap: SummaryGap } | undefined> {
  const target = await resolver.calleeOf(declaration.file, call);
  if (target === undefined) return undefined;
  if ("gap" in target) return target;
  const args: Argument[] = [];
  for (const argument of call.arguments) {
    const read = await resolver.evaluate(declaration.file, argument);
    args.push({
      text: read.status === "known" ? read.text : undefined,
      holes: read.status === "known" ? read.holes : [],
      encodings: read.status === "known" ? read.encodings ?? read.holes.map(() => false) : [],
      truthy: literalTruth(argument),
      verb: literalVerb(argument),
      parameter: parameterIndexOf(declaration, argument),
    });
  }
  const candidates = "candidates" in target ? target.candidates : [target];
  const values = resolver.valueFacts === undefined ? undefined : await Promise.all(call.arguments.map((argument) => resolver.valueFacts!(declaration.file, argument)));
  return candidates.map((candidate) => ({ callee: candidate.key, caller: placeOf(declaration.file, declaration.signature), call: placeOf(declaration.file, call), args, ...(values === undefined ? {} : { values }), unread: candidate.body === undefined, node: call }));
}

/** The expression without the wrappers that change no value. */
function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) return unwrap(expression.expression);
  return expression;
}

function returnExpressionsOf(node: ts.Node): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (child: ts.Node): void => {
    if (child !== node && (ts.isFunctionLike(child) || ts.isClassLike(child))) return;
    if (ts.isReturnStatement(child) && child.expression !== undefined) found.push(child.expression);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function placeOf(file: string, node: ts.Node): Evidence {
  const at = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  return { path: file, line: at.line + 1 };
}
