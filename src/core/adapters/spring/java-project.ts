/**
 * Java syntax trees and the project a snapshot read derives from them. The read's parse hold (ADR-0040) owns both: it
 * keeps the sources and frees every tree at the read's end, and `heldJavaProject` reads one project over them, split
 * into the read's own sources and the declarations a host declared (V4.2).
 */
import { libraryPath, type LibrarySource } from "../../domain/topology/library-source.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import type { Node } from "web-tree-sitter";
import { enclosingBody } from "../tree-sitter/java-function-value-calls.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaProject, describeFile, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";

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

/** A Java source as the held project states it: the read's own sources, or the declarations a host declared (V4.2). */
export interface HeldJavaSource {
  file: JavaFile;
  /** `false` for a declared generated source: a declaration for binding and closure, never a site, route or entrypoint. */
  owned: boolean;
}

/**
 * One project per read, held by the read's parse hold (ADR-0040): `keep` gives the sources the hold parses once,
 * `release` frees every tree at the read's end. One held value per (sources identity, declared outputs identity).
 */
export interface HeldJavaProject {
  files: readonly HeldJavaSource[];
  project: JavaProject;
  unparsed: readonly UnparsedSource[];
  /** Whether a path is one of the read's own sources: every reader that lists sites, routes or entrypoints filters by it. */
  owns(path: string): boolean;
}

const heldProjects = new WeakMap<ParseHold, WeakMap<readonly SourceFile[], Promise<HeldJavaProject>>>();

/**
 * The project a read's hold builds once over `sources` and its declared files, shared by every reader of the read; the
 * hold owns every tree from `keep` on, so the block that parses never disposes one, and `release` ends the project.
 */
export function heldJavaProject(hold: ParseHold, parser: () => Promise<JavaParser>, sources: readonly SourceFile[], declared: readonly SourceFile[] = []): Promise<HeldJavaProject> {
  let bySources = heldProjects.get(hold);
  if (bySources === undefined) {
    bySources = new WeakMap();
    heldProjects.set(hold, bySources);
  }
  let held = bySources.get(sources);
  if (held === undefined) {
    held = buildHeldJavaProject(hold, parser, sources, declared);
    bySources.set(sources, held);
  }
  return held;
}

/** The read's held project when its parser reads sources a hold kept, so a reader below the port shares the one project. */
export async function heldJavaProjectOf(parser: JavaParser, sources: readonly SourceFile[], declared: readonly SourceFile[] = []): Promise<HeldJavaProject | undefined> {
  const hold = sources.map((source) => parser.holdOf?.(source)).find((found) => found !== undefined);
  return hold === undefined ? undefined : heldJavaProject(hold, () => Promise.resolve(parser), sources, declared);
}

async function buildHeldJavaProject(hold: ParseHold, parser: () => Promise<JavaParser>, sources: readonly SourceFile[], declared: readonly SourceFile[]): Promise<HeldJavaProject> {
  const kept = hold.keep([...sources, ...declared]);
  const read = await parser();
  return withJavaSources(read, (parse) => {
    const { files, unparsed } = parse(kept);
    const owned = new Set(sources.map(({ path }) => path));
    return { files: files.map((file) => ({ file, owned: owned.has(file.path) })), project: createJavaProject(files), unparsed, owns: (path: string) => owned.has(path) };
  });
}

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
