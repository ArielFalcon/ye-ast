import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { Result } from "../../domain/shared/result.ts";

export interface JavaSyntaxTree {
  root: Node;
  /** Frees the native tree; `root` and every node under it are unusable afterwards. */
  dispose(): void;
}

export interface SyntaxFault {
  kind: "syntax-error";
  /** 1-based line of the first syntax error. */
  line: number;
}

export interface JavaParser {
  parse(source: string): Result<JavaSyntaxTree, SyntaxFault>;
}

const GRAMMAR = createRequire(import.meta.url).resolve("tree-sitter-java/tree-sitter-java.wasm");

let runtime: Promise<Language> | undefined;

function loadGrammar(): Promise<Language> {
  runtime ??= Parser.init().then(() => Language.load(GRAMMAR));
  return runtime;
}

/** Loads the grammar from ye-ast's own dependencies, never from an analysed repository. */
export async function createJavaParser(): Promise<JavaParser> {
  const grammar = await loadGrammar();
  const parser = new Parser();
  parser.setLanguage(grammar);
  return {
    parse(source) {
      const tree = parser.parse(source);
      if (tree === null) return { ok: false, fault: { kind: "syntax-error", line: 1 } };
      const root = tree.rootNode;
      if (root.hasError) {
        const line = firstErrorLine(root);
        tree.delete();
        return { ok: false, fault: { kind: "syntax-error", line } };
      }
      return { ok: true, value: { root, dispose: () => tree.delete() } };
    },
  };
}

function firstErrorLine(root: Node): number {
  const [first] = root.descendantsOfType("ERROR");
  return (first ?? root).startPosition.row + 1;
}
