import type { Node } from "web-tree-sitter";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";
import type { JavaParser } from "./java-parser.adapter.ts";

const COMMENTS: readonly string[] = ["line_comment", "block_comment"];

/** The lines of a Java source no token but a comment touches, read from its tree-sitter parse. */
export function createJavaTrivia(parser: JavaParser): SourceTrivia {
  return {
    triviaLines: async (file) => {
      if (!isJavaSource(file.path)) return new Set();
      const parsed = parser.parse(file.content);
      if (!parsed.ok) return new Set();
      const code = new Set<number>();
      const visit = (node: Node): void => {
        if (COMMENTS.includes(node.type)) return;
        if (node.childCount > 0) return node.children.forEach((child) => child !== null && visit(child));
        for (let row = node.startPosition.row; row <= node.endPosition.row; row += 1) code.add(row + 1);
      };
      try {
        visit(parsed.value.root);
      } finally {
        parsed.value.dispose();
      }
      const lines = file.content.split("\n").length;
      return new Set(Array.from({ length: lines }, (_, index) => index + 1).filter((line) => !code.has(line)));
    },
  };
}
