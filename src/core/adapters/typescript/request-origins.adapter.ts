import ts from "typescript";
import type { Origin } from "../../domain/contracts/request-origin.ts";
import type { ArgumentOrigins, RequestOriginReader } from "../../ports/request-origins.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { buildProgram } from "./consumer-flow.index.ts";
import { calleeName } from "./consumer-flow.syntax.ts";
import { createRequestBodies, lineOf, symbolOf, VERBS } from "./http-call-sites.adapter.ts";
import { bodyReplacements } from "./request-interceptors.ts";
import { OriginWalker } from "./request-origins.walker.ts";

/**
 * Follows the body of the HTTP requests of one repository backward, syntax only. Reading is lazy and happens once: the
 * program, the request resolution and the walker's answers are held for as long as the reader is, which is the life of
 * the prepared workspace that holds it.
 */
export function createRequestOriginReader(files: readonly SourceFile[]): RequestOriginReader {
  let prepared: Promise<{ program: Awaited<ReturnType<typeof buildProgram>>; bodyOf: ReturnType<typeof createRequestBodies>; walker: OriginWalker; replacements: Origin[] }> | undefined;
  const prepare = () => (prepared ??= buildProgram(files).then((program) => ({ program, bodyOf: createRequestBodies(files), walker: new OriginWalker(program), replacements: bodyReplacements(program) })));

  return {
    async ofBody(site, path) {
      const { program, bodyOf, walker, replacements } = await prepare();
      if (replacements.length > 0) return replacements;
      const unit = program.index.units.get(site.file);
      const call = unit === undefined ? undefined : callsOf(unit.tree).find((candidate) => lineOf(unit.tree, candidate) === site.line && symbolOf(candidate) === site.symbol && namesRequest(candidate));
      if (call === undefined) return [unreadable(site.file, site.line, "no call at the reported site")];
      const request = await bodyOf(call);
      if (request === undefined) return [unreadable(site.file, site.line, "not a request body of the project")];
      return walker.ofBody(request, path, call);
    },
    async ofArgument(site, index, path, body): Promise<ArgumentOrigins> {
      const { program, walker } = await prepare();
      const unit = program.index.units.get(site.file);
      const named = unit === undefined ? [] : callsOf(unit.tree).filter((candidate) => calleeName(candidate) === site.callee);
      const here = unit === undefined ? [] : named.filter((candidate) => lineOf(unit.tree, candidate) === site.line);
      const found = here.length > 0 ? here : unit === undefined ? [] : named.filter((candidate) => lineOf(unit.tree, candidate) <= site.line && site.line <= unit.tree.getLineAndCharacterOfPosition(candidate.getEnd()).line + 1);
      const [call] = found;
      if (found.length !== 1 || call === undefined) return { kind: "passed", origins: [unreadable(site.file, site.line, found.length === 0 ? "no call of the callee at the caller" : "several calls of the callee at the caller")] };
      return walker.ofArgument(call, index, path, body);
    },
  };
}

const unreadable = (file: string, line: number, detail: string): Origin => ({ kind: "frontier", reason: "untracked", detail, at: { path: file, line }, hops: [], conditions: [] });

const CALLS = new WeakMap<ts.SourceFile, readonly ts.CallExpression[]>();

function callsOf(tree: ts.SourceFile): readonly ts.CallExpression[] {
  const held = CALLS.get(tree);
  if (held !== undefined) return held;
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(tree);
  CALLS.set(tree, found);
  return found;
}

function namesRequest(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "fetch" || callee.text === "httpResource";
  return ts.isPropertyAccessExpression(callee) && (VERBS.has(callee.name.text) || callee.name.text === "fetch");
}
