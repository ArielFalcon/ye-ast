import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import type { TreeWatch, TreeWatchListener } from "../core/ports/tree-watch.port.ts";
import { composeCli, composeQueries, type ComposedQueries, type CompositionOptions } from "./compose.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const DIR = "src/main/java/shop/";
const UTIL = "package shop;\n\nclass Util {\n  static String fmt(String s) {\n    return s;\n  }\n}\n";
const caller = (name: string): string => `package shop;\n\nclass ${name} {\n  String run(String s) {\n    return Util.fmt(s);\n  }\n}\n`;
const notCaller = (name: string): string => `package shop;\n\nclass ${name} {\n  String run(String s) {\n    return s;\n  }\n}\n`;
const REPO_ID = "shop";

let workspace: string;
let repo: string;
let scratchRoot: string;
let trustDirectory: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, env: GIT_ENV });
}

async function declareTrust(mode: "trusted" | "untrusted"): Promise<void> {
  assert.equal(await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", mode, repo], { out: () => undefined, err: () => undefined }), EXIT_CODE.ok);
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-watch-"));
  repo = join(workspace, "shop-service");
  scratchRoot = join(workspace, "scratch");
  trustDirectory = join(workspace, "config", "ye-ast");
  mkdirSync(scratchRoot);
  const files: Record<string, string> = { [`${DIR}Util.java`]: UTIL, [`${DIR}First.java`]: caller("First"), [`${DIR}Second.java`]: caller("Second") };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  await declareTrust("trusted");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/** The edit every test makes: `First` stops calling `Util.fmt`, so the callers answer moves. */
const edit = (): void => writeFileSync(join(repo, `${DIR}First.java`), notCaller("First"));

const callersOfFmt = (queries: ComposedQueries) => queries.impact.callers({ repo, repoId: REPO_ID, live: true, targets: [{ file: `${DIR}Util.java`, symbol: "fmt" }] });

/** What a composition that never watched answers over the working tree as it is now. */
const freshCallers = async (): Promise<string> => canonicalJson(await callersOfFmt(composeQueries({ scratchRoot, trustDirectory })));

interface Line {
  event: string;
  stage?: string;
  outcome?: string;
  trigger?: string;
}

/** A composition whose measurement lines are kept; `next` settles on the first later line that matches. */
function measured(options: Partial<CompositionOptions> = {}, onLine: (line: Line) => void = () => undefined) {
  const lines: Line[] = [];
  const waiters: { match: (line: Line) => boolean; settle: (line: Line) => void }[] = [];
  const queries = composeQueries({ scratchRoot, trustDirectory, ...options, measure: (text) => {
    const line = JSON.parse(text).ye_ast as Line;
    lines.push(line);
    onLine(line);
    for (const waiter of waiters.splice(0)) {
      if (waiter.match(line)) waiter.settle(line);
      else waiters.push(waiter);
    }
  } });
  const next = (match: (line: Line) => boolean): Promise<Line> => new Promise((settle) => waiters.push({ match, settle }));
  return { queries, lines, next };
}

const isSettled = (line: Line): boolean => line.event === "watch" && line.outcome === "settled";
const isOff = (line: Line): boolean => line.event === "watch" && line.outcome === "off";
const watchRefreshes = (lines: readonly Line[]): Line[] => lines.filter((line) => line.event === "prime" && line.trigger === "watch");

/** A watcher the test drives: it records each watch and close, and the test fires its events. */
function drivenWatch(): { treeWatch: TreeWatch; opened: { root: string; listener: TreeWatchListener; closed: boolean }[] } {
  const opened: { root: string; listener: TreeWatchListener; closed: boolean }[] = [];
  return {
    opened,
    treeWatch: {
      watch(root, listener) {
        const watched = { root, listener, closed: false };
        opened.push(watched);
        return { close: () => void (watched.closed = true) };
      },
    },
  };
}

const PRIMED_STAGES = ["entrypoints", "relations", "call-sites"];
const derivedStages = (lines: readonly Line[]): string[] => lines.filter(({ event, stage }) => event === "stage" && PRIMED_STAGES.includes(stage ?? "")).map(({ stage }) => stage!);

test("an edit the platform's watcher sees is synced and re-derived with no query: the next query derives none of the facts priming covers and answers the edited tree", { timeout: 120_000 }, async () => {
  const stop = new AbortController();
  const { queries, lines, next } = measured({ signal: stop.signal });
  try {
    assert.equal(await queries.warmLive(repo, stop.signal, REPO_ID), null);
    const before = canonicalJson(await callersOfFmt(queries));
    const settled = next(isSettled);
    edit();
    await settled;
    assert.ok(watchRefreshes(lines).some(({ outcome }) => outcome === "primed"));
    lines.length = 0;
    const answer = canonicalJson(await callersOfFmt(queries));
    assert.deepEqual(derivedStages(lines), []);
    assert.notEqual(answer, before);
    assert.equal(answer, await freshCallers());
  } finally {
    stop.abort();
  }
});

test("with the watcher silent, unable to open or failing, the next query still answers the edited tree, and a failure turns the watcher off with one line", { timeout: 120_000 }, async () => {
  const failingLater = drivenWatch();
  const watchers: Record<string, { treeWatch: TreeWatch; failing: boolean; after?: () => void }> = {
    silent: { treeWatch: { watch: () => ({ close: () => undefined }) }, failing: false },
    "unable to open": { treeWatch: { watch: () => ({ fault: { code: "EMFILE", detail: "too many open files" } }) }, failing: true },
    "failing after it opened": {
      treeWatch: failingLater.treeWatch,
      failing: true,
      after: () => {
        const { listener } = failingLater.opened[0]!;
        listener.failed({ code: "ENOSPC", detail: "watch limit reached" });
        listener.changed(`${DIR}First.java`);
      },
    },
  };
  for (const [name, { treeWatch, failing, after }] of Object.entries(watchers)) {
    const stop = new AbortController();
    const { queries, lines } = measured({ treeWatch });
    try {
      git("checkout", "-q", "--", ".");
      assert.equal(await queries.warmLive(repo, stop.signal, REPO_ID), null, name);
      const before = canonicalJson(await callersOfFmt(queries));
      after?.();
      edit();
      const answer = canonicalJson(await callersOfFmt(queries));
      assert.notEqual(answer, before, name);
      assert.equal(answer, await freshCallers(), name);
      assert.equal(lines.filter(isOff).length, failing ? 1 : 0, name);
      assert.deepEqual(watchRefreshes(lines), [], name);
    } finally {
      stop.abort();
    }
  }
});

test("a burst of changes costs the refresh in flight plus one follow-up, never one refresh per change", { timeout: 120_000 }, async () => {
  const stop = new AbortController();
  const driven = drivenWatch();
  const burst = (): void => {
    for (let index = 0; index < 50; index += 1) driven.opened[0]!.listener.changed(`${DIR}First.java`);
  };
  let duringRefresh = false;
  const { queries, lines, next } = measured({ treeWatch: driven.treeWatch }, (line) => {
    if (!duringRefresh || line.event !== "stage") return;
    duringRefresh = false;
    burst();
  });
  try {
    assert.equal(await queries.warmLive(repo, stop.signal, REPO_ID), null);
    lines.length = 0;
    const settled = next(isSettled);
    duringRefresh = true;
    burst();
    await settled;
    assert.equal(duringRefresh, false);
    assert.deepEqual(watchRefreshes(lines).map(({ outcome }) => outcome), ["primed", "primed"]);
    assert.equal(lines.filter(isSettled).length, 1);
  } finally {
    stop.abort();
  }
});

test("an untrusted repository opens no watcher, and a repository whose trust moves away from trusted closes it at the next change without refreshing", { timeout: 120_000 }, async () => {
  const untrusted = drivenWatch();
  await declareTrust("untrusted");
  assert.equal(await measured({ treeWatch: untrusted.treeWatch }).queries.warmLive(repo, undefined, REPO_ID), null);
  assert.deepEqual(untrusted.opened, []);

  await declareTrust("trusted");
  const stop = new AbortController();
  const moved = drivenWatch();
  const { queries, lines, next } = measured({ treeWatch: moved.treeWatch });
  try {
    assert.equal(await queries.warmLive(repo, stop.signal, REPO_ID), null);
    assert.equal(moved.opened.length, 1);
    await declareTrust("untrusted");
    const off = next(isOff);
    moved.opened[0]!.listener.changed(`${DIR}First.java`);
    await off;
    assert.equal(moved.opened[0]!.closed, true);
    assert.deepEqual(watchRefreshes(lines), []);
  } finally {
    stop.abort();
  }
});

test("the watcher closes when the server stops, through the warming's signal or the composition's", { timeout: 120_000 }, async () => {
  for (const through of ["warming", "composition"] as const) {
    const stop = new AbortController();
    const driven = drivenWatch();
    const { queries } = measured({ treeWatch: driven.treeWatch, ...(through === "composition" ? { signal: stop.signal } : {}) });
    assert.equal(await queries.warmLive(repo, through === "warming" ? stop.signal : undefined, REPO_ID), null, through);
    assert.deepEqual(driven.opened.map(({ root, closed }) => ({ root, closed })), [{ root: repo, closed: false }], through);
    stop.abort();
    assert.equal(driven.opened[0]!.closed, true, through);
  }
});
