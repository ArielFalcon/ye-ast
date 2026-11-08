import { dirname, posix } from "node:path";
import ts from "typescript";
import { mountOf, type DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";
import type { DeclaredEntry, DeclaredTree, DeclaredTrees } from "../../ports/declared-tree.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { programTree } from "./source-tree.ts";

/** Where the snapshot and the compiler's own `lib` files stand for the compiler; no other path exists for it. */
export const REPOSITORY_ROOT = "/repo";
const LIB_ROOT = "/lib";
const LIB_DIRECTORY = dirname(ts.getDefaultLibFilePath({}));

type Found = { kind: "file"; text: string; real: string } | { kind: "directory"; names: readonly string[]; real: string };

/** A path under a declared directory the compiler asked about, with what it found there. */
export interface DeclaredRead {
  output: number;
  path: string;
  entry: DeclaredEntry;
}

/** A directory's file and directory names, as the compiler's `include` matcher asks for them. */
export interface DirectoryEntries {
  files: readonly string[];
  directories: readonly string[];
}

export interface ConfinedHost {
  host: ts.CompilerHost;
  /** The snapshot's own entries of a directory, without any declared directory: what a configuration's `include` matches. */
  snapshotEntries(directory: string): DirectoryEntries;
  /** Whether a compiler path is one of the language's own libraries. */
  isLibrary(fileName: string): boolean;
  /** The output and the path under it a compiler path stands for, when it is under a declared directory. */
  declaredPlace(fileName: string): { output: DeclaredBuildOutput; path: string } | undefined;
  refused: ReadonlySet<string>;
  reads: readonly DeclaredRead[];
}

/**
 * A compiler host that serves three sets only (ADR-0037 decision 3): the snapshot's files, the files under each declared
 * directory, read through its confined tree, and the compiler's own `lib` files. Every other path does not exist, so a
 * configuration's `extends`, `paths`, `typeRoots`, `include` or `references` reaches nothing else. Parsed files are shared
 * by every program the host serves.
 */
export function createConfinedHost(sources: readonly SourceFile[], outputs: readonly DeclaredBuildOutput[], trees: DeclaredTrees): ConfinedHost {
  const files = new Map(sources.map(({ path, content }) => [path, content]));
  const directories = new Map<string, { files: Set<string>; directories: Set<string> }>();
  const listing = (directory: string) => {
    let held = directories.get(directory);
    if (held === undefined) directories.set(directory, (held = { files: new Set(), directories: new Set() }));
    return held;
  };
  listing("");
  for (const path of files.keys()) {
    const segments = path.split("/");
    for (let depth = 0; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join("/");
      const name = segments[depth]!;
      if (depth === segments.length - 1) listing(parent).files.add(name);
      else listing(parent).directories.add(name);
    }
  }
  const mounts = outputs.map((output, index) => ({ output, index, mount: mountOf(output), tree: trees.open(output) })).toSorted((a, b) => b.mount.length - a.mount.length);
  const refused = new Set<string>();
  const reads: DeclaredRead[] = [];
  const asked = new Map<string, Found | undefined>();

  const mountFor = (path: string) => mounts.find(({ mount }) => path === mount || path.startsWith(`${mount}/`));
  const read = (tree: DeclaredTree, index: number, path: string): DeclaredEntry => {
    const entry = tree.entry(path);
    reads.push({ output: index, path, entry });
    return entry;
  };
  const inRepository = (path: string, visited: Set<string>): Found | undefined => {
    const mounted = mountFor(path);
    if (mounted !== undefined) {
      const entry = read(mounted.tree, mounted.index, path === mounted.mount ? "" : path.slice(mounted.mount.length + 1));
      const real = (inner: string) => `${REPOSITORY_ROOT}/${inner === "" ? mounted.mount : `${mounted.mount}/${inner}`}`;
      if (entry.kind === "file") return { kind: "file", text: entry.content, real: real(entry.path) };
      if (entry.kind === "directory") return { kind: "directory", names: entry.names, real: real(entry.path) };
      if (entry.kind === "refused") refused.add(entry.link);
      if (entry.kind !== "snapshot" || visited.has(entry.path)) return undefined;
      visited.add(entry.path);
      return inRepository(entry.path, visited);
    }
    const text = files.get(path);
    if (text !== undefined) return { kind: "file", text, real: `${REPOSITORY_ROOT}/${path}` };
    const held = directories.get(path);
    if (held === undefined && !mounts.some(({ mount }) => mount.startsWith(path === "" ? "" : `${path}/`))) return undefined;
    const names = new Set([...(held?.files ?? []), ...(held?.directories ?? [])]);
    for (const { mount } of mounts) {
      const prefix = path === "" ? "" : `${path}/`;
      if (mount.startsWith(prefix) && mount !== path) names.add(mount.slice(prefix.length).split("/")[0]!);
    }
    return { kind: "directory", names: [...names].toSorted(), real: path === "" ? REPOSITORY_ROOT : `${REPOSITORY_ROOT}/${path}` };
  };
  const lookup = (fileName: string): Found | undefined => {
    const path = posix.normalize(fileName);
    if (asked.has(path)) return asked.get(path);
    let found: Found | undefined;
    if (path === REPOSITORY_ROOT || path.startsWith(`${REPOSITORY_ROOT}/`)) found = inRepository(path.slice(REPOSITORY_ROOT.length + 1), new Set());
    else if (path.startsWith(`${LIB_ROOT}/`) && !path.slice(LIB_ROOT.length + 1).includes("/")) {
      const text = ts.sys.readFile(posix.join(LIB_DIRECTORY, path.slice(LIB_ROOT.length + 1)));
      found = text === undefined ? undefined : { kind: "file", text, real: path };
    }
    asked.set(path, found);
    return found;
  };

  const parsed = new Map<string, ts.SourceFile | undefined>();
  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersion) {
      const key = `${fileName}\0${JSON.stringify(languageVersion)}`;
      if (!parsed.has(key)) {
        const found = lookup(fileName);
        parsed.set(key, found?.kind === "file" ? programTree(fileName, found.text, languageVersion) : undefined);
      }
      return parsed.get(key);
    },
    getDefaultLibFileName: (options) => `${LIB_ROOT}/${ts.getDefaultLibFileName(options)}`,
    getDefaultLibLocation: () => LIB_ROOT,
    writeFile: () => undefined,
    getCurrentDirectory: () => REPOSITORY_ROOT,
    getDirectories: (directory) => {
      const found = lookup(directory);
      return found?.kind === "directory" ? found.names.filter((name) => lookup(posix.join(directory, name))?.kind === "directory") : [];
    },
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => lookup(fileName)?.kind === "file",
    readFile: (fileName) => {
      const found = lookup(fileName);
      return found?.kind === "file" ? found.text : undefined;
    },
    directoryExists: (directory) => lookup(directory)?.kind === "directory",
    realpath: (path) => lookup(path)?.real ?? path,
  };
  return {
    host,
    snapshotEntries(directory) {
      const path = posix.normalize(directory);
      const held = path === REPOSITORY_ROOT ? directories.get("") : path.startsWith(`${REPOSITORY_ROOT}/`) ? directories.get(path.slice(REPOSITORY_ROOT.length + 1)) : undefined;
      return { files: [...(held?.files ?? [])].toSorted(), directories: [...(held?.directories ?? [])].toSorted() };
    },
    isLibrary: (fileName) => fileName.startsWith(`${LIB_ROOT}/`),
    declaredPlace(fileName) {
      if (!fileName.startsWith(`${REPOSITORY_ROOT}/`)) return undefined;
      const path = fileName.slice(REPOSITORY_ROOT.length + 1);
      const mounted = mountFor(path);
      return mounted === undefined ? undefined : { output: mounted.output, path: path === mounted.mount ? "" : path.slice(mounted.mount.length + 1) };
    },
    refused,
    reads,
  };
}
