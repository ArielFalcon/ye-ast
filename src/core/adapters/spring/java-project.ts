import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { describeFile, type JavaFile } from "./java-symbols.ts";

/** A Java source that does not parse, at the line of its first syntax error (line 1 when the parser throws). */
export interface UnparsedSource {
  path: string;
  line: number;
}

export interface ParsedJava {
  files: JavaFile[];
  unparsed: UnparsedSource[];
}

export type ParseJava = (sources: readonly SourceFile[]) => ParsedJava;

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

function readSource(parser: JavaParser, source: SourceFile, trees: JavaSyntaxTree[]): { file: JavaFile } | { unparsed: UnparsedSource } {
  try {
    const result = parser.parse(source.content);
    if (!result.ok) return { unparsed: { path: source.path, line: result.fault.line } };
    trees.push(result.value);
    return { file: describeFile(source.path, result.value.root) };
  } catch {
    return { unparsed: { path: source.path, line: 1 } };
  }
}
