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

/** A tree whose declarations are read. */
export interface JavaDeclarationsTree extends JavaSyntaxTree {
  /** Absent when the source parses: the member bodies every syntax error lies in, and the line `parse`'s fault names. */
  unread?: { bodies: readonly Node[]; line: number };
}

export interface SyntaxFault {
  kind: "syntax-error";
  /** 1-based line of the first syntax error. */
  line: number;
}

type Parsed = Result<JavaDeclarationsTree, SyntaxFault>;

export interface JavaParser {
  /**
   * The tree of `source`: the one the open hold that kept it parsed once, or a new one `dispose` frees. A syntax error
   * is a fault, except under the `declarations` reading where every syntax error lies in a member body (`unread`).
   */
  parse(source: SourceFile, reading?: "declarations"): Parsed;
}

/** One parse of a source: its tree and the bodies its syntax errors lie in, or the fault where they are not confined. */
type Read = Result<{ root: Node; free(): void; unreadBodies: readonly Node[]; line: number }, SyntaxFault>;

/** The trees of the sources open holds kept, one per file of each hold by its path and content, so a file two snapshots of one read share unchanged parses once. */
export interface JavaTreeHolds extends ParseHolds {
  /** What `read` answers for `source`, owned by the open hold that kept it: freed at its release; `undefined` without one. */
  held(source: SourceFile, read: () => Read): Read | undefined;
}

interface Hold {
  /** Absent once released. */
  trees: Map<string, Read> | undefined;
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
          for (const read of trees?.values() ?? []) if (read.ok) read.value.free();
        },
      };
    },
    held(source, read) {
      const trees = keptBy.get(source)?.trees;
      if (trees === undefined) return undefined;
      const file = `${source.path}\0${source.content}`;
      let tree = trees.get(file);
      if (tree === undefined) {
        tree = read();
        trees.set(file, tree);
      }
      return tree;
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
  const read = (content: string): Read => {
    const tree = parser.parse(content);
    if (tree === null) return { ok: false, fault: { kind: "syntax-error", line: 1 } };
    const root = tree.rootNode;
    const free = () => tree.delete();
    if (!root.hasError) return { ok: true, value: { root, free, unreadBodies: [], line: 0 } };
    const line = firstErrorLine(root);
    const unreadBodies = confiningBodies(root);
    if (unreadBodies === undefined) {
      free();
      return { ok: false, fault: { kind: "syntax-error", line } };
    }
    return { ok: true, value: { root, free, unreadBodies, line } };
  };
  return {
    parse(source, reading) {
      const held = holds?.held(source, () => read(source.content));
      const owned = held === undefined;
      const parsed = held ?? read(source.content);
      if (!parsed.ok) return parsed;
      const { root, free, unreadBodies, line } = parsed.value;
      const dispose = owned ? free : () => {};
      if (unreadBodies.length === 0) return { ok: true, value: { root, dispose } };
      if (reading === "declarations") return { ok: true, value: { root, dispose, unread: { bodies: unreadBodies, line } } };
      dispose();
      return { ok: false, fault: { kind: "syntax-error", line } };
    },
  };
}

function firstErrorLine(root: Node): number {
  const [first] = root.descendantsOfType("ERROR");
  return (first ?? root).startPosition.row + 1;
}

/** The nodes statements are written in: a type a body declares is local to it, so no name outside it denotes one (JLS 6.3). */
const BODIES: ReadonlySet<string> = new Set(["block", "constructor_body"]);

/**
 * The bodies the syntax errors of a tree lie in, or `undefined` when one is not confined to a body. An error is confined
 * when the outermost body around it (a method's, a constructor's, an initializer's, or one a field's initializer writes)
 * ends at the brace that closes its first brace. Under the assumption that the repository compiles (ADR-0062), braces
 * then delimit that body as the compiler reads it, so it declares nothing but local types, and every declaration
 * outside it, which holds no error, is read as written. An error a field's initializer holds outside such a body stays
 * unconfined, since no delimiter separates it from the field's own declaration.
 */
function confiningBodies(root: Node): readonly Node[] | undefined {
  const bodies = new Map<number, Node>();
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.isError || node.isMissing) {
      const body = outermostBody(node);
      if (body === undefined || !delimits(body)) return undefined;
      bodies.set(body.id, body);
      continue;
    }
    for (const child of node.children) if (child !== null && (child.hasError || child.isMissing || child.isError)) pending.push(child);
  }
  return [...bodies.values()].sort((a, b) => a.startIndex - b.startIndex);
}

function outermostBody(node: Node): Node | undefined {
  let body: Node | undefined;
  for (let at = node.parent; at !== null; at = at.parent) if (BODIES.has(at.type)) body = at;
  return body;
}

/** Whether the brace that closes the body's first brace, counting the tokens the source writes, is the body's last token. */
function delimits(body: Node): boolean {
  const tokens: Node[] = [];
  const pending: Node[] = [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.childCount === 0) {
      if (!node.isMissing) tokens.push(node);
    } else for (const child of node.children.toReversed()) if (child !== null) pending.push(child);
  }
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    depth += token.type === "{" ? 1 : token.type === "}" ? -1 : 0;
    if (depth === 0) return index === tokens.length - 1;
  }
  return false;
}
