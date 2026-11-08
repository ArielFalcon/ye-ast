import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

interface Parsed {
  target: ts.ScriptTarget;
  kind: ts.ScriptKind | undefined;
  tree: ts.SourceFile;
}

interface Source {
  path: string;
  content: string;
  parsed: Parsed[];
}

const trees = new WeakMap<SourceFile, Source>();
/** The last source seen at a path, without keeping it alive: an unchanged file read in two revisions shares its trees. */
const byPath = new Map<string, WeakRef<Source>>();
const forgotten = new FinalizationRegistry<{ path: string; ref: WeakRef<Source> }>(({ path, ref }) => {
  if (byPath.get(path) === ref) byPath.delete(path);
});

const holds = (source: Source | undefined, file: SourceFile): source is Source => source !== undefined && source.path === file.path && source.content === file.content;

function sourceOf(file: SourceFile): Source {
  const own = trees.get(file);
  if (holds(own, file)) return own;
  const seen = byPath.get(file.path)?.deref();
  const source = holds(seen, file) ? seen : { path: file.path, content: file.content, parsed: [] };
  trees.set(file, source);
  if (source !== seen) {
    const ref = new WeakRef(source);
    byPath.set(file.path, ref);
    forgotten.register(source, { path: file.path, ref });
  }
  return source;
}

export function sourceTree(file: SourceFile, target: ts.ScriptTarget, kind?: ts.ScriptKind): ts.SourceFile {
  const source = sourceOf(file);
  const held = source.parsed.find((parsed) => parsed.target === target && parsed.kind === kind);
  if (held !== undefined) return held.tree;
  const tree = ts.createSourceFile(file.path, file.content, target, true, kind);
  source.parsed.push({ target, kind, tree });
  return tree;
}

/** A tree a program binds: parsed alone and never shared, since binding writes into the tree it binds. */
export function programTree(fileName: string, content: string, target: ts.ScriptTarget | ts.CreateSourceFileOptions): ts.SourceFile {
  return ts.createSourceFile(fileName, content, target, true);
}
