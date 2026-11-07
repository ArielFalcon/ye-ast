import ts from "typescript";
import { sourceTree } from "./source-tree.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { DynamicLoadReader, DynamicLoad } from "../../ports/dynamic-loads.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

/** The calls that load a module at run time in a TypeScript or JavaScript source; `import(…)` is a keyword, not a name. */
const LOADING_CALLS: ReadonlySet<string> = new Set(["require"]);

/**
 * The dynamic loads of every TypeScript source given, one entry per load with its line and, when it names a literal,
 * its specifier. A call and the `typeof import('x')` of a type both load a module. Parsed, never built nor run.
 */
export function createDynamicLoadReader(): DynamicLoadReader {
  return { extract: async (files) => files.filter((file) => isTypeScriptSource(file.path)).flatMap(loadsOf) };
}

function loadsOf(file: SourceFile): DynamicLoad[] {
  const source = sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  const loads: DynamicLoad[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && loadsModule(node)) {
      loads.push(entryOf(file, source, node, callSpecifier(node)));
    } else if (ts.isImportTypeNode(node)) {
      loads.push(entryOf(file, source, node, importTypeSpecifier(node)));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return loads;
}

function entryOf(file: SourceFile, source: ts.SourceFile, node: ts.Node, specifier: string | undefined): DynamicLoad {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return { file: file.path, line, ...(specifier === undefined ? {} : { specifier }) };
}

function loadsModule(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && LOADING_CALLS.has(callee.text));
}

/** The module a call names: its first argument when it is a string, with or without substitutions. */
function callSpecifier(call: ts.CallExpression): string | undefined {
  const [first] = call.arguments;
  return first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
}

/** The module a type names: `typeof import('x')` and `import('x').A` carry the specifier as a string literal type. */
function importTypeSpecifier(node: ts.ImportTypeNode): string | undefined {
  return ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? node.argument.literal.text : undefined;
}
