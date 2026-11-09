import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { Evidence } from "../../domain/shared/fact.ts";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { requestMethodOf } from "../../domain/entrypoints/http-route.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { RUN_TIME_HOLE } from "../../domain/topology/path-template.ts";
import type { RequestShape, RequestSummary, SummaryCause, SummaryGap } from "../../domain/topology/request-summary.ts";
import { VERBS } from "./http-call-sites.adapter.ts";
import { sourceTree } from "./source-tree.ts";

export type DeclarationKey = string;

/**
 * What the rule asks of the B11 reader. The reader answers each question; the rule decides what a request is.
 * `clientReceiver` answers receiver typing only: whether a call's receiver is an Angular `HttpClient`, by the reader's
 * fields, parameters and inherited fields. It never decides a request.
 */
export interface SummaryResolver {
  /** What an expression states in a declaration's scope: text with `{}` for a run-time value, or why not. */
  evaluate(file: string, expression: ts.Expression): Promise<{ status: "known"; text: string } | { status: "undecided"; cause: SummaryCause; evidence: readonly Evidence[] }>;
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
}

/** A call from one declaration to another, with the arguments the caller writes, each folded in the caller's scope. */
interface Edge {
  callee: DeclarationKey;
  /** The declaration that makes the call, and the call itself, by their places. */
  caller: Evidence;
  call: Evidence;
  /** The folded text of each argument, `{}` for a run-time value; undefined when the snapshot does not decide it. */
  args: readonly (string | undefined)[];
}

/**
 * The request shapes and gaps of every declaration in the snapshot: its own leaves, plus each call to another declaration
 * substituted into that declaration's shapes, grown to a fixpoint. A call to a declaration the snapshot does not hold
 * contributes nothing: the pack cannot claim that an unread callee issues a request.
 */
export async function summariesOf(files: readonly SourceFile[], resolver: SummaryResolver): Promise<ReadonlyMap<DeclarationKey, RequestSummary>> {
  const declarations = declarationsOf(files);
  const own = new Map<DeclarationKey, RequestShape[]>();
  const edges = new Map<DeclarationKey, Edge[]>();
  for (const declaration of declarations.values()) {
    const found = await scan(declaration, resolver);
    own.set(declaration.key, found.shapes);
    edges.set(declaration.key, found.edges);
  }
  const shapes = new Map<DeclarationKey, RequestShape[]>(own);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations.values()) {
      const current = shapes.get(declaration.key) ?? [];
      const grown = [...current];
      for (const edge of edges.get(declaration.key) ?? []) {
        for (const inner of shapes.get(edge.callee) ?? []) {
          const substituted = substitute(inner, edge);
          if (!grown.some((existing) => sameRequest(existing, substituted))) grown.push(substituted);
        }
      }
      if (grown.length !== current.length) {
        shapes.set(declaration.key, grown.sort(compareShapes));
        changed = true;
      }
    }
  }
  const summaries = new Map<DeclarationKey, RequestSummary>();
  for (const declaration of declarations.values()) {
    summaries.set(declaration.key, { shapes: shapes.get(declaration.key) ?? [], result: { kind: "none" }, gaps: [] satisfies SummaryGap[] });
  }
  return summaries;
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

/** Replaces the holes of a callee's shape with the arguments the call writes, in source order. */
function substitute(shape: RequestShape, edge: Edge): RequestShape {
  let remaining = 0;
  const path = shape.path.split(RUN_TIME_HOLE).reduce((text, part, index) => {
    if (index === 0) return part;
    const argument = edge.args[remaining];
    remaining += 1;
    return text + (argument ?? RUN_TIME_HOLE) + part;
  }, "");
  return { ...shape, path, hops: [...shape.hops, { function: edge.caller, call: edge.call, forwarded: edge.call }] };
}

function declarationsOf(files: readonly SourceFile[]): Map<DeclarationKey, Declaration> {
  const found = new Map<DeclarationKey, Declaration>();
  for (const file of files) {
    if (!isTypeScriptSource(file.path)) continue;
    const tree = sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.body !== undefined && ts.isIdentifier(member.name)) {
            const key = `${file.path}\0${node.name.text}.${member.name.text}`;
            found.set(key, { key, file: file.path, body: member.body, parameters: parameterNames(member.parameters) });
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        const key = `${file.path}\0${node.name.text}`;
        found.set(key, { key, file: file.path, body: node.body, parameters: parameterNames(node.parameters) });
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
async function scan(declaration: Declaration, resolver: SummaryResolver): Promise<{ shapes: RequestShape[]; edges: Edge[] }> {
  const shapes: RequestShape[] = [];
  const edges: Edge[] = [];
  const visit = async (node: ts.Node): Promise<void> => {
    if (node !== declaration.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isCallExpression(node)) {
      const leaf = await leafOf(declaration, node, resolver);
      if (leaf !== undefined) shapes.push(leaf);
      else {
        const edge = await edgeOf(declaration, node, resolver);
        if (edge !== undefined) edges.push(edge);
      }
    }
    for (const child of node.getChildren()) await visit(child);
  };
  await visit(declaration.body);
  return { shapes, edges };
}

/** A request of the client vocabulary, with its path folded in the declaration's own scope. */
async function leafOf(declaration: Declaration, call: ts.CallExpression, resolver: SummaryResolver): Promise<RequestShape | undefined> {
  const callee = call.expression;
  const isFetch = ts.isIdentifier(callee) && callee.text === "fetch";
  const isMember = ts.isPropertyAccessExpression(callee);
  if (!isFetch && !(isMember && VERBS.has(callee.name.text))) return undefined;
  if (isMember && !(await resolver.clientReceiver(declaration.file, call))) return undefined;
  const pathArgument = call.arguments[0];
  if (pathArgument === undefined) return undefined;
  const read = await resolver.evaluate(declaration.file, pathArgument);
  if (read.status === "undecided") return undefined;
  const method: HttpMethod | undefined = ts.isPropertyAccessExpression(callee) ? requestMethodOf(callee.name.text.toUpperCase()) : "GET";
  return { transport: "http", method, path: read.text, body: { kind: "none" }, hops: [] };
}

/** A call to another declaration of the snapshot, with its arguments folded in the caller's scope. */
async function edgeOf(declaration: Declaration, call: ts.CallExpression, resolver: SummaryResolver): Promise<Edge | undefined> {
  const target = await resolver.calleeOf(declaration.file, call);
  if (target === undefined) return undefined;
  const args: (string | undefined)[] = [];
  for (const argument of call.arguments) {
    const read = await resolver.evaluate(declaration.file, argument);
    args.push(read.status === "known" ? read.text : undefined);
  }
  return { callee: target.key, caller: placeOf(declaration.file, declaration.body), call: placeOf(declaration.file, call), args };
}

function placeOf(file: string, node: ts.Node): Evidence {
  const at = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  return { path: file, line: at.line + 1 };
}
