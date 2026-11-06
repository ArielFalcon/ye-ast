import type { OutlineValue } from "../domain/outline/outline-fact.ts";
import type { Fact } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { UnknownSymbolFault } from "./impact-queries.port.ts";
import type { LiveFault, LiveSelector } from "./live-queries.port.ts";
import type { VcsFault } from "./vcs.port.ts";

interface OutlineBase {
  /** Path of the root of a git repository to read. */
  repo: string;
  /** Stable name of the repository in the snapshot of every fact; never a path. */
  repoId: string;
  scope?: ScopeRequest;
  /** Aborting stops the work, removes every temporary directory and answers an `aborted` fault. */
  signal?: AbortSignal;
}

/**
 * A declaration of a file to focus on: a dotted path matched against the file's `contains` tree at whole names (a bare
 * name at any depth), or a 1-based line, which selects the innermost declaration holding it.
 */
export type OutlineSelector = { file: string; symbol: string } | { file: string; line: number };

/** Repo-relative paths to describe whole, or the declarations to focus on instead; never both. */
type OutlineSubject = { files: readonly string[]; focus?: undefined } | { focus: readonly OutlineSelector[]; files?: undefined };

export type OutlineRequest = OutlineBase & OutlineSubject & ({ revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector));

/** A focused line no declaration of its file holds; `entries` lists every such line with the file's dotted paths. */
export interface TopLevelLineFault {
  kind: "top-level-line";
  detail: string;
  entries: readonly {
    file: string;
    line: number;
    /** The dotted paths of the file's declarations, sorted and once each. */
    candidates: readonly string[];
  }[];
}

export type OutlineFault = VcsFault | LiveFault | UnknownSymbolFault | TopLevelLineFault;

export interface OutlineQueries {
  /**
   * Per requested file, the declarations a reader can open by span and the files it imports, read from the index the
   * other queries use: no file is opened. A requested file outside the declared scope or that the index holds nothing
   * of is a cut, never an empty entry. With `focus`, only the matched declarations with their containers and how many of
   * the file's declarations were left out; a symbol that matches none is an `unknown-symbol` fault whose candidates are
   * dotted paths, and a line no declaration holds a `top-level-line` fault.
   */
  outline(request: OutlineRequest): Promise<Result<Fact<OutlineValue>, OutlineFault>>;
}
