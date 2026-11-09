import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { Evidence } from "../../domain/shared/fact.ts";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { requestMethodOf } from "../../domain/entrypoints/http-route.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { propertyOf } from "./syntax.ts";
import { RUN_TIME_HOLE } from "../../domain/topology/path-template.ts";
import type { BodySource, RequestShape, RequestSummary, ResultShape, SummaryCause, SummaryGap } from "../../domain/topology/request-summary.ts";
import { VERBS } from "./http-call-sites.adapter.ts";
import { sourceTree } from "./source-tree.ts";

export type DeclarationKey = string;

/**
 * What the rule asks of the B11 reader. The reader answers each question; the rule decides what a request is.
 * `clientReceiver` answers receiver typing only: whether a call's receiver is an Angular `HttpClient`, by the reader's
 * fields, parameters and inherited fields. It never decides a request.
 */
/** A path the resolver states: its text, and `holes` with one entry per `{}` of the text, in order. */
export interface PathRead {
  status: "known";
  text: string;
  holes: readonly (number | undefined)[];
}

export interface SummaryResolver {
  /**
   * What an expression states in a declaration's scope: its text with `{}` per run-time value, and `holes` with one entry
   * per `{}` in order, the declaration parameter index that value is (undefined when it is not a parameter), or why not.
   */
  evaluate(file: string, expression: ts.Expression): Promise<PathRead | { status: "undecided"; cause: SummaryCause; evidence: readonly Evidence[] }>;
  /** The declaration a call resolves to, or undefined when it is not a snapshot declaration. */
  calleeOf(file: string, call: ts.CallExpression): Promise<{ key: DeclarationKey; file: string; body: ts.Node | undefined } | undefined>;
  /** Whether the call's receiver is an Angular `HttpClient`, typed by the B11 reader (fields, parameters, inherited fields). It answers receiver typing only; it does not decide what a request is. */
  clientReceiver(file: string, call: ts.CallExpression): Promise<boolean>;
}

interface Declaration {
  key: DeclarationKey;
  file: string;
  body: ts.Node;
  parameters: readonly string[];
  signature: ts.Node;
}

/** A call from one declaration to another, with the arguments the caller writes, each folded in the caller's scope. */
interface Edge {
  callee: DeclarationKey;
  /** The declaration that makes the call, and the call itself, by their places. */
  caller: Evidence;
  call: Evidence;
  /** The folded text of each argument, `{}` for a run-time value; undefined when the snapshot does not decide it. */
  args: readonly (string | undefined)[];
  /** The caller's own parameter each argument is, when it is one. */
  parameterAt: readonly (number | undefined)[];
  /** The callee is a declaration of the snapshot whose body the snapshot could not read. */
  unread: boolean;
  node: ts.CallExpression;
}

/**
 * The request shapes and gaps of every declaration in the snapshot: its own leaves, plus each call to another declaration
 * substituted into that declaration's shapes, grown to a fixpoint. A call to a declaration the snapshot does not hold
 * contributes nothing: the pack cannot claim that an unread callee issues a request.
 */
export async function summariesOf(files: readonly SourceFile[], resolver: SummaryResolver): Promise<ReadonlyMap<DeclarationKey, RequestSummary>> {
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
  const shapes = new Map<DeclarationKey, RequestShape[]>(own);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of bodies.keys()) {
      const current = shapes.get(key) ?? [];
      const grown = [...current];
      for (const edge of edges.get(key) ?? []) {
        for (const inner of shapes.get(edge.callee) ?? []) {
          const substituted = substitute(inner, edge);
          if (substituted !== undefined && !grown.some((existing) => sameRequest(existing, substituted))) grown.push(substituted);
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
    ownGaps.set(key, [...(disagreements.get(key) ?? []), ...(scanned.get(key) ?? []), ...unreadGaps(edges.get(key) ?? []), ...recursiveGaps(key, edges)]);
  }
  const gapsOf = new Map<DeclarationKey, SummaryGap[]>();
  for (const key of bodies.keys()) {
    gapsOf.set(key, distinctGaps([...(ownGaps.get(key) ?? []), ...calledGaps(key, edges, ownGaps)]));
  }
  const results = await resultsOf(bodies, returns, edges, gapsOf, resolver);
  const summaries = new Map<DeclarationKey, RequestSummary>();
  for (const key of bodies.keys()) {
    const gaps = gapsOf.get(key) ?? [];
    summaries.set(key, { shapes: shapes.get(key) ?? [], result: gaps.length > 0 ? resultOf(gaps) : (results.get(key) ?? { kind: "none" }), gaps });
  }
  return summaries;
}

/**
 * The result of each declaration with no gap: a return that is a request call is a body, observed as the response when the
 * call asks for it; a return that is a call to a declaration with a body keeps that body. Grown to a fixpoint from none, so
 * a declaration that returns nothing it can read stays none.
 */
async function resultsOf(
  bodies: ReadonlyMap<DeclarationKey, Declaration[]>,
  returns: ReadonlyMap<DeclarationKey, readonly ts.Expression[]>,
  edges: ReadonlyMap<DeclarationKey, readonly Edge[]>,
  gapsOf: ReadonlyMap<DeclarationKey, readonly SummaryGap[]>,
  resolver: SummaryResolver,
): Promise<Map<DeclarationKey, ResultShape>> {
  const results = new Map<DeclarationKey, ResultShape>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of bodies.keys()) {
      if ((gapsOf.get(key) ?? []).length > 0 || results.has(key)) continue;
      const file = bodies.get(key)?.[0]?.file ?? "";
      for (const expression of returns.get(key) ?? []) {
        const body = await bodyOf(expression, { file, key, edges, results, resolver });
        if (body !== undefined) {
          results.set(key, body);
          changed = true;
          break;
        }
      }
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

async function bodyOf(expression: ts.Expression, scope: ReturnScope): Promise<ResultShape | undefined> {
  const { file, key, edges, results, resolver } = scope;
  if (!ts.isCallExpression(expression)) return undefined;
  const callee = expression.expression;
  if (ts.isPropertyAccessExpression(callee) && VERBS.has(callee.name.text) && (await resolver.clientReceiver(file, expression))) {
    return { kind: "body", container: "observable", observed: observesResponse(expression) ? "response" : "body" };
  }
  const edge = (edges.get(key) ?? []).find((candidate) => candidate.node === expression);
  return edge === undefined ? undefined : results.get(edge.callee);
}

/** Whether a request call asks for the whole response: its options object states `observe: 'response'`. */
function observesResponse(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  const observe = propertyOf(options, "observe");
  return observe !== undefined && ts.isStringLiteral(observe) && observe.text === "response";
}

/** A call whose callee body the snapshot could not read leaves the caller's request unknown at that call, never absent. */
function unreadGaps(edges: readonly Edge[]): SummaryGap[] {
  return edges.filter((edge) => edge.unread).map((edge) => ({ cause: "source-not-read", evidence: [edge.call] }));
}

/** The gaps a declaration inherits from the declarations it reaches, each at the call that reaches it. */
function calledGaps(key: DeclarationKey, edges: ReadonlyMap<DeclarationKey, readonly Edge[]>, ownGaps: ReadonlyMap<DeclarationKey, readonly SummaryGap[]>): SummaryGap[] {
  const inherited = new Map<string, SummaryGap>();
  for (const edge of edges.get(key) ?? []) {
    for (const gap of reachableGaps(edge.callee, edges, ownGaps, new Set([key]))) {
      const at = { cause: gap.cause, evidence: [edge.call] };
      inherited.set(`${gap.cause}\0${edge.call.path}\0${edge.call.line}`, at);
    }
  }
  return [...inherited.values()];
}

function reachableGaps(from: DeclarationKey, edges: ReadonlyMap<DeclarationKey, readonly Edge[]>, ownGaps: ReadonlyMap<DeclarationKey, readonly SummaryGap[]>, visited: ReadonlySet<DeclarationKey>): SummaryGap[] {
  if (visited.has(from)) return [];
  const next = new Set(visited).add(from);
  const own = ownGaps.get(from) ?? [];
  const below = (edges.get(from) ?? []).flatMap((edge) => reachableGaps(edge.callee, edges, ownGaps, next));
  return [...own, ...below];
}

/** One gap per cause at each place, ordered by place then cause, so the same snapshot gives the same gaps. */
function distinctGaps(gaps: readonly SummaryGap[]): SummaryGap[] {
  const byPlace = new Map<string, SummaryGap>();
  for (const gap of gaps) {
    const place = gap.evidence.map((evidence) => `${evidence.path}\0${evidence.line}`).join("|");
    byPlace.set(`${gap.cause}\0${place}`, gap);
  }
  return [...byPlace.values()].sort((a, b) => compareText(a.cause, b.cause) || compareText(placeKey(a), placeKey(b)));
}

function placeKey(gap: SummaryGap): string {
  return gap.evidence.map((evidence) => `${evidence.path}:${evidence.line}`).join("|");
}

/** A call that closes a cycle, whose callee reaches the caller again, is a recursive gap at that call: the cycle is not entered twice. */
function recursiveGaps(key: DeclarationKey, edges: ReadonlyMap<DeclarationKey, readonly Edge[]>): SummaryGap[] {
  return (edges.get(key) ?? []).filter((edge) => reaches(edge.callee, key, edges)).map((edge) => ({ cause: "recursive", evidence: [edge.call] }));
}

function reaches(from: DeclarationKey, target: DeclarationKey, edges: ReadonlyMap<DeclarationKey, readonly Edge[]>, visited: ReadonlySet<DeclarationKey> = new Set()): boolean {
  if (from === target) return true;
  if (visited.has(from)) return false;
  const next = new Set(visited).add(from);
  return (edges.get(from) ?? []).some((edge) => reaches(edge.callee, target, edges, next));
}

/** A caller of an unread callee cannot say what its response is, so its result is unknown with the same cause; otherwise none is proven by the body read. */
function resultOf(gaps: readonly SummaryGap[]): ResultShape {
  const first = gaps[0];
  return first === undefined ? { kind: "none" } : { kind: "unknown", cause: first.cause, evidence: [] };
}

function sameRequest(a: RequestShape, b: RequestShape): boolean {
  return a.transport === b.transport && a.method === b.method && a.path === b.path && JSON.stringify(a.body) === JSON.stringify(b.body) && JSON.stringify(a.when) === JSON.stringify(b.when);
}

/** The order the summary states its shapes in: transport, method, path, then condition, so the same snapshot gives the same bytes. */
function compareShapes(a: RequestShape, b: RequestShape): number {
  return compareText(a.transport, b.transport) || compareText(a.method ?? "", b.method ?? "") || compareText(a.path, b.path) || compareText(conditionText(a), conditionText(b));
}

function conditionText(shape: RequestShape): string {
  return shape.when === undefined ? "" : `${shape.when.parameter}:${shape.when.test}`;
}

/**
 * Replaces the holes of a callee's shape with the arguments the call writes, in source order, and decides its condition
 * against the argument it tests: a literal keeps one branch, the caller's own parameter rewrites the condition onto it,
 * anything else keeps the condition as the callee wrote it. Undefined when a literal drops the shape's branch.
 */
function substitute(shape: RequestShape, edge: Edge): RequestShape | undefined {
  const pieces = shape.path.split(RUN_TIME_HOLE);
  const written: string[] = [pieces[0] ?? ""];
  const holes: (number | undefined)[] = [];
  pieces.slice(1).forEach((part, index) => {
    const parameter = shape.holes[index];
    const argument = parameter === undefined ? undefined : edge.args[parameter];
    if (argument !== undefined) {
      written.push(argument, part);
      return;
    }
    written.push(RUN_TIME_HOLE, part);
    holes.push(parameter === undefined ? undefined : edge.parameterAt[parameter]);
  });
  const path = written.join("");
  const body = substitutedBody(shape.body, edge);
  const hops = [...shape.hops, { function: edge.caller, call: edge.call, forwarded: edge.call }];
  if (shape.when === undefined) return { ...shape, path, holes, body, hops };
  const argument = edge.args[shape.when.parameter];
  if (argument !== undefined) return truthyText(argument) === (shape.when.test === "truthy") ? { transport: shape.transport, method: shape.method, path, holes, body, hops } : undefined;
  const callerParameter = edge.parameterAt[shape.when.parameter];
  return { ...shape, path, holes, body, hops, when: callerParameter === undefined ? shape.when : { parameter: callerParameter, test: shape.when.test } };
}

/**
 * A body the callee takes from its parameter, as the caller's own parameter when the call passes one, none when the call
 * passes a literal, and unknown otherwise.
 */
function substitutedBody(body: BodySource, edge: Edge): BodySource {
  if (body.kind !== "parameter") return body;
  const callerParameter = edge.parameterAt[body.index];
  if (callerParameter !== undefined) return { kind: "parameter", index: callerParameter };
  return edge.args[body.index] !== undefined ? { kind: "none" } : { kind: "unknown", index: body.index };
}

/** The truthiness of a folded literal: the empty text and the falsy literals are false; any other text is true. */
function truthyText(text: string): boolean {
  return !["", "0", "false", "null", "undefined"].includes(text);
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
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.body !== undefined && ts.isIdentifier(member.name)) {
            const key = `${file.path}\0${node.name.text}.${member.name.text}`;
            add({ key, file: file.path, body: member.body, parameters: parameterNames(member.parameters), signature: member });
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        const key = `${file.path}\0${node.name.text}`;
        add({ key, file: file.path, body: node.body, parameters: parameterNames(node.parameters), signature: node });
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
  const visit = async (node: ts.Node): Promise<void> => {
    if (node !== declaration.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) returns.push(node.expression);
    if (ts.isCallExpression(node)) {
      const leaf = await leafOf(declaration, node, resolver);
      if (leaf.kind === "shapes") shapes.push(...leaf.shapes);
      else if (leaf.kind === "gap") gaps.push(leaf.gap);
      else {
        const edge = await edgeOf(declaration, node, resolver);
        if (edge !== undefined) edges.push(edge);
      }
    }
    for (const child of node.getChildren()) await visit(child);
  };
  await visit(declaration.body);
  return { shapes, edges, gaps, returns };
}

/** A request of the client vocabulary, with its path folded in the declaration's own scope. */
type Leaf = { kind: "shapes"; shapes: readonly RequestShape[] } | { kind: "gap"; gap: SummaryGap } | { kind: "none" };

/**
 * A request of the client vocabulary: its path folded in the declaration's own scope, one shape per branch when the path
 * splits on a parameter, or a gap at the call when the path is undecided.
 */
async function leafOf(declaration: Declaration, call: ts.CallExpression, resolver: SummaryResolver): Promise<Leaf> {
  const callee = call.expression;
  const isFetch = ts.isIdentifier(callee) && callee.text === "fetch";
  const isMember = ts.isPropertyAccessExpression(callee);
  if (ts.isIdentifier(callee) && callee.text === "httpResource") return resourceLeaf(declaration, call, resolver);
  if (!isFetch && !(isMember && VERBS.has(callee.name.text))) return { kind: "none" };
  if (isMember && !(await resolver.clientReceiver(declaration.file, call))) return { kind: "none" };
  const verbName = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  const pathArgument = verbName === "request" ? call.arguments[1] : call.arguments[0];
  if (pathArgument === undefined) return { kind: "none" };
  const method = verbName === "request" ? methodArgument(call.arguments[0]) : isFetch ? "GET" : requestMethodOf((verbName ?? "").toUpperCase());
  if (method === undefined) return { kind: "gap", gap: { cause: "destination-undecidable", evidence: [placeOf(declaration.file, call)] } };
  const branches = branchesOf(declaration, pathArgument);
  if (branches === undefined) return { kind: "gap", gap: { cause: "destination-undecidable", evidence: [placeOf(declaration.file, call)] } };
  const shapes: RequestShape[] = [];
  for (const branch of branches) {
    const path = await pathOf(declaration, branch.expression, resolver);
    if (path.status === "undecided") return { kind: "gap", gap: { cause: path.cause, evidence: [placeOf(declaration.file, call)] } };
    const written = writtenBrace(branch.expression);
    if (written !== undefined) return { kind: "gap", gap: { cause: "destination-undecidable", evidence: [{ ...placeOf(declaration.file, call), via: `literal ${written}` }] } };
    shapes.push({ transport: "http", method, path: path.text, holes: path.holes, body: bodyOfArgument(declaration, call), hops: [], ...(branch.when === undefined ? {} : { when: branch.when }) });
  }
  return { kind: "shapes", shapes };
}

/**
 * The text of a literal the code writes when it contains a brace: a literal's `{` or `}` is the code's own text, which a
 * run-time `{}` of the resolver can be mistaken for, so the summary never substitutes through it.
 */
function writtenBrace(expression: ts.Expression): string | undefined {
  if (!ts.isStringLiteral(expression) && !ts.isNoSubstitutionTemplateLiteral(expression)) return undefined;
  return /[{}]/.test(expression.text) ? expression.text : undefined;
}

/** The verb a `request(method, url)` call states: a literal method name, undefined when the method is a value the code fills. */
function methodArgument(argument: ts.Expression | undefined): HttpMethod | undefined {
  return argument !== undefined && ts.isStringLiteral(argument) ? requestMethodOf(argument.text.toUpperCase()) : undefined;
}

/**
 * `httpResource(() => url)` is a GET of the URL the function returns. A function whose body is one expression states its
 * path; any other argument does not state one, so the call is a gap at it.
 */
async function resourceLeaf(declaration: Declaration, call: ts.CallExpression, resolver: SummaryResolver): Promise<Leaf> {
  const [first] = call.arguments;
  const returned = first !== undefined && ts.isArrowFunction(first) && !ts.isBlock(first.body) ? first.body : undefined;
  if (returned === undefined) return { kind: "gap", gap: { cause: "destination-undecidable", evidence: [placeOf(declaration.file, call)] } };
  const path = await pathOf(declaration, returned, resolver);
  if (path.status === "undecided") return { kind: "gap", gap: { cause: path.cause, evidence: [placeOf(declaration.file, call)] } };
  return { kind: "shapes", shapes: [{ transport: "http", method: "GET", path: path.text, holes: path.holes, body: { kind: "none" }, hops: [] }] };
}

const BODY_VERBS: ReadonlySet<string> = new Set(["post", "put", "patch"]);

/**
 * The body a request call sends: the second argument of a verb that takes one, read as the declaration's own parameter when
 * it is one, no body for a literal or an absent argument, and unknown for any other expression.
 */
function bodyOfArgument(declaration: Declaration, call: ts.CallExpression): BodySource {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !BODY_VERBS.has(callee.name.text)) return { kind: "none" };
  const argument = call.arguments[1];
  if (argument === undefined || ts.isLiteralExpression(argument) || argument.kind === ts.SyntaxKind.NullKeyword || argument.kind === ts.SyntaxKind.TrueKeyword || argument.kind === ts.SyntaxKind.FalseKeyword) return { kind: "none" };
  const parameter = parameterIndexOf(declaration, argument);
  return parameter === undefined ? { kind: "unknown", index: 1 } : { kind: "parameter", index: parameter };
}

interface Branch {
  expression: ts.Expression;
  when?: { parameter: number; test: "truthy" | "falsy" };
}

/** The path a branch writes, as the resolver states it: its text with `{}` per run-time value, and the parameter each `{}` reads. */
function pathOf(declaration: Declaration, expression: ts.Expression, resolver: SummaryResolver): ReturnType<SummaryResolver["evaluate"]> {
  return resolver.evaluate(declaration.file, expression);
}

/**
 * The path as its branches: a conditional whose test is one of the declaration's parameters splits into one branch per
 * outcome. Any other conditional is undecided, so the whole path is one branch that the resolver reads as undecided.
 */
function branchesOf(declaration: Declaration, expression: ts.Expression): Branch[] | undefined {
  const unwrapped = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  if (!ts.isConditionalExpression(unwrapped)) return [{ expression }];
  const parameter = parameterIndexOf(declaration, unwrapped.condition);
  if (parameter === undefined) return undefined;
  return [
    { expression: unwrapped.whenTrue, when: { parameter, test: "truthy" } },
    { expression: unwrapped.whenFalse, when: { parameter, test: "falsy" } },
  ];
}

/** The index of the declaration's parameter a condition is, or undefined when the condition reads something else. */
function parameterIndexOf(declaration: Declaration, condition: ts.Expression): number | undefined {
  if (!ts.isIdentifier(condition)) return undefined;
  const index = declaration.parameters.indexOf(condition.text);
  return index === -1 ? undefined : index;
}

/** A call to another declaration of the snapshot, with its arguments folded in the caller's scope. */
async function edgeOf(declaration: Declaration, call: ts.CallExpression, resolver: SummaryResolver): Promise<Edge | undefined> {
  const target = await resolver.calleeOf(declaration.file, call);
  if (target === undefined) return undefined;
  const args: (string | undefined)[] = [];
  const parameterAt: (number | undefined)[] = [];
  for (const argument of call.arguments) {
    const read = await resolver.evaluate(declaration.file, argument);
    args.push(read.status === "known" ? read.text : undefined);
    parameterAt.push(parameterIndexOf(declaration, argument));
  }
  return { callee: target.key, caller: placeOf(declaration.file, declaration.body), call: placeOf(declaration.file, call), args, parameterAt, unread: target.body === undefined, node: call };
}

function placeOf(file: string, node: ts.Node): Evidence {
  const at = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  return { path: file, line: at.line + 1 };
}
