import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { EntrypointMapFact } from "../core/domain/map/entrypoint-map.ts";
import { SCHEMA, type Fact } from "../core/domain/shared/fact.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointQueries, MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactCallersRequest, ImpactFault, ImpactImportersRequest, ImpactOfChangeRequest, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { OutlineFault, OutlineQueries, OutlineRequest } from "../core/ports/outline-queries.port.ts";
import type { TraceFault, TraceQueries, TraceRequest } from "../core/ports/trace-queries.port.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { FactRead, WorkspaceQueries, WorkspaceRequest, WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import type { WorkspaceFault } from "../core/ports/workspace-repos.port.ts";
import type { DecisionQueries, DecisionsRequest, DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { ChangeRequest, ConsequencesFault, ContractConsequencesQueries, HypothesesRequest } from "../core/ports/contract-consequences-queries.port.ts";
import type { ConsequencesValue } from "../core/domain/contracts/consequence-fact.ts";
import type { OutlineValue } from "../core/domain/outline/outline-fact.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import type { VcsFault } from "../core/ports/vcs.port.ts";
import type { LiveFault } from "../core/ports/live-queries.port.ts";
import type { Install, InstallFault, InstallOutcome, InstallRequest, BatchInstallRequest, BatchInstallReport } from "../core/ports/install.port.ts";
import { EXIT_CODE, run, type CliDeps, type CliIo } from "./main.ts";

const VERSION = "1.2.3";

const BASE = {
  schema: SCHEMA,
  snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) },
  producer: { name: "ye-ast", version: VERSION },
  inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
  evidence: [],
} as const;

const MAP: EntrypointMapFact = {
  ...BASE,
  status: "complete",
  value: { entrypoints: { ...BASE, status: "complete", value: [] } },
};

const SECRET = "s3cr3t";

/** Takes out `SECRET` wherever it stands, so a test sees which strings went through redaction. */
const redaction: Redaction = {
  redact: (text) => text.replaceAll(SECRET, REDACTED),
  redactValue: (value) => JSON.parse(JSON.stringify(value).replaceAll(SECRET, REDACTED)),
  detect: () => ({ redacted: false, patterns: [], count: 0 }),
  redactError: (error) => String(error instanceof Error ? error.message : error).replaceAll(SECRET, REDACTED),
  containsSecret: (text) => text.includes(SECRET),
};

function recordingIo(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
}

function setup(answer: Result<EntrypointMapFact, VcsFault | LiveFault> = { ok: true, value: MAP }) {
  const requests: MapRequest[] = [];
  const signal = new AbortController().signal;
  const entrypoints: EntrypointQueries = {
    map: async (request) => {
      requests.push(request);
      return answer;
    },
  };
  const impact: ImpactQueries = {
    ofChange: async () => {
      throw new Error("not reached");
    },
    callers: async () => {
      throw new Error("not reached");
    },
    importers: async () => {
      throw new Error("not reached");
    },
  };
  const installs: InstallRequest[] = [];
  const install: Install = {
    runBatch: async () => { throw new Error("not reached"); },
    run: async (request) => {
      installs.push(request);
      return { ok: true, value: INSTALLED };
    },
  };
  const unanswered: Result<never, { kind: "git-failed"; detail: string }> = { ok: false, fault: { kind: "git-failed", detail: "not exercised" } };
  return {
    requests,
    installs,
    signal,
    io: recordingIo(),
    deps: {
      version: VERSION,
      entrypoints,
      impact,
      outline: { outline: async () => unanswered } as OutlineQueries,
      trace: { walk: async () => unanswered } as TraceQueries,
      workspace: { outwardNames: async () => unanswered } as WorkspaceQueries,
      decisions: { decisions: async () => unanswered } as DecisionQueries,
      contractConsequences: { ofHypotheses: async () => unanswered, ofChange: async () => unanswered } as unknown as ContractConsequencesQueries,
      install,
      mcpCommand: ["npx", "--yes", "tsx", MCP_ENTRYPOINT],
      redaction,
      canonicalRepositoryRoot: async (path: string): Promise<Result<string, VcsFault>> => ({ ok: true, value: path }),
      repositoryName: async (repo: string): Promise<Result<string, VcsFault>> => ({ ok: true, value: basename(repo) }),
      signal,
    },
  };
}

const MCP_ENTRYPOINT = "/opt/ye-ast/src/composition/main.ts";
const INSTALLED: InstallOutcome = { trust: "untrusted", excluded: [".ye-ast/", ".ye-ast-graph/"], layer: { outcome: "written", files: ["README.md", "entrypoints.json"] } };

function setupInstall(answer: Result<InstallOutcome, InstallFault> = { ok: true, value: INSTALLED }) {
  const base = setup();
  const install: Install = {
    runBatch: async () => { throw new Error("not reached"); },
    run: async (request) => {
      base.installs.push(request);
      return answer;
    },
  };
  return { ...base, deps: { ...base.deps, install } };
}

const IMPACT: Fact<ImpactValue> = {
  ...BASE,
  status: "complete",
  value: { mergeBase: "b".repeat(40), seeds: [], changedEntrypoints: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } },
};

function setupImpact(answer: Result<Fact<ImpactValue>, VcsFault | LiveFault> = { ok: true, value: IMPACT }) {
  const base = setup();
  const requests: ImpactOfChangeRequest[] = [];
  const impact: ImpactQueries = {
    ...base.deps.impact,
    ofChange: async (request) => {
      requests.push(request);
      return answer;
    },
  };
  return { ...base, requests, deps: { ...base.deps, impact } };
}

const IMPORTERS: Fact<ImportersValue> = { ...BASE, status: "complete", value: { files: [] } };

function setupCallers(answer: Result<Fact<ImpactValue>, ImpactFault> = { ok: true, value: IMPACT }) {
  const base = setup();
  const requests: ImpactCallersRequest[] = [];
  const impact: ImpactQueries = {
    ...base.deps.impact,
    callers: async (request) => {
      requests.push(request);
      return answer;
    },
  };
  return { ...base, requests, deps: { ...base.deps, impact } };
}

const OUTLINE_VALUE: OutlineValue = { files: [{ file: "src/A.java", declarations: [{ kind: "method", name: "run", line: 3, endLine: 9 }], imports: [] }], unheld: [] };

function setupOutline(answer?: Result<Fact<OutlineValue>, OutlineFault>) {
  const base = setup();
  const requests: OutlineRequest[] = [];
  const outline: OutlineQueries = {
    outline: async (request) => {
      requests.push(request);
      return answer ?? ({ ok: true, value: { ...IMPACT, status: "complete", value: OUTLINE_VALUE } as Fact<OutlineValue> } as const);
    },
  };
  return { ...base, requests, deps: { ...base.deps, outline } };
}

const TRACE_VALUE: TraceValue = { roots: [{ target: "src/A.java:run", steps: [0] }], steps: [{ id: 0, depth: 0, file: "src/A.java", symbol: "run", kind: "method", line: 3, endLine: 9 }], readingPlan: { ranges: [{ file: "src/A.java", start: 3, end: 9, steps: [0] }], lines: 7 }, cost: { expanded: 1 } };

function setupTrace(answer?: Result<Fact<TraceValue>, TraceFault>) {
  const base = setup();
  const requests: TraceRequest[] = [];
  const trace: TraceQueries = {
    walk: async (request) => {
      requests.push(request);
      return answer ?? ({ ok: true, value: { ...IMPACT, status: "complete", value: TRACE_VALUE } as Fact<TraceValue> } as const);
    },
  };
  return { ...base, requests, deps: { ...base.deps, trace } };
}

const WORKSPACE_VALUE: WorkspaceValue = {
  workspace: { repos: ["shop"], gateways: [], source: "none" },
  repositorySnapshots: [],
  sections: {},
  links: [],
  unlinked: [],
  candidates: [],
  unserved: [],
  repositories: [],
};

const WORKSPACE_READ: FactRead<WorkspaceValue> = { fact: { ...BASE, status: "complete", value: WORKSPACE_VALUE } };

function setupWorkspace(answer?: Result<FactRead<WorkspaceValue>, WorkspaceFault>) {
  const base = setup();
  const requests: WorkspaceRequest[] = [];
  const workspace: WorkspaceQueries = {
    outwardNames: async (request) => {
      requests.push(request);
      return answer ?? { ok: true, value: WORKSPACE_READ };
    },
  };
  return { ...base, requests, deps: { ...base.deps, workspace } };
}

const DECISIONS_VALUE: DecisionValue = { decisions: [], repositories: [], source: "none", unresolved: [] };

const DECISIONS_READ: FactRead<DecisionValue> = { fact: { ...BASE, status: "complete", value: DECISIONS_VALUE } };

function setupDecisions(answer?: Result<FactRead<DecisionValue>, WorkspaceFault>) {
  const base = setup();
  const requests: DecisionsRequest[] = [];
  const decisions: DecisionQueries = {
    decisions: async (request) => {
      requests.push(request);
      return answer ?? { ok: true, value: DECISIONS_READ };
    },
  };
  return { ...base, requests, deps: { ...base.deps, decisions } };
}

const CONSEQUENCES_FACT: Fact<ConsequencesValue> = { ...BASE, status: "complete", value: { repositorySnapshots: [], answers: [] } };

function setupConsequences(answer: Result<Fact<ConsequencesValue>, ConsequencesFault> = { ok: true, value: CONSEQUENCES_FACT }) {
  const base = setup();
  const requests: (HypothesesRequest | ChangeRequest)[] = [];
  const contractConsequences: ContractConsequencesQueries = {
    ofHypotheses: async (request) => (requests.push(request), answer),
    ofChange: async (request) => (requests.push(request), answer),
  };
  return { ...base, requests, deps: { ...base.deps, contractConsequences } };
}

const HYPOTHESIS = { method: "GET", path: "/owners/{id}", target: "response", property: "name", change: "nullable" };

function setupImporters(answer: Result<Fact<ImportersValue>, VcsFault | LiveFault> = { ok: true, value: IMPORTERS }) {
  const base = setup();
  const requests: ImpactImportersRequest[] = [];
  const impact: ImpactQueries = {
    ...base.deps.impact,
    importers: async (request) => {
      requests.push(request);
      return answer;
    },
  };
  return { ...base, requests, deps: { ...base.deps, impact } };
}

test("--version prints the injected version on stdout and exits ok", async () => {
  const { io, deps } = setup();
  assert.equal(await run(["--version"], io, deps), EXIT_CODE.ok);
  assert.deepEqual(io.stdout, [VERSION]);
  assert.deepEqual(io.stderr, []);
});

test("an unknown command prints the usage on stderr and exits with the usage code", async () => {
  const { io, deps, requests } = setup();
  assert.equal(await run(["bogus"], io, deps), EXIT_CODE.usage);
  assert.deepEqual(io.stdout, []);
  assert.equal(io.stderr.length, 1);
  assert.deepEqual(requests, []);
});

test("map prints the fact of the injected query family as JSON and exits ok", async () => {
  const { io, deps } = setup();
  assert.equal(await run(["map", "."], io, deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(io.stdout.join("\n")), MAP);
  assert.deepEqual(io.stderr, []);
});

test("--measure is accepted by a query and leaves stdout carrying only the fact", async () => {
  const { io, deps } = setup();
  assert.equal(await run(["map", "--measure", "."], io, deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(io.stdout.join("\n")), MAP);
  assert.deepEqual(io.stderr, []);
});

test("map defaults the revision to HEAD and the repository id to the name git states for it, and honours both flags", async () => {
  const defaults = setup();
  await run(["map", "some/checkout"], defaults.io, defaults.deps);
  assert.deepEqual(defaults.requests, [
    { repo: resolve("some/checkout"), repoId: basename("some/checkout"), revision: "HEAD", signal: defaults.signal },
  ]);

  const flagged = setup();
  await run(["map", "--revision", "release/1", "--repo-id", "shop", "some/checkout"], flagged.io, flagged.deps);
  assert.deepEqual(flagged.requests, [
    { repo: resolve("some/checkout"), repoId: "shop", revision: "release/1", signal: flagged.signal },
  ]);
});

test("a worktree is bound to the name of the repository that holds it, not to its own directory name", async () => {
  const base = setup();
  const deps = { ...base.deps, repositoryName: async (): Promise<Result<string, VcsFault>> => ({ ok: true, value: "shop-service" }) };

  await run(["map", "some/checkout-fix-121"], base.io, deps);

  assert.equal(base.requests[0]?.repoId, "shop-service");
});

test("a repository git cannot name keeps the directory name, so the query answers its own fault", async () => {
  const base = setup();
  const deps = { ...base.deps, repositoryName: async (): Promise<Result<string, VcsFault>> => ({ ok: false, fault: { kind: "not-repository-root", detail: "inside" } }) };

  await run(["map", "some/checkout"], base.io, deps);

  assert.equal(base.requests[0]?.repoId, basename("some/checkout"));
});

test("a failed query writes to stderr only and exits with the query code", async () => {
  const { io, deps } = setup({ ok: false, fault: { kind: "unknown-revision", detail: "nope" } });
  assert.equal(await run(["map", "."], io, deps), EXIT_CODE.queryFailed);
  assert.deepEqual(io.stdout, []);
  assert.equal(io.stderr.length, 1);
});

test("map without a repository, with two, or with an unknown flag is a usage error", async () => {
  for (const argv of [["map"], ["map", "a", "b"], ["map", "--bogus", "a"]]) {
    const { io, deps, requests } = setup();
    assert.equal(await run(argv, io, deps), EXIT_CODE.usage, argv.join(" "));
    assert.deepEqual(io.stdout, []);
    assert.deepEqual(requests, []);
  }
});

test("a query aborted by the caller exits with the interrupted code and prints no fact", async () => {
  const { io, deps } = setup({ ok: false, fault: { kind: "aborted", detail: "interrupted by the caller" } });
  assert.equal(await run(["map", "."], io, deps), EXIT_CODE.interrupted);
  assert.deepEqual(io.stdout, []);
  assert.equal(io.stderr.length, 1);
});

test("an unexpected fault exits with the internal-fault code, with one line on stderr", async () => {
  const { io, deps } = setup();
  deps.entrypoints = {
    map: async () => {
      throw new TypeError("line one\nline two");
    },
  };
  const code = await run(["map", "."], io, deps);

  assert.equal(code, EXIT_CODE.internalFault);
  assert.deepEqual(io.stdout, []);
  assert.equal(io.stderr.length, 1);
  assert.equal(io.stderr[0]?.includes("\n"), false);
});

test("map redacts every string of the fact it prints, keys included, and keeps the JSON shape", async () => {
  const route = { kind: "http-route", name: `GET /hook/${SECRET}`, method: "GET", path: `/hook/${SECRET}`, line: 7 };
  const profiles = { [`${SECRET}-profile`]: { contextPath: `/${SECRET}` } };
  const fact = { ...MAP, value: { entrypoints: { ...BASE, status: "complete", value: [{ status: "complete", value: route, profiles }] } } };
  const { io, deps } = setup({ ok: true, value: fact as unknown as EntrypointMapFact });

  assert.equal(await run(["map", "."], io, deps), EXIT_CODE.ok);

  const printed = io.stdout.join("\n");
  assert.equal(printed.includes(SECRET), false);
  const item = JSON.parse(printed).value.entrypoints.value[0];
  assert.deepEqual(item.value, { kind: "http-route", name: `GET /hook/${REDACTED}`, method: "GET", path: `/hook/${REDACTED}`, line: 7 });
  assert.deepEqual(item.profiles, { [`${REDACTED}-profile`]: { contextPath: `/${REDACTED}` } });
});

test("a query fault and an internal fault are redacted before they reach stderr", async () => {
  const failed = setup({ ok: false, fault: { kind: "unknown-revision", detail: `no ${SECRET}` } });
  assert.equal(await run(["map", "."], failed.io, failed.deps), EXIT_CODE.queryFailed);

  const thrown = setup();
  thrown.deps.entrypoints = {
    map: async () => {
      throw new Error(`clone of ${SECRET} failed`);
    },
  };
  assert.equal(await run(["map", "."], thrown.io, thrown.deps), EXIT_CODE.internalFault);

  for (const stderr of [failed.io.stderr, thrown.io.stderr]) {
    assert.equal(stderr.length, 1);
    assert.equal(stderr[0]?.includes(SECRET), false);
    assert.equal(stderr[0]?.includes(REDACTED), true);
  }
});

test("impact prints the fact of the injected family as JSON, with the head defaulting to HEAD and the repository id to the directory name", async () => {
  const { io, deps, requests } = setupImpact();
  assert.equal(await run(["impact", "--base", "main", "some/checkout"], io, deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(io.stdout.join("\n")), IMPACT);
  assert.deepEqual(requests, [{ repo: resolve("some/checkout"), repoId: "checkout", base: "main", head: "HEAD", signal: deps.signal }]);
});

test("impact honours --head and --repo-id", async () => {
  const { io, deps, requests } = setupImpact();
  await run(["impact", "--base", "main", "--head", "feature", "--repo-id", "shop", "."], io, deps);
  assert.deepEqual([requests[0]?.head, requests[0]?.repoId], ["feature", "shop"]);
});

test("impact without --base, with no repository or with two is a usage error that asks nothing", async () => {
  for (const argv of [["impact", "."], ["impact", "--base", "main"], ["impact", "--base", "main", "a", "b"], ["impact", "--bogus", "--base", "main", "."]]) {
    const { io, deps, requests } = setupImpact();
    assert.equal(await run(argv, io, deps), EXIT_CODE.usage, argv.join(" "));
    assert.deepEqual(requests, []);
    assert.deepEqual(io.stdout, []);
  }
});

test("impact redacts every string of the fact and a fault's detail, and answers with the query and interrupted codes", async () => {
  const leaking = { ...IMPACT, value: { ...IMPACT.value, mergeBase: SECRET } } as Fact<ImpactValue>;
  const printed = setupImpact({ ok: true, value: leaking });
  assert.equal(await run(["impact", "--base", "main", "."], printed.io, printed.deps), EXIT_CODE.ok);
  assert.equal(printed.io.stdout.join("\n").includes(SECRET), false);

  const failed = setupImpact({ ok: false, fault: { kind: "no-merge-base", detail: `no history ${SECRET}` } });
  assert.equal(await run(["impact", "--base", "main", "."], failed.io, failed.deps), EXIT_CODE.queryFailed);
  assert.equal(failed.io.stderr.join("\n").includes(SECRET), false);

  const aborted = setupImpact({ ok: false, fault: { kind: "aborted", detail: "stop" } });
  assert.equal(await run(["impact", "--base", "main", "."], aborted.io, aborted.deps), EXIT_CODE.interrupted);
});

test("impact passes the budget flags it is given, as positive integers, and none when it is given none", async () => {
  const { io, deps, requests } = setupImpact();
  await run(["impact", "--base", "main", "--depth", "3", "--hub-fan-in", "40", "--expansions", "500", "."], io, deps);
  assert.deepEqual(requests[0]?.budget, { depth: 3, hubFanIn: 40, expansions: 500 });
  const partial = setupImpact();
  await run(["impact", "--base", "main", "--expansions", "7", "."], partial.io, partial.deps);
  assert.deepEqual(partial.requests[0]?.budget, { expansions: 7 });
});

test("a budget flag that is not a positive integer is a usage error on impact and callers", async () => {
  for (const value of ["0", "-1", "1.5", "abc", "", "9007199254740993"]) {
    const impact = setupImpact();
    assert.equal(await run(["impact", "--base", "main", "--depth", value, "."], impact.io, impact.deps), EXIT_CODE.usage, value);
    assert.deepEqual(impact.requests, []);
    const callers = setupCallers();
    assert.equal(await run(["callers", ".", "--hub-fan-in", value, "A.java:f"], callers.io, callers.deps), EXIT_CODE.usage, value);
    assert.deepEqual(callers.requests, []);
  }
});

test("callers asks for symbols and line ranges, defaults the revision to HEAD and the repository id to the directory name, and honours both flags and the budget", async () => {
  const defaults = setupCallers();
  assert.equal(await run(["callers", "some/checkout", "src/A.java:load", "src/B.java:12-30"], defaults.io, defaults.deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(defaults.io.stdout.join("\n")), IMPACT);
  assert.deepEqual(defaults.requests, [
    { repo: resolve("some/checkout"), repoId: "checkout", revision: "HEAD", targets: [{ file: "src/A.java", symbol: "load" }, { file: "src/B.java", start: 12, end: 30 }], signal: defaults.signal },
  ]);
  const flagged = setupCallers();
  await run(["callers", "--revision", "v1", "--repo-id", "shop", "--depth", "2", ".", "src/C.java:7-7"], flagged.io, flagged.deps);
  assert.deepEqual(flagged.requests[0], { repo: resolve("."), repoId: "shop", revision: "v1", targets: [{ file: "src/C.java", start: 7, end: 7 }], budget: { depth: 2 }, signal: flagged.signal });
});

test("a callers target that is neither file:symbol nor file:start-end with 1 <= start <= end is a usage error that asks nothing", async () => {
  const bad = [[], ["A.java"], ["A.java:"], [":load"], ["A.java:0-3"], ["A.java:5-2"], ["A.java:3-"], ["A.java:3-x"], ["A.java:12"], ["A.java:load", "B.java:1.5-3"]];
  for (const targets of bad) {
    const { io, deps, requests } = setupCallers();
    assert.equal(await run(["callers", ".", ...targets], io, deps), EXIT_CODE.usage, targets.join(" "));
    assert.deepEqual(requests, []);
    assert.deepEqual(io.stdout, []);
  }
  const noRepository = setupCallers();
  assert.equal(await run(["callers"], noRepository.io, noRepository.deps), EXIT_CODE.usage);
});

test("callers answers an unknown symbol with the query code, one line per entry on stderr naming what the file declares, and nothing on stdout", async () => {
  const { io, deps } = setupCallers({
    ok: false,
    fault: {
      kind: "unknown-symbol",
      detail: "no symbol at the revision for A.java:gone",
      entries: [
        { file: "A.java", symbol: "gone", absent: false, candidates: ["load", "save"] },
        { file: "B.java", symbol: "gone", absent: false, candidates: [] },
        { file: "src/C.java", symbol: "gone", absent: true, candidates: ["C.java"] },
      ],
    },
  });
  assert.equal(await run(["callers", ".", "A.java:gone"], io, deps), EXIT_CODE.queryFailed);
  assert.deepEqual(io.stdout, []);
  assert.deepEqual(io.stderr, [
    "ye-ast: unknown-symbol: no symbol at the revision for A.java:gone",
    "  - A.java:gone: declared in A.java: load, save",
    "  - B.java:gone: B.java declares no symbol",
    "  - src/C.java:gone: src/C.java is not in the snapshot; snapshot paths: C.java",
  ]);
});

test("trace answers an entrypoint the map does not hold with the names of that kind on stderr, the one shared sentence", async () => {
  const { io, deps } = setupTrace({ ok: false, fault: { kind: "unknown-entrypoint", detail: "no entrypoint", entries: [{ kind: "http-route", name: "POST /orders", candidates: ["GET /orders"] }, { kind: "ui-route", name: "/x", candidates: [] }] } });
  assert.equal(await run(["trace", ".", "--entrypoint", "http-route:POST /orders"], io, deps), EXIT_CODE.queryFailed);
  assert.deepEqual(io.stdout, []);
  assert.deepEqual(io.stderr.slice(1), ["  - http-route:POST /orders: the map's http-route names: GET /orders", "  - ui-route:/x: the map holds no ui-route"]);
});

test("trace asks for symbols and line ranges with the depth and expansions bounds and prints the fact", async () => {
  const { io, deps, requests, signal } = setupTrace();
  assert.equal(await run(["trace", "--revision", "v1", "--depth", "2", "--expansions", "9", "some/checkout", "src/A.java:run", "src/B.java:4-8"], io, deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(io.stdout.join("\n")).value, TRACE_VALUE);
  assert.deepEqual(requests, [
    { repo: resolve("some/checkout"), repoId: "checkout", revision: "v1", targets: [{ file: "src/A.java", symbol: "run" }, { file: "src/B.java", start: 4, end: 8 }], budget: { depth: 2, expansions: 9 }, signal },
  ]);
});

test("trace with a caller-count bound, with --live and --revision together, or without a target is a usage error that asks nothing", async () => {
  for (const argv of [["trace", "--hub-fan-in", "2", ".", "A.java:run"], ["trace", "--live", "--revision", "v1", ".", "A.java:run"], ["trace", "."]]) {
    const { io, deps, requests } = setupTrace();
    assert.equal(await run(argv, io, deps), EXIT_CODE.usage, argv.join(" "));
    assert.deepEqual(requests, []);
  }
});

test("trace --live asks for the working tree instead of a revision", async () => {
  const { io, deps, requests } = setupTrace();
  await run(["trace", "--live", ".", "A.java:run"], io, deps);
  assert.deepEqual([requests[0]?.live, requests[0]?.revision], [true, undefined]);
});

test("trace answers an unknown symbol or a range that selects nothing with the query code and nothing on stdout", async () => {
  const { io, deps } = setupTrace({ ok: false, fault: { kind: "unknown-symbol", detail: "no symbol at the revision for A.java:gone, A.java:90-95", entries: [{ file: "A.java", symbol: "gone", absent: false, candidates: ["run"] }, { file: "A.java", start: 90, end: 95, absent: false, candidates: ["run"] }] } });
  assert.equal(await run(["trace", ".", "A.java:gone", "A.java:90-95"], io, deps), EXIT_CODE.queryFailed);
  assert.deepEqual(io.stdout, []);
  assert.deepEqual(io.stderr.slice(1), ["  - A.java:gone: declared in A.java: run", "  - A.java:90-95: declared in A.java: run"]);
});

test("importers asks for the files at the revision and prints the fact", async () => {
  const defaults = setupImporters();
  assert.equal(await run(["importers", "some/checkout", "src/A.java", "src/B.java"], defaults.io, defaults.deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(defaults.io.stdout.join("\n")), IMPORTERS);
  assert.deepEqual(defaults.requests, [{ repo: resolve("some/checkout"), repoId: "checkout", revision: "HEAD", files: ["src/A.java", "src/B.java"], signal: defaults.signal }]);
  const flagged = setupImporters();
  await run(["importers", "--revision", "v1", "--repo-id", "shop", ".", "src/A.java"], flagged.io, flagged.deps);
  assert.deepEqual([flagged.requests[0]?.revision, flagged.requests[0]?.repoId], ["v1", "shop"]);
});

test("outline asks for the files at the revision and prints the fact", async () => {
  const defaults = setupOutline();
  assert.equal(await run(["outline", "some/checkout", "src/A.java", "src/B.java"], defaults.io, defaults.deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(defaults.io.stdout.join("\n")), { ...IMPACT, status: "complete", value: OUTLINE_VALUE });
  assert.deepEqual(defaults.requests, [{ repo: resolve("some/checkout"), repoId: "checkout", revision: "HEAD", files: ["src/A.java", "src/B.java"], signal: defaults.signal }]);
  const flagged = setupOutline();
  await run(["outline", "--revision", "v1", "--repo-id", "shop", ".", "src/A.java"], flagged.io, flagged.deps);
  assert.deepEqual([flagged.requests[0]?.revision, flagged.requests[0]?.repoId], ["v1", "shop"]);
});

test("outline without a repository or without files is a usage error", async () => {
  for (const argv of [["outline"], ["outline", "."]]) {
    const { io, deps, requests } = setupOutline();
    assert.equal(await run(argv, io, deps), EXIT_CODE.usage, argv.join(" "));
    assert.deepEqual(requests, []);
  }
});

test("outline --focus asks for each selector, a dotted name or a line, instead of files", async () => {
  const { io, deps, requests, signal } = setupOutline();
  assert.equal(await run(["outline", "--focus", "src/A.ts:Api.get", "--focus", "src/A.ts:97", "some/checkout"], io, deps), EXIT_CODE.ok);
  assert.deepEqual(requests, [{ repo: resolve("some/checkout"), repoId: "checkout", revision: "HEAD", focus: [{ file: "src/A.ts", symbol: "Api.get" }, { file: "src/A.ts", line: 97 }], signal }]);
});

test("outline with both focus and files, or a focus line that is not a positive integer, is a usage error", async () => {
  for (const argv of [["outline", "--focus", "src/A.ts:Api", ".", "src/A.ts"], ["outline", "--focus", "src/A.ts:0", "."], ["outline", "--focus", "src/A.ts:9x", "."]]) {
    const { io, deps, requests } = setupOutline();
    assert.equal(await run(argv, io, deps), EXIT_CODE.usage, argv.join(" "));
    assert.deepEqual(requests, []);
  }
});

test("outline answers a top-level line with the query code, one line per entry on stderr naming the file's dotted paths", async () => {
  const { io, deps } = setupOutline({ ok: false, fault: { kind: "top-level-line", detail: "no declaration holds A.ts:1", entries: [{ file: "A.ts", line: 1, candidates: ["Api", "Api.get"] }] } });
  assert.equal(await run(["outline", "--focus", "A.ts:1", "."], io, deps), EXIT_CODE.queryFailed);
  assert.deepEqual(io.stderr, ["ye-ast: top-level-line: no declaration holds A.ts:1", "  - A.ts:1: declared in A.ts: Api, Api.get"]);
});

test("workspace asks for the bound repository at the revision and prints the fact", async () => {
  const defaults = setupWorkspace();
  assert.equal(await run(["workspace", "some/checkout"], defaults.io, defaults.deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(defaults.io.stdout.join("\n")), WORKSPACE_READ);
  assert.deepEqual(defaults.requests, [{ repo: { path: resolve("some/checkout"), id: "checkout", revision: "HEAD" }, signal: defaults.signal }]);

  const flagged = setupWorkspace();
  await run(["workspace", "--revision", "v1", "--repo-id", "shop", "--offline", "--include", "svc/**", "."], flagged.io, flagged.deps);
  assert.deepEqual(flagged.requests, [{ repo: { path: resolve("."), id: "shop", revision: "v1" }, scope: { include: ["svc/**"] }, offline: true, signal: flagged.signal }]);
});

test("decisions asks for the same workspace the outward names do and prints the fact", async () => {
  const defaults = setupDecisions();
  assert.equal(await run(["decisions", "some/checkout"], defaults.io, defaults.deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(defaults.io.stdout.join("\n")), DECISIONS_READ);
  assert.deepEqual(defaults.requests, [{ repo: { path: resolve("some/checkout"), id: "checkout", revision: "HEAD" }, signal: defaults.signal }]);
});

/** A command line the CLI refuses before it asks any family: a usage code, and nothing on the wire. */
async function refuses(argv: readonly string[], family: () => { io: ReturnType<typeof recordingIo>; deps: CliDeps; requests: readonly unknown[] }): Promise<void> {
  const { io, deps, requests } = family();
  assert.equal(await run(argv, io, deps), EXIT_CODE.usage, argv.join(" "));
  assert.deepEqual(requests, [], argv.join(" "));
  assert.deepEqual(io.stdout, [], argv.join(" "));
}

test("workspace and decisions without a repository, with two, or with a flag they do not take are a usage error", async () => {
  for (const command of ["workspace", "decisions"]) {
    const accepted = command === "workspace" ? setupWorkspace() : setupDecisions();
    assert.equal(await run([command, "."], accepted.io, accepted.deps), EXIT_CODE.ok, `${command}: the command itself is accepted`);
    for (const tail of [[], ["a", "b"], ["--bogus", "."], ["--live", "."], ["--repo", "other", "."], ["--depth", "2", "."]]) {
      await refuses([command, ...tail], command === "workspace" ? setupWorkspace : setupDecisions);
    }
  }
});

test("the usage names the workspace and decisions commands, and the scope help names both", async () => {
  const { io, deps } = setup();

  assert.equal(await run(["--help"], io, deps), EXIT_CODE.ok);

  const help = io.stdout.join("\n");
  assert.match(help, /ye-ast workspace \[--revision <rev>\] \[--repo-id <id>\] \[--offline\] \[scope\] <repo>/);
  assert.match(help, /ye-ast decisions \[--revision <rev>\] \[--repo-id <id>\] \[--offline\] \[scope\] <repo>/);
  assert.match(help, /importers, outline, trace, workspace, decisions and contract-consequences/);
  assert.match(help, /--offline:/);
  assert.match(help, /--changed <glob>/);
});

test("importers without a repository, without files, or with a budget flag is a usage error", async () => {
  for (const argv of [["importers"], ["importers", "."], ["importers", "--depth", "2", ".", "A.java"], ["importers", "--bogus", ".", "A.java"]]) {
    const { io, deps, requests } = setupImporters();
    assert.equal(await run(argv, io, deps), EXIT_CODE.usage, argv.join(" "));
    assert.deepEqual(requests, []);
    assert.deepEqual(io.stdout, []);
  }
});

test("--include and --exclude, repeatable, reach the scope of map, impact, callers and importers, and none given leaves the scope out", async () => {
  const scope = ["--include", "svc/**", "--include", "lib/**", "--exclude", "svc/static/**"];
  const expected = { include: ["svc/**", "lib/**"], exclude: ["svc/static/**"] };

  const map = setup();
  await run(["map", ...scope, "."], map.io, map.deps);
  const impact = setupImpact();
  await run(["impact", "--base", "main", ...scope, "."], impact.io, impact.deps);
  const callers = setupCallers();
  await run(["callers", ...scope, ".", "src/A.java:f"], callers.io, callers.deps);
  const importers = setupImporters();
  await run(["importers", ...scope, ".", "src/A.java"], importers.io, importers.deps);

  assert.deepEqual([map, impact, callers, importers].map(({ requests }) => requests[0]?.scope), [expected, expected, expected, expected]);
  const bare = setup();
  await run(["map", "."], bare.io, bare.deps);
  assert.equal("scope" in bare.requests[0]!, false);
  const onlyExclude = setup();
  await run(["map", "--exclude", "gen/**", "."], onlyExclude.io, onlyExclude.deps);
  assert.deepEqual(onlyExclude.requests[0]?.scope, { exclude: ["gen/**"] });
});

test("--changed, repeatable, reaches the change selection, and none given leaves it out", async () => {
  const selected = setupImpact();
  await run(["impact", "--base", "main", "--changed", "src/a/**", "--changed", "src/b/**", "."], selected.io, selected.deps);
  assert.deepEqual(selected.requests[0]?.changed, ["src/a/**", "src/b/**"]);

  const bare = setupImpact();
  await run(["impact", "--base", "main", "."], bare.io, bare.deps);
  assert.equal("changed" in bare.requests[0]!, false);
});

test("an invalid changed glob is a usage error that asks nothing", async () => {
  for (const glob of ["", "./x/**", "../x"]) {
    const { io, deps, requests } = setupImpact();
    assert.equal(await run(["impact", "--base", "main", "--changed", glob, "."], io, deps), EXIT_CODE.usage, glob);
    assert.deepEqual(requests, []);
  }
});

test("an invalid glob is a usage error that asks nothing", async () => {
  for (const flag of ["--include", "--exclude"]) {
    for (const glob of ["", "./x/**", "../x"]) {
      const { io, deps, requests } = setup();
      assert.equal(await run(["map", flag, glob, "."], io, deps), EXIT_CODE.usage, `${flag} ${glob}`);
      assert.deepEqual(requests, []);
    }
  }
});

test("init without --trust, with another value, or with two repositories is a usage error that installs nothing", async () => {
  for (const argv of [["init", "."], ["init", "--trust", "." ], ["init", "--trust", "admin", "."], ["init", "--trust"], ["init", "--trust", "trusted", ".", "other"], ["init", "--trust", "trusted", "--bogus", "."], ["init", "--trust", "trusted", "--workspace", ""]]) {
    const { io, deps, installs } = setupInstall();
    assert.equal(await run(argv, io, deps), EXIT_CODE.usage, argv.join(" "));
    assert.deepEqual(installs, [], argv.join(" "));
    assert.deepEqual(io.stdout, []);
  }
});

test("init passes the declared mode, the resolved repository and its directory name, and defaults the repository to the working directory", async () => {
  const named = setupInstall();
  assert.equal(await run(["init", "--trust", "trusted", "../shop"], named.io, named.deps), EXIT_CODE.ok);
  const implicit = setupInstall();
  assert.equal(await run(["init", "--trust", "untrusted"], implicit.io, implicit.deps), EXIT_CODE.ok);

  assert.deepEqual(named.installs.map(({ signal, ...request }) => (assert.equal(signal, named.signal), request)), [{ repo: resolve("../shop"), repoId: "shop", trust: "trusted" }]);
  assert.deepEqual(implicit.installs.map(({ signal: _, ...request }) => request), [{ repo: resolve("."), repoId: basename(resolve(".")), trust: "untrusted" }]);
});

test("init reports the trust, the exclude lines, each file of the fixed layer and the command that registers the MCP server", async () => {
  const { io, deps } = setupInstall();

  assert.equal(await run(["init", "--trust", "untrusted", "/work/shop"], io, deps), EXIT_CODE.ok);

  const text = io.stdout.join("\n");
  assert.match(text, /untrusted/);
  assert.match(text, /\.ye-ast\/ \.ye-ast-graph\//);
  assert.match(text, /\.ye-ast\/README\.md.*written/);
  assert.match(text, /\.ye-ast\/entrypoints\.json.*written/);
  assert.ok(io.stdout.includes(`claude mcp add ye-ast -- npx --yes tsx ${MCP_ENTRYPOINT} mcp /work/shop`));
  assert.deepEqual(io.stderr, []);
});

test("init tells an unchanged layer, an already excluded folder and a layer that was not written, and why", async () => {
  const unchanged = setupInstall({ ok: true, value: { ...INSTALLED, excluded: [], layer: { outcome: "unchanged", files: ["README.md", "entrypoints.json"] } } });
  await run(["init", "--trust", "untrusted", "/work/shop"], unchanged.io, unchanged.deps);
  const cut = setupInstall({ ok: true, value: { ...INSTALLED, layer: { outcome: "not-written", reason: "deadline" } } });
  await run(["init", "--trust", "untrusted", "/work/shop"], cut.io, cut.deps);

  assert.match(unchanged.io.stdout.join("\n"), /\.ye-ast\/README\.md.*unchanged/);
  assert.doesNotMatch(unchanged.io.stdout.join("\n"), /\.ye-ast-graph\/ /);
  assert.match(unchanged.io.stdout.join("\n"), /already/);
  assert.match(cut.io.stdout.join("\n"), /not written.*deadline/);
});

test("init prints the registration command with the paths quoted for a shell", async () => {
  const { io, deps } = setupInstall();

  await run(["init", "--trust", "untrusted", "/work/my shop"], io, { ...deps, mcpCommand: ["npx", "--yes", "tsx", "/opt/it's/main.ts"] });

  assert.ok(io.stdout.includes(`claude mcp add ye-ast -- npx --yes tsx '/opt/it'\\''s/main.ts' mcp '/work/my shop'`));
});

test("an init fault is one stderr line with the fault kind and exits with the query-failed code; an aborted one exits interrupted", async () => {
  const failed = setupInstall({ ok: false, fault: { kind: "unwritable", detail: "read-only", trustRecorded: false, stage: "trust" } });
  const aborted = setupInstall({ ok: false, fault: { kind: "aborted", detail: "stop", trustRecorded: true, stage: "layer" } });

  assert.equal(await run(["init", "--trust", "untrusted", "."], failed.io, failed.deps), EXIT_CODE.queryFailed);
  assert.equal(await run(["init", "--trust", "untrusted", "."], aborted.io, aborted.deps), EXIT_CODE.interrupted);

  assert.equal(failed.io.stderr.length, 1);
  assert.match(failed.io.stderr[0]!, /unwritable/);
  assert.deepEqual(failed.io.stdout, []);
});

test("a fault after the trust was recorded says so, with the mode, before naming the fault", async () => {
  const stopped = setupInstall({ ok: false, fault: { kind: "git-failed", detail: "dubious ownership", trustRecorded: true, stage: "layer" } });

  assert.equal(await run(["init", "--trust", "trusted", "."], stopped.io, stopped.deps), EXIT_CODE.queryFailed);

  assert.equal(stopped.io.stderr.length, 2);
  assert.match(stopped.io.stderr[0]!, /trusted/);
  assert.match(stopped.io.stderr[1]!, /git-failed/);
});

test("init prints its local report literally, so a path it names is not censored, and a crash of the use case is an internal fault", async () => {
  const local = setupInstall();
  await run(["init", "--trust", "untrusted", `/work/${SECRET}`], local.io, local.deps);
  const crashing = setup();
  const deps = { ...crashing.deps, install: { runBatch: async (): Promise<never> => { throw new Error("not reached"); }, run: async (): Promise<never> => { throw new Error("boom"); } } };

  assert.equal(await run(["init", "--trust", "untrusted", "."], crashing.io, deps), EXIT_CODE.internalFault);

  assert.equal(local.io.stdout.join("\n").includes(`/work/${SECRET}`), true);
});

test("an init fault line is redacted, since it leaves the process toward whoever reads the failure", async () => {
  const failed = setupInstall({ ok: false, fault: { kind: "unwritable", detail: `cannot write /work/${SECRET}`, trustRecorded: false, stage: "trust" } });

  assert.equal(await run(["init", "--trust", "untrusted", "."], failed.io, failed.deps), EXIT_CODE.queryFailed);

  assert.equal(failed.io.stderr.join("\n").includes(SECRET), false);
  assert.match(failed.io.stderr[0]!, /unwritable/);
});

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-cli-install-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A host JDK home holding a `lib/ct.sym`: the CLI checks that the file is readable, never what it holds. */
async function jdkHome(): Promise<string> {
  const home = await mkdtemp(join(scratch, "jdk-home-"));
  await mkdir(join(home, "lib"));
  await writeFile(join(home, "lib", "ct.sym"), "");
  return home;
}

/** A manifest file in the scratch directory; the CLI reads it, the core never does. */
async function workspaceFile(content: string): Promise<string> {
  counter += 1;
  const path = join(scratch, `workspace-${counter}.json`);
  await writeFile(path, content);
  return path;
}

test("init reads the manifest the --workspace flag names and passes its text with the path it was read from", async () => {
  const text = JSON.stringify({ repos: [{ path: "../shop-web" }] });
  const path = await workspaceFile(text);
  const { io, deps, installs } = setupInstall();

  assert.equal(await run(["init", "--trust", "untrusted", "--workspace", path, "/work/shop"], io, deps), EXIT_CODE.ok);

  assert.deepEqual(
    installs.map(({ signal, ...request }) => (assert.equal(signal, deps.signal), request)),
    [{ repo: "/work/shop", repoId: "shop", trust: "untrusted", workspace: { path, text } }],
  );
});

test("init refuses a workspace file it cannot read before the install runs", async () => {
  const { io, deps, installs } = setupInstall();

  assert.equal(await run(["init", "--trust", "untrusted", "--workspace", join(scratch, "absent.json"), "."], io, deps), EXIT_CODE.queryFailed);

  assert.deepEqual(installs, []);
  assert.deepEqual(io.stdout, []);
  assert.match(io.stderr.join("\n"), /workspace-invalid/);
});

test("init reports the manifest it persisted beside the files of the layer", async () => {
  const path = await workspaceFile(JSON.stringify({ repos: [{ path: "../shop-web" }] }));
  const written = setupInstall({ ok: true, value: { ...INSTALLED, workspace: { outcome: "written" } } });
  const unchanged = setupInstall({ ok: true, value: { ...INSTALLED, workspace: { outcome: "unchanged" } } });

  await run(["init", "--trust", "untrusted", "--workspace", path, "/work/shop"], written.io, written.deps);
  await run(["init", "--trust", "untrusted", "--workspace", path, "/work/shop"], unchanged.io, unchanged.deps);

  assert.ok(written.io.stdout.includes(".ye-ast/workspace.json: written"));
  assert.ok(unchanged.io.stdout.includes(".ye-ast/workspace.json: unchanged"));
});

test("the usage names the --workspace flag of init", async () => {
  const { io, deps } = setup();

  assert.equal(await run(["--help"], io, deps), EXIT_CODE.ok);

  assert.match(io.stdout.join("\n"), /ye-ast init[^\n]*--workspace <file>/);
});

const REPO = resolve("some/checkout");

test("--live on map, impact, callers and importers asks for the working tree instead of a revision", async () => {
  const map = setup();
  const impact = setupImpact();
  const callers = setupCallers();
  const importers = setupImporters();

  await run(["map", "--live", "some/checkout"], map.io, map.deps);
  await run(["impact", "--base", "main", "--live", "some/checkout"], impact.io, impact.deps);
  await run(["callers", "--live", "some/checkout", "src/A.java:f"], callers.io, callers.deps);
  await run(["importers", "--live", "some/checkout", "src/A.java"], importers.io, importers.deps);

  const live = (request: { live?: true | undefined; revision?: string | undefined; head?: string | undefined }) => [request.live, request.revision, request.head];
  assert.deepEqual([map.requests, impact.requests, callers.requests, importers.requests].map((requests) => live(requests[0]!)), [[true, undefined, undefined], [true, undefined, undefined], [true, undefined, undefined], [true, undefined, undefined]]);
  assert.equal(impact.requests[0]?.base, "main");
  assert.equal(map.requests[0]?.repo, REPO);
});

test("--live together with --revision or --head is a usage error that asks nothing", async () => {
  const map = setup();
  const impact = setupImpact();
  const callers = setupCallers();
  const importers = setupImporters();

  const codes = [
    await run(["map", "--live", "--revision", "main", "."], map.io, map.deps),
    await run(["impact", "--base", "main", "--live", "--head", "feature", "."], impact.io, impact.deps),
    await run(["callers", "--live", "--revision", "main", ".", "src/A.java:f"], callers.io, callers.deps),
    await run(["importers", "--live", "--revision", "main", ".", "src/A.java"], importers.io, importers.deps),
  ];

  assert.deepEqual(codes, [EXIT_CODE.usage, EXIT_CODE.usage, EXIT_CODE.usage, EXIT_CODE.usage]);
  assert.deepEqual([map.requests, impact.requests, callers.requests, importers.requests], [[], [], [], []]);
});

test("a live query refused under untrusted exits with the query code and names the command that trusts the repository", async () => {
  const refused: Result<never, LiveFault> = { ok: false, fault: { kind: "live-requires-trusted", detail: "run `ye-ast init --trust trusted`" } };
  const { io, deps } = setup(refused);

  assert.equal(await run(["map", "--live", "."], io, deps), EXIT_CODE.queryFailed);
  assert.deepEqual(io.stdout, []);
  assert.match(io.stderr.join("\n"), /live-requires-trusted.*ye-ast init --trust trusted/);
});

test("a working tree that moved after the answer is one redacted stderr line naming the changed paths, and the fact, the notice beside it and the exit code stay", async () => {
  const { io, deps } = setup();
  const entrypoints: EntrypointQueries = {
    map: async (request) => {
      request.live === true && request.onStale?.({ stateId: "s1", changed: ["src/A.java", `src/${SECRET}.java`] });
      return { ok: true, value: MAP };
    },
  };

  assert.equal(await run(["map", "--live", "."], io, { ...deps, entrypoints }), EXIT_CODE.ok);

  const { live, ...fact } = JSON.parse(io.stdout.join("\n")) as Record<string, unknown>;
  assert.deepEqual(live, { stateId: "s1", changed: ["src/A.java", `src/${REDACTED}.java`] });
  assert.deepEqual(fact, MAP);
  assert.equal(io.stderr.length, 1);
  assert.match(io.stderr[0]!, /^ye-ast: stale: .*state s1: src\/A\.java, src\/\[REDACTED\]\.java$/);
});

test("a live answer the tree did not move past carries no notice beside the fact", async () => {
  const { io, deps } = setup();

  assert.equal(await run(["map", "--live", "."], io, deps), EXIT_CODE.ok);

  const printed = JSON.parse(io.stdout.join("\n")) as Record<string, unknown>;
  assert.equal("live" in printed, false);
  assert.deepEqual(printed, MAP);
  assert.deepEqual(io.stderr, []);
});

test("the usage and the help name --live", async () => {
  const { io, deps } = setup();
  await run(["--help"], io, deps);
  assert.match(io.stdout.join("\n"), /--live/);
  assert.match(io.stdout.join("\n"), /ye-ast init --trust trusted/);
});

test("without --live no query asks for a stale notice", async () => {
  const { io, deps, requests } = setup();
  await run(["map", "."], io, deps);
  assert.equal("onStale" in requests[0]!, false);
});


function setupBatch(report?: BatchInstallReport) {
  const base = setup();
  const requests: BatchInstallRequest[] = [];
  const deps = {
    ...base.deps,
    canonicalRepositoryRoot: async (path: string): Promise<Result<string, VcsFault>> => ({ ok: true, value: path === "/alias launch" ? "/work/launch root" : path }),
    install: { ...base.deps.install, runBatch: async (request: BatchInstallRequest): Promise<BatchInstallReport> => {
      requests.push(request);
      return report ?? { targets: [{ requestedPaths: ["/work/launch root", "/alias launch"], id: "launch-id", canonicalRoot: "/work/launch root", status: "completed", trust: "recorded", outcome: INSTALLED }, { requestedPaths: ["/work/member space"], id: "member-id", canonicalRoot: "/work/member space", status: "completed", trust: "recorded", outcome: INSTALLED }] };
    } },
  };
  return { ...base, deps, batches: requests };
}

test("batch init forwards every explicit selection and emits structured registration", async () => {
  const { io, deps, batches } = setupBatch();
  const code = await run(["init", "--trust", "trusted", "--repo", "launch-id", "/alias launch", "--repo", "member-id", "/work/member space", "/work/launch root"], io, deps);
  assert.equal(code, EXIT_CODE.ok);
  assert.deepEqual(batches, [{ launch: { path: "/work/launch root", id: "launch-id" }, repositories: [{ path: "/alias launch", id: "launch-id" }, { path: "/work/member space", id: "member-id" }, { path: "/work/launch root", id: "launch-id" }], trust: "trusted", signal: deps.signal }]);
  assert.equal(io.stdout.length, 2);
  assert.deepEqual(JSON.parse(io.stdout[1]!), { command: "npx", args: ["--yes", "tsx", MCP_ENTRYPOINT, "mcp", "/work/launch root", "--repo", "launch-id", "/work/launch root", "--repo", "member-id", "/work/member space"] });
});

test("batch init requires a launch and rejects malformed pairs before installation", async () => {
  for (const args of [["--repo", "x", "/work/x"], ["--repo", "x"], ["--repo", "", "/work/x", "/work/a"], ["--repo", "x", "--bad", "/work/a"], ["--repo", "--bad", "/work/x", "/work/a"], ["--repo", "x", "/work/x", "/work/a", "/work/b"], ["--repo", "x", "/work/x", "--bad", "/work/a"], ["--repo", "x", "/work/x", "--measure", "/work/a"]]) {
    const { io, deps, batches } = setupBatch();
    assert.equal(await run(["init", "--trust", "trusted", ...args], io, deps), EXIT_CODE.usage, args.join(" "));
    assert.deepEqual(batches, []);
  }
});

test("batch report is redacted and incomplete results never produce registration", async () => {
  for (const [report, expected] of [
    [{ targets: [{ requestedPaths: ["/work/s3cr3t"], id: "a", status: "failed", trust: "recorded", stage: "exclude", fault: { kind: "unwritable", detail: "s3cr3t", trustRecorded: true, stage: "exclude" } }] }, 1],
    [{ targets: [{ requestedPaths: ["/work/a"], id: "a", status: "not-attempted", trust: "not-recorded" }] }, 1],
    [{ targets: [{ requestedPaths: ["/work/a"], id: "a", canonicalRoot: "/work/a", status: "completed", trust: "recorded", outcome: { ...INSTALLED, layer: { outcome: "not-written", reason: "deadline" } } }] }, 1],
    [{ targets: [], termination: "aborted" }, 130], [{ targets: [], termination: "unexpected" }, 70],
  ] as const) {
    const { io, deps } = setupBatch(report as BatchInstallReport);
    assert.equal(await run(["init", "--trust", "untrusted", "--repo", "x", "/work/x", "/work/a"], io, deps), expected);
    assert.equal(io.stdout.length, 1);
    assert.equal(io.stdout[0]!.includes(SECRET), false);
    assert.deepEqual(JSON.parse(io.stdout[0]!), deps.redaction.redactValue(report));
  }
});

test("batch uses natural launch name when no explicit binding matches", async () => {
  const { io, deps, batches } = setupBatch({ targets: [{ id: "launch", requestedPaths: ["/work/launch"], canonicalRoot: "/work/launch", status: "completed", trust: "recorded", outcome: INSTALLED }, { id: "other", requestedPaths: ["/work/other"], canonicalRoot: "/work/other", status: "completed", trust: "recorded", outcome: INSTALLED }] });
  assert.equal(await run(["init", "--trust", "untrusted", "--repo", "other", "/work/other", "/work/launch"], io, deps), EXIT_CODE.ok);
  assert.deepEqual(batches[0]?.launch, { path: "/work/launch", id: "launch" });
  assert.deepEqual(JSON.parse(io.stdout[1]!).args.slice(-6), ["--repo", "launch", "/work/launch", "--repo", "other", "/work/other"]);
});

test("batch forwards workspace only to the single batch request and reports an unreadable file without installation", async () => {
  const path = await workspaceFile('{"repos":[{"path":"/work/member"}]}');
  const { io, deps, batches } = setupBatch();
  await run(["init", "--trust", "trusted", "--repo", "member-id", "/work/member space", "--workspace", path, "/work/launch root"], io, deps);
  assert.deepEqual(batches[0]?.workspace, { path, text: '{"repos":[{"path":"/work/member"}]}' });
  const missing = setupBatch();
  assert.equal(await run(["init", "--trust", "trusted", "--repo", "x", "/work/x", "--workspace", join(scratch, "missing"), "/work/launch"], missing.io, missing.deps), EXIT_CODE.queryFailed);
  assert.deepEqual(missing.batches, []);
  const report = JSON.parse(missing.io.stdout[0]!);
  assert.deepEqual(report.targets.map((t: { status: string }) => t.status), ["not-attempted", "failed"]);
  assert.equal(report.targets[1].fault.kind, "workspace-invalid");
});

test("batch reports a recorded trust on one failure and later completion without registration", async () => {
  const report: BatchInstallReport = { targets: [
    { requestedPaths: ["/work/a"], id: "a", canonicalRoot: "/work/a", status: "failed", trust: "recorded", stage: "exclude", fault: { kind: "unwritable", detail: "denied", trustRecorded: true, stage: "exclude" } },
    { requestedPaths: ["/work/b"], id: "b", canonicalRoot: "/work/b", status: "completed", trust: "recorded", outcome: INSTALLED },
  ] };
  const { io, deps, batches } = setupBatch(report);
  assert.equal(await run(["init", "--trust", "untrusted", "--repo", "b", "/work/b", "/work/a"], io, deps), EXIT_CODE.queryFailed);
  assert.equal(batches.length, 1);
  assert.deepEqual(io.stdout.map((line) => JSON.parse(line)), [report]);
});

const BATCH_ARGS = ["init", "--trust", "trusted", "--repo", "alias-id", "/alias launch", "--repo", "other-id", "/work/other", "/work/launch root"];

test("batch preliminary canonical faults stop on the active launch or alias without retry or writes", async () => {
  for (const target of ["launch", "alias"] as const) {
    for (const thrown of [false, true]) {
      const { io, deps, batches } = setupBatch();
      const calls: string[] = [];
      let failures = 0;
      deps.canonicalRepositoryRoot = async (path) => {
        calls.push(path);
        if (path === (target === "launch" ? "/work/launch root" : "/alias launch") && failures++ === 0) {
          if (thrown) throw new Error("s3cr3t exception");
          return { ok: false, fault: { kind: "unreadable", detail: "s3cr3t failure" } };
        }
        return { ok: true, value: "/work/launch root" };
      };
      assert.equal(await run(BATCH_ARGS, io, deps), thrown ? 70 : 1, `${target} ${thrown}`);
      assert.deepEqual(calls, target === "launch" ? ["/work/launch root"] : ["/work/launch root", "/alias launch"]);
      assert.deepEqual(batches, []);
      assert.equal(io.stdout.length, 1);
      assert.equal(io.stdout[0]!.includes(SECRET), false);
      const report = JSON.parse(io.stdout[0]!);
      assert.equal(report.targets.length, 3);
      const active = report.targets[target === "launch" ? 2 : 0];
      assert.deepEqual([active.status, active.trust, active.stage], ["failed", "not-recorded", "preflight"]);
      if (!thrown) assert.equal(active.fault.kind, "unreadable");
      if (thrown) assert.equal(report.termination, "unexpected");
      assert.ok(report.targets.filter((_: unknown, i: number) => i !== (target === "launch" ? 2 : 0)).every((t: { status: string; trust: string }) => t.status === "not-attempted" && t.trust === "not-recorded"));
    }
  }
});

test("batch preliminary cancellation stops immediately before and after each async boundary", async () => {
  for (const boundary of ["pre", "launch", "member", "name", "workspace"] as const) {
    for (const failing of [false, true]) {
      const { io, deps: base, batches } = setupBatch();
      const controller = new AbortController();
      const calls: string[] = [];
      if (boundary === "pre") controller.abort();
      const deps = { ...base, signal: controller.signal,
        canonicalRepositoryRoot: async (path: string): Promise<Result<string, VcsFault>> => {
          calls.push(`canonical ${path}`);
          if ((boundary === "launch" && path === "/work/launch root") || (boundary === "member" && path === "/alias launch")) {
            controller.abort();
            if (failing) return { ok: false, fault: { kind: "unreadable", detail: "failure" } };
          }
          return { ok: true, value: path };
        },
        repositoryName: async (): Promise<Result<string, VcsFault>> => {
          calls.push("name");
          if (boundary === "name") { controller.abort(); if (failing) return { ok: false, fault: { kind: "git-failed", detail: "failure" } }; }
          return { ok: true, value: "natural" };
        },
        readWorkspaceFile: async (path: string) => {
          calls.push("workspace");
          if (boundary === "workspace") controller.abort();
          return failing ? { ok: false as const, fault: { kind: "workspace-invalid" as const, detail: "failure" } } : { ok: true as const, value: { path, text: "{}" } };
        },
      };
      const args = [...BATCH_ARGS.slice(0, -1), "--workspace", "/work/ws", BATCH_ARGS.at(-1)!];
      assert.equal(await run(args, io, deps), 130, `${boundary} ${failing}`);
      assert.deepEqual(batches, []);
      assert.equal(io.stdout.length, 1);
      const report = JSON.parse(io.stdout[0]!);
      assert.equal(report.termination, "aborted");
      assert.equal(report.targets.length, 3);
      assert.ok(report.targets.every((t: { status: string; trust: string }) => t.status === "not-attempted" && t.trust === "not-recorded"));
      const expected = boundary === "pre" ? [] : boundary === "launch" ? ["canonical /work/launch root"] : boundary === "member" ? ["canonical /work/launch root", "canonical /alias launch"] : boundary === "name" ? ["canonical /work/launch root", "canonical /alias launch", "canonical /work/other", "name"] : ["canonical /work/launch root", "canonical /alias launch", "canonical /work/other", "name", "workspace"];
      assert.deepEqual(calls, expected, boundary);
    }
  }
});

test("batch unexpected naming, workspace and installation rejections preserve selection and certainty", async () => {
  for (const step of ["name", "workspace", "batch"] as const) {
    const { io, deps: base } = setupBatch();
    const deps = { ...base, canonicalRepositoryRoot: async (path: string): Promise<Result<string, VcsFault>> => ({ ok: true, value: path }),
      repositoryName: async (): Promise<Result<string, VcsFault>> => { if (step === "name") throw new Error("s3cr3t"); return { ok: true, value: "natural" }; },
      readWorkspaceFile: async (path: string) => { if (step === "workspace") throw new Error("s3cr3t"); return { ok: true as const, value: { path, text: "{}" } }; },
      install: { ...base.install, runBatch: async (): Promise<BatchInstallReport> => { throw new Error("s3cr3t"); } },
    };
    const args = [...BATCH_ARGS.slice(0, -1), "--workspace", "/work/ws", BATCH_ARGS.at(-1)!];
    assert.equal(await run(args, io, deps), 70, step);
    assert.equal(io.stdout.length, 1);
    assert.equal(io.stdout[0]!.includes(SECRET), false);
    const report = JSON.parse(io.stdout[0]!);
    assert.equal(report.termination, "unexpected");
    assert.equal(report.targets.length, 3);
    if (step === "batch") assert.ok(report.targets.every((t: { status: string; trust: string }) => t.status === "failed" && t.trust === "unknown"));
    else assert.ok(report.targets.every((t: { trust: string }) => t.trust === "not-recorded"));
  }
});

test("missing batch workspace reports observed fault and leaves conflicting bindings unverified", async () => {
  const { io, deps, batches } = setupBatch();
  const code = await run(["init", "--trust", "trusted", "--repo", "same", "/work/a", "--repo", "same", "/work/b", "--workspace", join(scratch, "missing"), "/work/launch root"], io, deps);
  assert.equal(code, 1);
  assert.deepEqual(batches, []);
  assert.equal(io.stdout.length, 1);
  const report = JSON.parse(io.stdout[0]!);
  assert.deepEqual(report.targets.map((t: { status: string }) => t.status), ["not-attempted", "not-attempted", "failed"]);
  assert.equal(report.targets[2].fault.kind, "workspace-invalid");
  assert.ok(report.targets.slice(0, 2).every((t: { fault?: unknown }) => t.fault === undefined));
});

test("typed aborted identity faults stop batch even when the signal is not aborted", async () => {
  for (const at of ["launch", "member", "name"] as const) {
    const { io, deps: base, batches } = setupBatch();
    const calls: string[] = [];
    const deps = { ...base,
      canonicalRepositoryRoot: async (path: string): Promise<Result<string, VcsFault>> => {
        calls.push(path);
        if ((at === "launch" && path === "/work/launch root") || (at === "member" && path === "/alias launch")) return { ok: false, fault: { kind: "aborted", detail: "stop" } };
        return { ok: true, value: path };
      },
      repositoryName: async (): Promise<Result<string, VcsFault>> => { calls.push("name"); return at === "name" ? { ok: false, fault: { kind: "aborted", detail: "stop" } } : { ok: true, value: "natural" }; },
    };
    assert.equal(await run(BATCH_ARGS, io, deps), 130, at);
    const report = JSON.parse(io.stdout[0]!);
    assert.equal(report.termination, "aborted");
    assert.equal(report.targets[at === "member" ? 0 : 2].fault.kind, "aborted");
    assert.deepEqual(batches, []);
    assert.equal(io.stdout.length, 1);
    assert.equal(calls.at(-1), at === "launch" ? "/work/launch root" : at === "member" ? "/alias launch" : "name");
  }
});

test("a thrown preliminary read that aborts returns cancellation and stops progression", async () => {
  const { io, deps: base, batches } = setupBatch();
  const controller = new AbortController();
  const deps = { ...base, signal: controller.signal, canonicalRepositoryRoot: async (): Promise<Result<string, VcsFault>> => { controller.abort(); throw new Error("s3cr3t"); } };
  assert.equal(await run(BATCH_ARGS, io, deps), 130);
  assert.deepEqual(batches, []);
  assert.equal(JSON.parse(io.stdout[0]!).termination, "aborted");
  assert.equal(io.stdout.length, 1);
});

test("a non-aborted naming fault keeps the existing basename fallback", async () => {
  const { io, deps: base, batches } = setupBatch();
  const deps = { ...base, canonicalRepositoryRoot: async (path: string): Promise<Result<string, VcsFault>> => ({ ok: true, value: path }), repositoryName: async (): Promise<Result<string, VcsFault>> => ({ ok: false, fault: { kind: "git-failed", detail: "unavailable" } }) };
  await run(BATCH_ARGS, io, deps);
  assert.equal(batches[0]?.launch.id, "launch root");
});

test("contract-consequences asks for one subject on the persisted workspace, binds a change at its head, and prints the fact", async () => {
  const request = { ...HYPOTHESIS, target: "request", change: [{ type: "string" }, "required"] };
  const hypotheses = setupConsequences();
  assert.equal(await run(["contract-consequences", "--hypothesis", JSON.stringify(HYPOTHESIS), "--hypothesis", JSON.stringify(request), "--revision", "v1", "--repo-id", "shop", "--include", "src/**", "some/checkout"], hypotheses.io, hypotheses.deps), EXIT_CODE.ok);
  assert.deepEqual(JSON.parse(hypotheses.io.stdout.join("\n")), CONSEQUENCES_FACT);
  assert.deepEqual(hypotheses.requests, [{ repo: { path: resolve("some/checkout"), id: "shop", revision: "v1" }, hypotheses: [HYPOTHESIS, request], scope: { include: ["src/**"] }, signal: hypotheses.signal }]);

  const change = setupConsequences();
  assert.equal(await run(["contract-consequences", "--base", "main", "some/checkout"], change.io, change.deps), EXIT_CODE.ok);
  // A bound revision other than the head is a contradiction the use case refuses, so a change binds none.
  assert.deepEqual(change.requests, [{ repo: { path: resolve("some/checkout"), id: "checkout" }, base: "main", head: "HEAD", signal: change.signal }]);
});

test("a contract-consequences fault is one stderr line with its kind and exits query-failed", async () => {
  const faults: ConsequencesFault[] = [
    { kind: "invalid-hypothesis", detail: "hypotheses[0]: invalid method", index: 0, refusal: { kind: "invalid-method", detail: "FETCH" } },
    { kind: "contradictory-revisions", detail: `bound to ${SECRET}` },
  ];
  for (const fault of faults) {
    const { io, deps } = setupConsequences({ ok: false, fault });
    assert.equal(await run(["contract-consequences", "--base", "main", "."], io, deps), EXIT_CODE.queryFailed);
    assert.deepEqual(io.stderr, [`ye-ast: ${fault.kind}: ${fault.detail.replaceAll(SECRET, REDACTED)}`]);
    assert.deepEqual(io.stdout, []);
  }
});

test("contract-consequences without exactly one subject, or with a flag only the other subject takes, is a usage error and asks nothing", async () => {
  const hypothesis = JSON.stringify(HYPOTHESIS);
  for (const tail of [
    ["."],
    ["--hypothesis", hypothesis, "--base", "main", "."],
    ["--hypothesis", hypothesis, "--head", "x", "."],
    ["--base", "main", "--revision", "v1", "."],
    ["--hypothesis", "{not json", "."],
    ["--hypothesis", JSON.stringify({ ...HYPOTHESIS, change: [] }), "."],
    ["--hypothesis", JSON.stringify({ ...HYPOTHESIS, extra: 1 }), "."],
    ["--hypothesis", JSON.stringify({ method: "GET" }), "."],
    ["--hypothesis", JSON.stringify([HYPOTHESIS]), "."],
    ["--base", "main", "--live", "."],
    ["--hypothesis", hypothesis, "a", "b"],
  ]) await refuses(["contract-consequences", ...tail], setupConsequences);
});

test("--node-modules declares a build output for callers and impact, at the root or at <at>=, and a directory out of the repository is a usage error", async () => {
  const callers = setupCallers();
  assert.equal(await run(["callers", "--node-modules", "deps/node_modules", "--node-modules", "web=/host/web/node_modules", ".", "src/A.ts:load"], callers.io, callers.deps), EXIT_CODE.ok);
  assert.deepEqual(callers.requests[0]?.buildOutputs, [{ kind: "node-modules", at: "", path: resolve("deps/node_modules") }, { kind: "node-modules", at: "web", path: "/host/web/node_modules" }]);
  const impact = setupImpact();
  assert.equal(await run(["impact", "--base", "main", "--node-modules", "/host/node_modules", "."], impact.io, impact.deps), EXIT_CODE.ok);
  assert.deepEqual(impact.requests[0]?.buildOutputs, [{ kind: "node-modules", at: "", path: "/host/node_modules" }]);
  for (const wrong of ["../up=/host/node_modules", "web=", "/abs=/host/node_modules"]) {
    const refused = setupCallers();
    assert.equal(await run(["callers", "--node-modules", wrong, ".", "src/A.ts:load"], refused.io, refused.deps), EXIT_CODE.usage, wrong);
    assert.deepEqual(refused.requests, []);
  }
});

test("init with --node-modules registers the MCP server with that declaration, resolved, and never hands it to the install", async () => {
  const { io, deps, installs } = setupInstall();

  assert.equal(await run(["init", "--trust", "untrusted", "--node-modules", "web=/host/web/node_modules", "/work/shop"], io, deps), EXIT_CODE.ok);

  assert.ok(io.stdout.includes(`claude mcp add ye-ast -- npx --yes tsx ${MCP_ENTRYPOINT} mcp /work/shop --node-modules web=/host/web/node_modules`));
  assert.equal(installs.some((request) => "nodeModules" in request || "buildOutputs" in request), false);
  const refused = setupInstall();
  assert.equal(await run(["init", "--trust", "untrusted", "--node-modules", "../up=/x", "/work/shop"], refused.io, refused.deps), EXIT_CODE.usage);
});

test("--java-sources declares a generated source directory for callers and impact, and a spec without an at is a usage error", async () => {
  const at = "target/generated-sources/openapi";
  const generated = "/host/generated-openapi";
  const callers = setupCallers();
  assert.equal(await run(["callers", "--java-sources", `${at}=${generated}`, ".", "src/A.ts:load"], callers.io, callers.deps), EXIT_CODE.ok);
  assert.deepEqual(callers.requests[0]?.buildOutputs, [{ kind: "java-sources", at, path: generated }]);
  const impact = setupImpact();
  assert.equal(await run(["impact", "--base", "main", "--java-sources", `${at}=${generated}`, "."], impact.io, impact.deps), EXIT_CODE.ok);
  assert.deepEqual(impact.requests[0]?.buildOutputs, [{ kind: "java-sources", at, path: generated }]);
  for (const wrong of [generated, `=${generated}`, `${at}=`, `../up=${generated}`]) {
    const refused = setupCallers();
    assert.equal(await run(["callers", "--java-sources", wrong, ".", "src/A.ts:load"], refused.io, refused.deps), EXIT_CODE.usage, wrong);
    assert.deepEqual(refused.requests, []);
  }
});

test("init with --jdk registers the MCP server with that host JDK path, resolved, and never hands it to the install", async () => {
  const home = await jdkHome();
  const { io, deps, installs } = setupInstall();

  assert.equal(await run(["init", "--trust", "untrusted", "--jdk", home, "/work/shop"], io, deps), EXIT_CODE.ok);

  assert.ok(io.stdout.includes(`claude mcp add ye-ast -- npx --yes tsx ${MCP_ENTRYPOINT} mcp /work/shop --jdk ${home}`), io.stdout.join("\n"));
  assert.equal(installs.some((request) => "jdk" in request || "jdkPath" in request), false);
  const refused = setupInstall();
  assert.equal(await run(["init", "--trust", "untrusted", "--jdk"], refused.io, refused.deps), EXIT_CODE.usage);
  assert.equal(refused.installs.length, 0);
});

test("init with --jdk names a home without a readable lib/ct.sym as a usage error before any install, and accepts a readable one whatever its digest", async () => {
  const home = await jdkHome();
  const missing = setupInstall();
  assert.equal(await run(["init", "--trust", "untrusted", "--jdk", join(home, "absent"), "/work/shop"], missing.io, missing.deps), EXIT_CODE.usage);
  assert.ok(missing.io.stderr.join("\n").startsWith("usage:"), missing.io.stderr.join("\n"));
  assert.equal(missing.installs.length, 0);

  const present = setupInstall();
  assert.equal(await run(["init", "--trust", "untrusted", "--jdk", home, "/work/shop"], present.io, present.deps), EXIT_CODE.ok);
  assert.equal(present.installs.length, 1);
});

test("init carries every declared output into the registration: node modules as given, then java sources sorted by at", async () => {
  const { io, deps } = setupInstall();

  assert.equal(await run(["init", "--trust", "untrusted", "--java-sources", "z/late=/host/late", "--node-modules", "web=/host/web/node_modules", "--java-sources", "a/early=/host/early", "/work/shop"], io, deps), EXIT_CODE.ok);

  assert.ok(io.stdout.includes(`claude mcp add ye-ast -- npx --yes tsx ${MCP_ENTRYPOINT} mcp /work/shop --node-modules web=/host/web/node_modules --java-sources a/early=/host/early --java-sources z/late=/host/late`), io.stdout.join("\n"));
});

test("init prints node-modules declarations in the order the user gave them, as before java sources existed", async () => {
  const { io, deps } = setupInstall();

  assert.equal(await run(["init", "--trust", "untrusted", "--node-modules", "web=/host/web/node_modules", "--node-modules", "api=/host/api/node_modules", "/work/shop"], io, deps), EXIT_CODE.ok);

  assert.ok(io.stdout.includes(`claude mcp add ye-ast -- npx --yes tsx ${MCP_ENTRYPOINT} mcp /work/shop --node-modules web=/host/web/node_modules --node-modules api=/host/api/node_modules`), io.stdout.join("\n"));
});
