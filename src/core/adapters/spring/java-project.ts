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
import { createJavaProject, describeFile, type JavaFile, type JavaProject, type ProjectBuild, type TypeDecl } from "./java-symbols.ts";

/** A Java source that does not parse, at the line of its first syntax error (line 1 when the parser throws). */
export interface UnparsedSource {
  path: string;
  line: number;
}

export interface ParsedJava {
  files: JavaFile[];
  unparsed: UnparsedSource[];
  /** The unparsed sources whose declarations are read: each syntax error lies in a member body (`JavaParser.parse`'s `declarations` reading). */
  declared: JavaFile[];
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
/** A read asked for a project of a parse hold that was released: its trees are gone, so a new read must open a hold. */
export class ReleasedParseHoldError extends Error {
  constructor() {
    super("the parse hold was released");
    this.name = "ReleasedParseHoldError";
  }
}

export interface HeldJavaProject {
  files: readonly HeldJavaSource[];
  project: JavaProject;
  unparsed: readonly UnparsedSource[];
  /** The unparsed sources whose declarations are read, and the project over them and `files` (`declarationsProject`). */
  declared: readonly JavaFile[];
  declarations: JavaProject;
  /** Whether a path is one of the read's own sources: every reader that lists sites, routes or entrypoints filters by it. */
  owns(path: string): boolean;
}

const heldProjects = new WeakMap<ParseHold, Map<string, Promise<HeldJavaProject>>>();

/**
 * The project a read's hold builds once over `sources` and its declared files, shared by every reader of the read; the
 * hold owns every tree from `keep` on, so the block that parses never disposes one, and `release` ends the project.
 * The identity is every input the project reads — each source's path and content, on each side of the owned/declared
 * split — never the list that carries them, so a changed source or a declared file is another project.
 */
export function heldJavaProject(hold: ParseHold, parser: () => Promise<JavaParser>, sources: readonly SourceFile[], declared: readonly SourceFile[] = [], build: ProjectBuild = {}): Promise<HeldJavaProject> {
  if (!hold.open()) return Promise.reject(new ReleasedParseHoldError());
  let byKey = heldProjects.get(hold);
  if (byKey === undefined) {
    byKey = new Map();
    heldProjects.set(hold, byKey);
  }
  const key = projectKey(sources, declared, build);
  let held = byKey.get(key);
  if (held === undefined) {
    held = buildHeldJavaProject(hold, parser, sources, declared, build);
    byKey.set(key, held);
  }
  return held;
}

function projectKey(sources: readonly SourceFile[], declared: readonly SourceFile[], build: ProjectBuild): string {
  return JSON.stringify([sources.map(({ path, content }) => [path, content]), declared.map(({ path, content }) => [path, content]), build.generatesInterfaces === true]);
}

async function buildHeldJavaProject(hold: ParseHold, parser: () => Promise<JavaParser>, sources: readonly SourceFile[], declared: readonly SourceFile[], build: ProjectBuild): Promise<HeldJavaProject> {
  const kept = hold.keep([...sources, ...declared]);
  const read = await parser();
  return withJavaSources(read, (parse) => {
    const parsed = parse(kept);
    const { files, unparsed } = parsed;
    const owned = new Set(sources.map(({ path }) => path));
    const project = createJavaProject(files, build);
    return { files: files.map((file) => ({ file, owned: owned.has(file.path) })), project, unparsed, declared: parsed.declared, declarations: declarationsProject(parsed, project, build), owns: (path: string) => owned.has(path) };
  });
}

/** Runs `use` with a reader of Java sources and frees every syntax tree it parsed once `use` returns or throws. */
export function withJavaSources<T>(parser: JavaParser, use: (parse: ParseJava) => T): T {
  const trees: JavaSyntaxTree[] = [];
  const parse: ParseJava = (sources) => {
    const parsed: ParsedJava = { files: [], unparsed: [], declared: [] };
    for (const source of sources) {
      const read = readSource(parser, source, trees);
      if ("file" in read) parsed.files.push(read.file);
      else {
        parsed.unparsed.push(read.unparsed);
        if (read.declared !== undefined) parsed.declared.push(read.declared);
      }
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

/**
 * The project over the read sources and the declarations of the unparsed sources that `declared` holds: what a proof that
 * reads only declarations (which type a written name denotes) may read; `project` itself when none is declared.
 */
export function declarationsProject(parsed: ParsedJava, project: JavaProject, build: ProjectBuild = {}): JavaProject {
  return parsed.declared.length === 0 ? project : createJavaProject([...parsed.files, ...parsed.declared], build);
}

function readSource(parser: JavaParser, source: SourceFile | LibrarySource, trees: JavaSyntaxTree[]): { file: JavaFile } | { unparsed: UnparsedSource; declared?: JavaFile } {
  const path = "repo" in source ? libraryPath(source.repo, source.path) : source.path;
  try {
    const result = parser.parse(source, "declarations");
    if (!result.ok) return { unparsed: { path, line: result.fault.line } };
    trees.push(result.value);
    if (result.value.unread !== undefined) return { unparsed: { path, line: result.value.unread.line }, declared: describeFile(path, result.value.root) };
    return { file: describeFile(path, result.value.root) };
  } catch {
    return { unparsed: { path, line: 1 } };
  }
}
