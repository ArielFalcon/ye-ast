import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { Result } from "../../domain/shared/result.ts";
import { sourceKey } from "../../domain/shared/source-identity.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ParseHolds, TreeResidence } from "../../ports/parse-holds.port.ts";

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

/**
 * The trees of the sources open holds kept, one per path and content whatever hold kept it, so a file two snapshots or
 * two reads share unchanged parses once (ADR-0040, ADR-0155).
 */
export interface JavaTreeHolds extends ParseHolds {
  /** What `read` answers for `source`, owned by the open hold that kept it until its release: `undefined` without one. */
  held(source: SourceFile, read: () => Read): Read | undefined;
}

/**
 * The heap a resident tree takes per UTF-8 byte of its source's content and key: the marginal RSS of a held tree
 * (16.5-18.6) plus its JS heap (0.26-0.47), the largest of each, rounded up (ADR-0155). A charge, not a threshold.
 */
export const TREE_HEAP_PER_SOURCE_BYTE = 19.1;

/** A tree and its owners: each open hold handed it, and the residence while it keeps it; freed when the last one lets it go. */
interface OwnedTree {
  read: Read;
  owners: number;
  /** The residence key and charge, set the first time a residence is asked to keep it. */
  residence?: { key: string; bytes: number; kept: boolean };
}

interface Hold {
  /** The keys of the trees this hold owns; absent once released. */
  trees: Set<string> | undefined;
}

export function createJavaTreeHolds(): JavaTreeHolds {
  const prefix = `java-tree\0${randomUUID()}\0`;
  const trees = new Map<string, OwnedTree>();
  const keptBy = new WeakMap<SourceFile, { hold: Hold; residence: TreeResidence | undefined }>();
  const disown = (file: string, tree: OwnedTree): void => {
    tree.owners--;
    if (tree.owners > 0) return;
    trees.delete(file);
    if (tree.read.ok) tree.read.value.free();
  };
  const reside = (file: string, tree: OwnedTree, content: string, residence: TreeResidence): void => {
    if (!tree.read.ok) return;
    if (tree.residence === undefined) {
      const key = prefix + file;
      tree.residence = { key, bytes: Math.ceil(TREE_HEAP_PER_SOURCE_BYTE * (Buffer.byteLength(content) + Buffer.byteLength(key))), kept: false };
    }
    const resident = tree.residence;
    const evicted = () => {
      resident.kept = false;
      disown(file, tree);
    };
    if (!residence.reside(resident.key, resident.bytes, evicted) || resident.kept) return;
    resident.kept = true;
    tree.owners++;
  };
  return {
    open() {
      const hold: Hold = { trees: new Set() };
      return {
        keep: (sources, residence) => sources.map((source) => {
          const own = { ...source };
          const copied = keptBy.get(source);
          keptBy.set(own, { hold, residence: residence ?? (copied?.hold === hold ? copied.residence : undefined) });
          return own;
        }),
        open: () => hold.trees !== undefined,
        release() {
          const owned = hold.trees;
          hold.trees = undefined;
          for (const file of owned ?? []) disown(file, trees.get(file)!);
        },
      };
    },
    held(source, read) {
      const kept = keptBy.get(source);
      const owned = kept?.hold.trees;
      if (kept === undefined || owned === undefined) return undefined;
      const file = sourceKey(source);
      let tree = trees.get(file);
      if (tree === undefined) {
        tree = { read: read(), owners: 0 };
        trees.set(file, tree);
      }
      if (!owned.has(file)) {
        owned.add(file);
        tree.owners++;
      }
      if (kept.residence !== undefined) reside(file, tree, source.content, kept.residence);
      return tree.read;
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
