import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
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
const HELPERS = 40;

const CONTROLLER = `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestTemplate;

@RestController
@RequestMapping("/orders")
class OrderController {
  private final OrderService service;
  private final RestTemplate rest;

  OrderController(OrderService service, RestTemplate rest) { this.service = service; this.rest = rest; }

  @GetMapping("/{id}")
  String one() {
    rest.getForObject("http://stock/items", String.class);
    return service.find();
  }
}
`;

const SERVICE = "package shop;\n\ninterface OrderService {\n  String find();\n}\n";

const IMPL = `package shop;

import org.springframework.stereotype.Service;

@Service
class OrderServiceImpl implements OrderService {
  public String find() {
    return Util.fmt("x");
  }
}
`;

const UTIL = "package shop;\n\nclass Util {\n  static String fmt(String s) {\n    return s;\n  }\n}\n";

const helper = (index: number): string => `package shop;\n\nclass Helper${index} {\n  String run(String s) {\n    return Util.fmt(s + ${index});\n  }\n}\n`;

let workspace: string;
let repo: string;
let scratchRoot: string;
let trustDirectory: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-priming-"));
  repo = join(workspace, "shop-service");
  scratchRoot = join(workspace, "scratch");
  trustDirectory = join(workspace, "config", "ye-ast");
  mkdirSync(repo);
  mkdirSync(scratchRoot);
  const files: Record<string, string> = { [`${DIR}OrderController.java`]: CONTROLLER, [`${DIR}OrderService.java`]: SERVICE, [`${DIR}OrderServiceImpl.java`]: IMPL, [`${DIR}Util.java`]: UTIL };
  for (let index = 0; index < HELPERS; index += 1) files[`${DIR}Helper${index}.java`] = helper(index);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const installed = await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", "trusted", repo], { out: () => undefined, err: () => undefined });
  assert.equal(installed, EXIT_CODE.ok);
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, env: GIT_ENV });
}

interface Line {
  event: string;
  stage?: string;
  outcome?: string;
  yields?: number;
}

const REPO_ID = "shop";

/** The live questions of every family a first query after launch asks, as an agent asks them. */
const asks = {
  trace: (queries: ComposedQueries) => queries.trace.walk({ repo, repoId: REPO_ID, live: true, targets: [{ file: `${DIR}OrderController.java`, symbol: "OrderController.one" }] }),
  callers: (queries: ComposedQueries) => queries.impact.callers({ repo, repoId: REPO_ID, live: true, targets: [{ file: `${DIR}Util.java`, symbol: "fmt" }] }),
  outline: (queries: ComposedQueries) => queries.outline.outline({ repo, repoId: REPO_ID, live: true, files: [`${DIR}OrderServiceImpl.java`] }),
  map: (queries: ComposedQueries) => queries.entrypoints.map({ repo, repoId: REPO_ID, live: true }),
};

/** The stages that derive a snapshot fact priming covers: each writes its line only when the fact was not found kept. */
const PRIMED_STAGES = ["entrypoints", "relations", "call-sites"];

/** A composition whose measurement lines are kept in `lines`; `onLine` sees each one as it is written. */
function measured(onLine: (line: Line) => void = () => undefined, options: Partial<CompositionOptions> = {}): { queries: ComposedQueries; lines: Line[] } {
  const lines: Line[] = [];
  return { queries: composeQueries({ scratchRoot, trustDirectory, ...options, measure: (text) => {
    const line = JSON.parse(text).ye_ast as Line;
    lines.push(line);
    onLine(line);
  } }), lines };
}

const isRelationsStage = ({ event, stage }: Line): boolean => event === "stage" && stage === "relations";

const derivedStages = (lines: readonly Line[]): string[] => lines.filter(({ event, stage }) => event === "stage" && PRIMED_STAGES.includes(stage ?? "")).map(({ stage }) => stage!);

test("after launch priming, the first live query of each family derives none of the facts priming covers and answers what a fresh composition answers", async () => {
  for (const [name, ask] of Object.entries(asks)) {
    const { queries, lines } = measured();
    assert.equal(await queries.warmLive(repo, undefined, REPO_ID), null);
    assert.deepEqual(lines.filter(({ event }) => event === "prime").map(({ outcome }) => outcome), ["primed"], name);
    lines.length = 0;
    const answer = await ask(queries);
    assert.ok(answer.ok, name);
    assert.deepEqual(derivedStages(lines), [], name);
    assert.equal(canonicalJson(answer), canonicalJson(await ask(composeQueries({ scratchRoot, trustDirectory }))), name);
  }
});

test("a live query that arrives while priming runs is answered before priming ends, and priming waits for it and then finishes", async () => {
  let asked: Promise<unknown> | undefined;
  let answeredFirst = false;
  let primed = false;
  const { queries, lines } = measured((line) => {
    if (asked !== undefined || !isRelationsStage(line)) return;
    asked = asks.trace(queries).then((answer) => {
      answeredFirst = !primed;
      return answer;
    });
  });
  await queries.warmLive(repo, undefined, REPO_ID);
  primed = true;
  const answer = await asked;
  assert.ok(answeredFirst);
  const prime = lines.find(({ event }) => event === "prime");
  assert.equal(prime?.outcome, "primed");
  assert.ok((prime?.yields ?? 0) >= 1);
  assert.equal(canonicalJson(answer), canonicalJson(await asks.trace(composeQueries({ scratchRoot, trustDirectory }))));
});

test("priming aborted while it derives the relations keeps nothing the abort cut: the next query derives them again and answers what a fresh composition answers", async () => {
  const stop = new AbortController();
  const { queries, lines } = measured((line) => {
    if (isRelationsStage(line)) stop.abort();
  });
  assert.equal(await queries.warmLive(repo, stop.signal, REPO_ID), null);
  assert.equal(lines.find(({ event }) => event === "prime")?.outcome, "aborted");
  lines.length = 0;
  const answer = await asks.trace(queries);
  assert.ok(derivedStages(lines).includes("relations"));
  assert.equal(canonicalJson(answer), canonicalJson(await asks.trace(composeQueries({ scratchRoot, trustDirectory }))));
});

const countStage = (lines: readonly Line[], stage: string): number => lines.filter((line) => line.event === "stage" && line.stage === stage).length;

test("a query that arrives as the previous one settles meets no capture of priming: it takes the mirror lock and lists once, and priming still finishes at the state the queries left", async () => {
  let second: Promise<unknown> | undefined;
  let secondQuery: Line[] = [];
  let mark = -1;
  const { queries, lines } = measured((line) => {
    if (mark >= 0 || !isRelationsStage(line)) return;
    mark = Infinity;
    void asks.trace(queries).then(() => {
      mark = lines.length;
      second = asks.callers(queries).then((answer) => {
        secondQuery = lines.slice(mark);
        return answer;
      });
    });
  });
  await queries.warmLive(repo, undefined, REPO_ID);
  const answer = await second;
  assert.equal(countStage(secondQuery, "live-lock"), 1);
  assert.equal(countStage(secondQuery, "live-list"), 1);
  const prime = lines.find(({ event }) => event === "prime");
  assert.equal(prime?.outcome, "primed");
  assert.equal(canonicalJson(answer), canonicalJson(await asks.callers(composeQueries({ scratchRoot, trustDirectory }))));
  lines.length = 0;
  assert.ok((await asks.trace(queries)).ok);
  assert.deepEqual(derivedStages(lines), []);
});

const isPrimingCallSites = ({ event, stage }: Line): boolean => event === "stage" && stage === "call-sites";

test("a query that arrives while priming derives the step of call sites and data effects is answered before that step ends, and priming then finishes it", async () => {
  let asked: Promise<unknown> | undefined;
  const order: string[] = [];
  const { queries, lines } = measured((line) => {
    if (line.event === "stage" && line.stage === "data-effects") order.push("data-effects");
    if (asked !== undefined || !isPrimingCallSites(line)) return;
    asked = asks.outline(queries).then((answer) => {
      order.push("answered");
      return answer;
    });
  });
  assert.equal(await queries.warmLive(repo, undefined, REPO_ID), null);
  const answer = await asked;
  assert.deepEqual(order.slice(0, 2), ["answered", "data-effects"]);
  assert.equal(lines.find(({ event }) => event === "prime")?.outcome, "primed");
  assert.equal(canonicalJson(answer), canonicalJson(await asks.outline(composeQueries({ scratchRoot, trustDirectory }))));
  lines.length = 0;
  assert.ok((await asks.trace(queries)).ok);
  assert.deepEqual(derivedStages(lines), []);
});

test("priming aborted while a query holds its turn inside a step keeps nothing that step cut: the next query derives the data effects again and answers what a fresh composition answers", async () => {
  const stop = new AbortController();
  let asked: Promise<unknown> | undefined;
  const { queries, lines } = measured((line) => {
    if (asked !== undefined || !isPrimingCallSites(line)) return;
    asked = asks.outline(queries);
    stop.abort();
  });
  assert.equal(await queries.warmLive(repo, stop.signal, REPO_ID), null);
  await asked;
  assert.equal(lines.find(({ event }) => event === "prime")?.outcome, "aborted");
  lines.length = 0;
  const answer = await asks.trace(queries);
  assert.ok(lines.some(({ event, stage }) => event === "stage" && stage === "data-effects"));
  assert.equal(canonicalJson(answer), canonicalJson(await asks.trace(composeQueries({ scratchRoot, trustDirectory }))));
});

test("a step that waited for a query which moved the tree runs again on the state the query left: the next query derives no call sites", async () => {
  let asked: Promise<unknown> | undefined;
  const silent = { watch: () => ({ close: () => undefined }) };
  const { queries, lines } = measured((line) => {
    if (asked !== undefined || !isPrimingCallSites(line)) return;
    writeFileSync(join(repo, `${DIR}Helper0.java`), helper(1000));
    asked = asks.outline(queries);
  }, { treeWatch: silent });
  assert.equal(await queries.warmLive(repo, undefined, REPO_ID), null);
  await asked;
  assert.equal(lines.find(({ event }) => event === "prime")?.outcome, "primed");
  lines.length = 0;
  const answer = await asks.trace(queries);
  assert.equal(countStage(lines, "call-sites"), 0);
  assert.equal(canonicalJson(answer), canonicalJson(await asks.trace(composeQueries({ scratchRoot, trustDirectory }))));
});
