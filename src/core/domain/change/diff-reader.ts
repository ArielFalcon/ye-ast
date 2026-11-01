import { declaredIdentifier } from "./declared-identifiers.ts";

export interface LineRange {
  start: number;
  end: number;
}

/** What a unified diff with no context says about one file. */
export interface FileChange {
  path: string;
  deleted: boolean;
  binary: boolean;
  /** The new-side lines the diff added or replaced, inclusive ranges in diff order. */
  added: readonly LineRange[];
  /** The places where lines were removed without replacement. */
  removals: readonly Removal[];
  /**
   * The names the removed lines declared (see `declaredIdentifier`) that no added line of the file declares again, in
   * order: an edited signature keeps its name, a rename or a deletion loses it.
   */
  removedNames: readonly string[];
}

export interface Removal {
  /** The new-side line after which the lines vanished; 0 is before the first line. */
  after: number;
}

/** A `diff --git` header the reader cannot split into a path. */
export class UnreadableDiff extends Error {
  constructor(header: string) {
    super(`cannot read the path of ${header}`);
    this.name = "UnreadableDiff";
  }
}

/** Reads the lines of `git diff-tree -p --unified=0` one at a time, so a large diff is never held whole. */
export interface DiffReader {
  push(line: string): void;
  finish(): FileChange[];
}

interface Building {
  path: string;
  deleted: boolean;
  binary: boolean;
  added: LineRange[];
  removals: Removal[];
  removedNames: string[];
  addedNames: Set<string>;
}

const DIFF_HEADER = "diff --git ";
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function createDiffReader(): DiffReader {
  const files: Building[] = [];
  let current: Building | undefined;

  function push(line: string): void {
    if (line.startsWith(DIFF_HEADER)) {
      const path = diffGitHeaderPath(line);
      if (path === undefined) throw new UnreadableDiff(line);
      current = { path, deleted: false, binary: false, added: [], removals: [], removedNames: [], addedNames: new Set() };
      files.push(current);
      return;
    }
    if (current === undefined) return;
    if (line.startsWith("-") || line.startsWith("+")) {
      const name = declaredIdentifier(line.slice(1));
      if (name !== undefined) {
        if (line.startsWith("-")) current.removedNames.push(name);
        else current.addedNames.add(name);
      }
      return;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) current.removals.push({ after: start });
      else current.added.push({ start, end: start + count - 1 });
      return;
    }
    if (line.startsWith("deleted file mode")) current.deleted = true;
    else if (line.startsWith("Binary files ")) current.binary = true;
  }

  return {
    push,
    finish: () =>
      files.map(({ path, deleted, binary, added, removals, removedNames, addedNames }): FileChange => ({
        path,
        deleted,
        binary,
        added,
        removals,
        removedNames: [...new Set(removedNames)].filter((name) => !addedNames.has(name)),
      })),
  };
}

/** The b-side path of a `diff --git` header (the a-side for a deletion), read as git quotes it. */
function diffGitHeaderPath(line: string): string | undefined {
  const paths = diffGitPaths(line.slice(DIFF_HEADER.length));
  return paths === null ? undefined : (paths.head ?? paths.base);
}

/**
 * The two paths of a header without their `a/` and `b/` prefixes; `head` is null when only one is told apart. Unquoted
 * paths may hold spaces, so the split is the ` b/` that leaves the same path on both sides, else the first one.
 */
function diffGitPaths(rest: string): { base: string; head: string | null } | null {
  let base: string;
  let afterBase: string;
  if (rest.startsWith('"')) {
    const quoted = readQuoted(rest);
    if (quoted === null || !quoted.rest.startsWith(" ")) return null;
    base = quoted.text.replace(/^a\//, "");
    afterBase = quoted.rest.slice(1);
  } else {
    if (!rest.startsWith("a/")) return null;
    const splits = [...rest.matchAll(/ (?="?b\/)/g)].map((match) => match.index);
    const equal = splits.find((at) => unquoteSide(rest.slice(at + 1)) === rest.slice(2, at));
    const at = equal ?? splits[0];
    if (at === undefined) return null;
    base = rest.slice(2, at);
    afterBase = rest.slice(at + 1);
  }
  const head = unquoteSide(afterBase);
  return { base, head: head === "" ? null : head };
}

function unquoteSide(side: string): string {
  const text = side.startsWith('"') ? (readQuoted(side)?.text ?? side) : side;
  return text.replace(/^b\//, "");
}

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** git's C-quoted string at the start of `text` (octal byte escapes read as UTF-8) and what follows it, or null when it is not closed. */
function readQuoted(text: string): { text: string; rest: string } | null {
  if (!text.startsWith('"')) return null;
  const bytes: number[] = [];
  for (let i = 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') return { text: Buffer.from(bytes).toString("utf8"), rest: text.slice(i + 1) };
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }
    const code = SIMPLE_ESCAPES[text[i + 1] ?? ""];
    if (code === undefined) return null;
    bytes.push(code);
    i++;
  }
  return null;
}
