import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, posix } from "node:path";
import { isRepositoryDirectory, mountOf, type DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";
import type { DeclaredEntry, DeclaredTree, DeclaredTrees } from "../../ports/declared-tree.port.ts";

interface EntryStatus {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DeclaredTreeDeps {
  lstat(path: string): EntryStatus | undefined;
  readlink(path: string): string;
  readFile(path: string): Buffer;
  readdir(path: string): string[];
}

export const defaultDeclaredTreeDeps: DeclaredTreeDeps = {
  lstat: (path) => lstatSync(path, { throwIfNoEntry: false }),
  readlink: (path) => readlinkSync(path),
  readFile: (path) => readFileSync(path),
  readdir: (path) => readdirSync(path),
};

const ABSENT: DeclaredEntry = { kind: "absent" };
const UNREADABLE_ROOT: DeclaredEntry = { kind: "unreadable", path: "" };

/**
 * Reads declared directories one path segment at a time with `lstat`, so no link is followed by the operating system:
 * each link's text is resolved against where the link stands in the snapshot (ADR-0037 decision 3).
 */
export function createDeclaredTrees(deps: DeclaredTreeDeps = defaultDeclaredTreeDeps): DeclaredTrees {
  return {
    open(output): DeclaredTree {
      let root: EntryStatus | undefined;
      try {
        root = deps.lstat(output.path);
      } catch (error) {
        if (!isFileSystemFault(error)) throw error;
      }
      const readable = root !== undefined && (root.isDirectory() || root.isSymbolicLink());
      return { entry: (path) => (!readable ? UNREADABLE_ROOT : path === "" || isRepositoryDirectory(path) ? entryOf(output, path, deps) : ABSENT) };
    },
  };
}

/** The entry at `path`; a path the file system would not read is `unreadable` there, never absent. */
function entryOf(output: DeclaredBuildOutput, path: string, deps: DeclaredTreeDeps): DeclaredEntry {
  try {
    return walkTo(output, path, deps);
  } catch (error) {
    if (!isFileSystemFault(error)) throw error;
    return { kind: "unreadable", path };
  }
}

/** A refusal of the host's file system (`EACCES`, `ENOTDIR`, `ELOOP`...), which carries its error code. */
function isFileSystemFault(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

function walkTo(output: DeclaredBuildOutput, path: string, deps: DeclaredTreeDeps): DeclaredEntry {
  const mount = mountOf(output);
  const followed = new Set<string>();
  let segments = path === "" ? [] : path.split("/");
  walk: for (;;) {
    let host = output.path;
    for (const [index, segment] of segments.entries()) {
      host = join(host, segment);
      const status = deps.lstat(host);
      if (status === undefined) return ABSENT;
      if (status.isSymbolicLink()) {
        const link = posix.join(mount, ...segments.slice(0, index + 1));
        const text = deps.readlink(host);
        if (posix.isAbsolute(text) || followed.has(link)) return { kind: "refused", link };
        followed.add(link);
        const target = posix.normalize(posix.join(posix.dirname(link), text));
        const rest = segments.slice(index + 1);
        if (target === mount || target.startsWith(`${mount}/`)) {
          segments = [...(target === mount ? [] : target.slice(mount.length + 1).split("/")), ...rest];
          continue walk;
        }
        if (target === ".." || target.startsWith("../")) return { kind: "refused", link };
        return { kind: "snapshot", path: posix.join(target, ...rest) };
      }
      if (index < segments.length - 1 && !status.isDirectory()) return ABSENT;
      if (index === segments.length - 1) return terminal(status, host, segments.join("/"), deps);
    }
    return terminal({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }, host, "", deps);
  }
}

function terminal(status: EntryStatus, host: string, path: string, deps: DeclaredTreeDeps): DeclaredEntry {
  if (status.isFile()) return { kind: "file", path, content: deps.readFile(host).toString("utf8") };
  if (status.isDirectory()) return { kind: "directory", path, names: deps.readdir(host).toSorted() };
  return ABSENT;
}
