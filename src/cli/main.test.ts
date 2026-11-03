import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { EntrypointMapFact } from "../core/domain/map/entrypoint-map.ts";
import { SCHEMA, type Fact } from "../core/domain/shared/fact.ts";
import type { Result } from "../core/domain/shared/result.ts";
import type { EntrypointQueries, MapRequest } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactCallersRequest, ImpactFault, ImpactImportersRequest, ImpactOfChangeRequest, ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { ImportersValue } from "../core/domain/impact/importers-fact.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import { REDACTED, type Redaction } from "../core/ports/redaction.port.ts";
import type { VcsFault } from "../core/ports/vcs.port.ts";
import type { LiveFault } from "../core/ports/live-queries.port.ts";
import type { Install, InstallFault, InstallOutcome, InstallRequest } from "../core/ports/install.port.ts";
import { EXIT_CODE, run, type CliIo } from "./main.ts";

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
    run: async (request) => {
      installs.push(request);
      return { ok: true, value: INSTALLED };
    },
  };
  return { requests, installs, signal, io: recordingIo(), deps: { version: VERSION, entrypoints, impact, install, mcpCommand: ["npx", "--yes", "tsx", MCP_ENTRYPOINT], redaction, repositoryName: async (repo: string): Promise<Result<string, VcsFault>> => ({ ok: true, value: basename(repo) }), signal } };
}

const MCP_ENTRYPOINT = "/opt/ye-ast/src/composition/main.ts";
const INSTALLED: InstallOutcome = { trust: "untrusted", excluded: [".ye-ast/", ".ye-ast-graph/"], layer: { outcome: "written", files: ["README.md", "entrypoints.json"] } };

function setupInstall(answer: Result<InstallOutcome, InstallFault> = { ok: true, value: INSTALLED }) {
  const base = setup();
  const install: Install = {
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
        { file: "A.java", symbol: "gone", candidates: ["load", "save"] },
        { file: "B.java", symbol: "gone", candidates: [] },
      ],
    },
  });
  assert.equal(await run(["callers", ".", "A.java:gone"], io, deps), EXIT_CODE.queryFailed);
  assert.deepEqual(io.stdout, []);
  assert.deepEqual(io.stderr, [
    "ye-ast: unknown-symbol: no symbol at the revision for A.java:gone",
    "  - A.java:gone: declared in A.java: load, save",
    "  - B.java:gone: B.java declares no symbol",
  ]);
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
  const failed = setupInstall({ ok: false, fault: { kind: "unwritable", detail: "read-only", trustRecorded: false } });
  const aborted = setupInstall({ ok: false, fault: { kind: "aborted", detail: "stop", trustRecorded: true } });

  assert.equal(await run(["init", "--trust", "untrusted", "."], failed.io, failed.deps), EXIT_CODE.queryFailed);
  assert.equal(await run(["init", "--trust", "untrusted", "."], aborted.io, aborted.deps), EXIT_CODE.interrupted);

  assert.equal(failed.io.stderr.length, 1);
  assert.match(failed.io.stderr[0]!, /unwritable/);
  assert.deepEqual(failed.io.stdout, []);
});

test("a fault after the trust was recorded says so, with the mode, before naming the fault", async () => {
  const stopped = setupInstall({ ok: false, fault: { kind: "git-failed", detail: "dubious ownership", trustRecorded: true } });

  assert.equal(await run(["init", "--trust", "trusted", "."], stopped.io, stopped.deps), EXIT_CODE.queryFailed);

  assert.equal(stopped.io.stderr.length, 2);
  assert.match(stopped.io.stderr[0]!, /trusted/);
  assert.match(stopped.io.stderr[1]!, /git-failed/);
});

test("init redacts what it prints and a crash of the use case is an internal fault", async () => {
  const leaking = setupInstall();
  await run(["init", "--trust", "untrusted", `/work/${SECRET}`], leaking.io, leaking.deps);
  const crashing = setup();
  const deps = { ...crashing.deps, install: { run: async (): Promise<never> => { throw new Error("boom"); } } };

  assert.equal(await run(["init", "--trust", "untrusted", "."], crashing.io, deps), EXIT_CODE.internalFault);

  assert.equal(leaking.io.stdout.join("\n").includes(SECRET), false);
});

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-cli-install-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

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

test("a working tree that moved after the answer is one redacted stderr line naming the changed paths, and the fact and the exit code stay", async () => {
  const { io, deps } = setup();
  const entrypoints: EntrypointQueries = {
    map: async (request) => {
      request.live === true && request.onStale?.({ stateId: "s1", changed: ["src/A.java", `src/${SECRET}.java`] });
      return { ok: true, value: MAP };
    },
  };

  assert.equal(await run(["map", "--live", "."], io, { ...deps, entrypoints }), EXIT_CODE.ok);

  assert.deepEqual(JSON.parse(io.stdout.join("\n")), MAP);
  assert.equal(io.stderr.length, 1);
  assert.match(io.stderr[0]!, /^ye-ast: stale: .*state s1: src\/A\.java, src\/\[REDACTED\]\.java$/);
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
