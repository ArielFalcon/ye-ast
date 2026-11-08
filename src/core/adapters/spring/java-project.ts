import { libraryPath, type LibrarySource } from "../../domain/topology/library-source.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { Node } from "web-tree-sitter";
import { enclosingBody } from "../tree-sitter/java-function-value-calls.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { describeFile, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";

/** A Java source that does not parse, at the line of its first syntax error (line 1 when the parser throws). */
export interface UnparsedSource {
  path: string;
  line: number;
}

export interface ParsedJava {
  files: JavaFile[];
  unparsed: UnparsedSource[];
}

export type ParseJava = (sources: readonly (SourceFile | LibrarySource)[]) => ParsedJava;

/** Runs `use` with a reader of Java sources and frees every syntax tree it parsed once `use` returns or throws. */
export function withJavaSources<T>(parser: JavaParser, use: (parse: ParseJava) => T): T {
  const trees: JavaSyntaxTree[] = [];
  const parse: ParseJava = (sources) => {
    const parsed: ParsedJava = { files: [], unparsed: [] };
    for (const source of sources) {
      const read = readSource(parser, source, trees);
      if ("file" in read) parsed.files.push(read.file);
      else parsed.unparsed.push(read.unparsed);
    }
    return parsed;
  };
  try {
    return use(parse);
  } finally {
    for (const tree of trees) tree.dispose();
  }
}

/** The innermost type of the project whose declaration holds `node`: the type the names written there resolve in. */
export function enclosingType(node: Node, file: JavaFile, project: JavaProject): TypeDecl | undefined {
  return project.types.filter((type) => type.file === file && type.node.startIndex <= node.startIndex && node.endIndex <= type.node.endIndex).sort((a, b) => b.node.startIndex - a.node.startIndex)[0];
}

/**
 * The type whose instance `this` and `super` denote at `node`: the type whose body holds it, through lambdas. Inside an
 * anonymous or a local class, which the project does not hold, no type answers.
 */
export function thisType(node: Node, file: JavaFile, project: JavaProject): TypeDecl | undefined {
  const holder = enclosingBody(node)?.parent;
  return holder === null || holder === undefined ? undefined : project.types.find((type) => type.file === file && type.node.id === holder.id);
}

function readSource(parser: JavaParser, source: SourceFile | LibrarySource, trees: JavaSyntaxTree[]): { file: JavaFile } | { unparsed: UnparsedSource } {
  const path = "repo" in source ? libraryPath(source.repo, source.path) : source.path;
  try {
    const result = parser.parse(source);
    if (!result.ok) return { unparsed: { path, line: result.fault.line } };
    trees.push(result.value);
    return { file: describeFile(path, result.value.root) };
  } catch {
    return { unparsed: { path, line: 1 } };
  }
}
