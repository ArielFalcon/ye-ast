import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

interface Entry {
  path: string;
  content: string;
  target: ts.ScriptTarget;
  kind: ts.ScriptKind | undefined;
  tree: ts.SourceFile;
}

const trees = new WeakMap<SourceFile, Entry[]>();

export function sourceTree(file: SourceFile, target: ts.ScriptTarget, kind?: ts.ScriptKind): ts.SourceFile {
  let entries = trees.get(file);
  if (entries === undefined || entries.some((entry) => entry.path !== file.path || entry.content !== file.content)) {
    entries = [];
    trees.set(file, entries);
  }
  const held = entries.find((entry) => entry.target === target && entry.kind === kind);
  if (held !== undefined) return held.tree;
  const tree = ts.createSourceFile(file.path, file.content, target, true, kind);
  entries.push({ path: file.path, content: file.content, target, kind, tree });
  return tree;
}
