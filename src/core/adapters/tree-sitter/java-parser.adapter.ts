import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { Result } from "../../domain/shared/result.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ParseHolds } from "../../ports/parse-holds.port.ts";

export interface JavaSyntaxTree {
  root: Node;
  /** Frees the native tree unless an open hold owns it; `root` and every node under it are unusable once it is freed. */
  dispose(): void;
}

export interface SyntaxFault {
  kind: "syntax-error";
  /** 1-based line of the first syntax error. */
  line: number;
}

type Parsed = Result<JavaSyntaxTree, SyntaxFault>;

export interface JavaParser {
  /** The tree of `source`: the one the open hold that kept it parsed once, or a new one `dispose` frees. */
  parse(source: SourceFile): Parsed;
}

/** The trees of the sources open holds kept, one per file of each hold by its path and content, so a file two snapshots of one read share unchanged parses once. */
export interface JavaTreeHolds extends ParseHolds {
  /** What `parse` answers for `source`, owned by the open hold that kept it; without one, `parse`'s own answer. */
  held(source: SourceFile, parse: () => Parsed): Parsed;
}

interface Hold {
  /** Absent once released. */
  trees: Map<string, { parsed: Parsed; free(): void }> | undefined;
}

export function createJavaTreeHolds(): JavaTreeHolds {
  const keptBy = new WeakMap<SourceFile, Hold>();
  return {
    open() {
      const hold: Hold = { trees: new Map() };
      return {
        keep: (sources) => sources.map((source) => {
          const own = { ...source };
          keptBy.set(own, hold);
          return own;
        }),
        open: () => hold.trees !== undefined,
        release() {
          const trees = hold.trees;
          hold.trees = undefined;
          for (const { free } of trees?.values() ?? []) free();
        },
      };
    },
    held(source, parse) {
      const trees = keptBy.get(source)?.trees;
      if (trees === undefined) return parse();
      const file = `${source.path}\0${source.content}`;
      let tree = trees.get(file);
      if (tree === undefined) {
        const parsed = parse();
        tree = parsed.ok ? { parsed: { ok: true, value: { root: parsed.value.root, dispose: () => {} } }, free: parsed.value.dispose } : { parsed, free: () => {} };
        trees.set(file, tree);
      }
      return tree.parsed;
    },
  };
}

const GRAMMAR = createRequire(import.meta.url).resolve("tree-sitter-java/tree-sitter-java.wasm");

let runtime: Promise<Language> | undefined;

function loadGrammar(): Promise<Language> {
  runtime ??= Parser.init().then(() => Language.load(GRAMMAR));
  return runtime;
}

/** Loads the grammar from ye-ast's own dependencies, never from an analysed repository. */
export async function createJavaParser(holds?: JavaTreeHolds): Promise<JavaParser> {
  const grammar = await loadGrammar();
  const parser = new Parser();
  parser.setLanguage(grammar);
  const parse = (content: string): Parsed => {
    const tree = parser.parse(content);
    if (tree === null) return { ok: false, fault: { kind: "syntax-error", line: 1 } };
    const root = tree.rootNode;
    if (root.hasError) {
      const line = firstErrorLine(root);
      tree.delete();
      return { ok: false, fault: { kind: "syntax-error", line } };
    }
    return { ok: true, value: { root, dispose: () => tree.delete() } };
  };
  return { parse: (source) => (holds === undefined ? parse(source.content) : holds.held(source, () => parse(source.content))) };
}

function firstErrorLine(root: Node): number {
  const [first] = root.descendantsOfType("ERROR");
  return (first ?? root).startPosition.row + 1;
}
