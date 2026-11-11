import ts from "typescript";
import type { Origin } from "../../domain/contracts/request-origin.ts";
import type { ArgumentOrigins, RequestOriginReader } from "../../ports/request-origins.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { buildProgram } from "./consumer-flow.index.ts";
import { calleeName } from "./consumer-flow.syntax.ts";
import { createRequestCallLookup } from "./http-call-sites.adapter.ts";
import { lineOf } from "./syntax.ts";
import { bodyReplacements } from "./request-interceptors.ts";
import { OriginWalker } from "./request-origins.walker.ts";

/**
 * Follows the body of the HTTP requests of one repository backward, syntax only. Reading is lazy and happens once: the
 * program, the request resolution and the walker's answers are held for as long as the reader is, which is the life of
 * the prepared workspace that holds it.
 */
export function createRequestOriginReader(files: readonly SourceFile[], programOf: () => ReturnType<typeof buildProgram> = () => buildProgram(files), lookupOf: typeof createRequestCallLookup = createRequestCallLookup): RequestOriginReader {
  let prepared: Promise<{ program: Awaited<ReturnType<typeof buildProgram>>; lookup: Awaited<ReturnType<typeof createRequestCallLookup>>; walker: OriginWalker; replacements: Origin[] }> | undefined;
  const prepare = () => (prepared ??= Promise.all([programOf(), lookupOf(files)]).then(([program, lookup]) => ({ program, lookup, walker: new OriginWalker(program), replacements: bodyReplacements(program) })));

  return {
    async ofBody(site, path) {
      const { lookup, walker, replacements } = await prepare();
      if (replacements.length > 0) return replacements;
      const call = lookup.at(site);
      if (call === undefined) return [unreadable(site.file, site.line, "no call at the reported site")];
      const requests = lookup.bodiesOf(call);
      if (requests.length === 0) return [unreadable(site.file, site.line, "not a request body of the project")];
      const found = requests.flatMap((request) => walker.ofBody(request, path, call).map((origin): Origin => {
        const expression = request.expression;
        if (requests.length === 1 || expression === undefined) return origin;
        const source = expression.getSourceFile();
        return { ...origin, hops: [...origin.hops, { step: "argument", evidence: { path: source.fileName, line: lineOf(source, expression) } }] };
      }));
      return found;
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
