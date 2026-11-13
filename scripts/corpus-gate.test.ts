import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Answer } from "./corpus-gate-diff.ts";
import { EXIT, passMarkerPath, runGate, runGroups } from "./corpus-gate.ts";
import { OCCURRENCE_CLASSES } from "./corpus-gate-occurrences.ts";

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

/**
 * A stand-in engine CLI: lists the repository's files, says whether `init` declared it trusted, echoes the git protocol
 * policy, refuses a workspace without repositories as the engine does, prints its repository path reversed, a form
 * no normalization recognizes, as an engine that rewrites a path would, and the repository paths of a `--workspace` file.
 */
function engineSource(extra: string): string {
  return `import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [command, ...args] = process.argv.slice(2);
const trustFile = join(process.env.XDG_CONFIG_HOME ?? "", "trusted");
const repo = args.at(-1) ?? "";
if (command === "init") {
  const workspace = args.indexOf("--workspace");
  if (workspace !== -1 && JSON.parse(readFileSync(args[workspace + 1], "utf8")).repos.length === 0) process.exit(1);
  mkdirSync(process.env.XDG_CONFIG_HOME ?? "", { recursive: true });
  appendFileSync(trustFile, repo + "\\n");
  console.log("declared " + repo);
} else {
  const files = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).split("\\n").filter(Boolean);
  const trusted = existsSync(trustFile) && readFileSync(trustFile, "utf8").split("\\n").includes(repo);
  const workspace = args.indexOf("--workspace");
  const members = workspace === -1 ? undefined : JSON.parse(readFileSync(args[workspace + 1], "utf8")).repos.map((member) => member.path);
  console.log(JSON.stringify({ status: "complete", repo, reversed: [...repo].reverse().join(""), trusted, protocols: process.env.GIT_ALLOW_PROTOCOL, members, options: args.slice(0, -1), files: [...files, ${extra}] }));
}
`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_IDENTITY } }).trim();
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--message", message);
  return git(repo, "rev-parse", "HEAD");
}

const baseValue = {
  symbols: [{ file: "src/a.ts", symbol: "a", via: { file: "src/B.java" } }, { file: "src/B.java", symbol: "B.b" }],
  entrypoints: [{ kind: "http", handler: { file: "src/a.ts" } }],
  readingPlan: { ranges: [{ file: "src/a.ts", start: 1 }] },
};
const gainedSymbol = { file: "src/c.ts", symbol: "c" };
const importedA = { file: "src/a.ts", lines: [1, 2], importers: ["src/b.ts"] };
const importedC = { file: "src/c.ts", importers: ["src/b.ts"] };
const importersValue = {
  files: [importedA, importedC],
  effects: [{ kind: "data", line: 3, operation: "save" }],
};

/**
 * A stand-in engine whose `callers` prints the fact given, at the commit its repository holds; `broken` prints no fact,
 * `unknown` a fact without a value, and any other command a fact with seeds under a family that states no declaration targets.
 */
function callersEngine(fact: object): string {
  return `import { execFileSync } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
const repo = args.at(-1) ?? "";
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const snapshot = { repo: "src", kind: "sha", sha };
if (command === "callers") console.log(JSON.stringify({ ...${JSON.stringify(fact)}, snapshot }));
else if (command === "broken") console.log("not a fact");
else if (command === "unknown") console.log(JSON.stringify({ status: "unknown", reason: "out-of-scope", snapshot }));
else console.log(JSON.stringify({ status: "complete", snapshot, value: { seeds: [{ file: "src/Target.java", symbol: "Target", line: 1 }], symbols: [] } }));
`;
}

const OCCURRENCE_SOURCES = {
  "src/Target.java": "public class Target {\n  Target() {}\n}\n",
  "src/target.ts": "export const Target = 1;\n",
  "src/Listed.java": "class Listed {\n  Target held = null;\n}\n",
  "src/Placed.java": "class Placed {\n  Target placed;\n\n  // Target\n}\n",
  "src/covered.ts": "import { Target } from './target';\n",
  "src/Silent.java": "class Silent {\n  Object held = new Target();\n}\n",
  "src/view.html": "<a (click)=\"Target()\"></a>\n",
  "src/routes.ts": "export const routes = [{ component: Target }];\n",
  "src/Handler.java": "class Handler {\n  Target held;\n}\n",
  "src/Whole.java": "class Whole {\n  Target held;\n}\n",
  "src/Imported.java": "import x.Target;\n",
  "src/Called.java": "class Called {\n  void go() { Target.run(); }\n}\n",
  "docs/Excluded.java": "Target\n",
  "README.md": "Target\n",
};
const declaration = (file: string, symbol: string, endLine: number) => ({ file, symbol, kind: "class", line: 1, endLine, depth: 1, confidence: 1, fanIn: 0 });
const callersFact = (symbols: object[]) => ({
  schema: "0.24.0",
  status: "partial",
  inputs: { declaredScope: { languages: ["java", "typescript"], frameworks: [], include: [], exclude: ["docs/**"] } },
  value: {
    seeds: [{ file: "src/Target.java", symbol: "Target", line: 1, endLine: 3, basis: "lines" }, { file: "src/target.ts", symbol: "Target", line: 1, endLine: 1, basis: "lines" }],
    symbols,
    entrypoints: [{ kind: "ui-route", name: "/", handler: { path: "src/Handler.java", symbol: "Handler", line: 1, endLine: 3 }, depth: 0, confidence: 1, seeds: [0], declaredAt: { path: "src/routes.ts", line: 1 } }],
    modules: { origins: [], modules: [{ file: "src/Whole.java", snapshot: "head", depth: 1, origins: [0] }], cost: { expansionsUsed: 1 } },
    cost: { expansionsUsed: 1 },
  },
  cuts: [
    { kind: "unresolved-link", at: ["src/Imported.java", "src/Imported.java:9"], reason: "specifier", reach: { kind: "module", importer: "src/Imported.java", specifiers: [{ specifier: "x" }] } },
    { kind: "unresolved-link", at: ["src/Other.java::Other.go"], reason: "callee-unknown", reach: { kind: "call-at", place: "src/Called.java:2" } },
    { kind: "unresolved-link", at: ["src/Placed.java", "src/Placed.java:2 Target"], reason: "name-only", reach: { kind: "callers-of", declarations: ["src/Other.java::Other"] } },
    { kind: "unresolved-link", at: ["src/other.ts"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } },
  ],
});
const placed = (file: string, symbol: string, line: number, endLine: number) => ({ ...declaration(file, symbol, endLine), line });

/** One fixture per rule of the occurrence oracle: a TypeScript target `Code`, and Java targets `Store` and `Repo`. */
const RULE_SOURCES = {
  "package.json": JSON.stringify({ dependencies: { "@angular/core": "1.0.0" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }),
  "src/lib/codes.ts": "export const Code = 1;\n",
  "src/lib/index.ts": "export * from './codes';\n",
  "src/alias-user.ts": "import { Code } from '@lib/index';\nexport const viaAlias = Code;\n",
  "src/homonym.ts": "export const other = { Code: 2 };\n",
  "src/legacy/tsconfig.json": JSON.stringify({ extends: "./missing.json" }),
  "src/legacy/unproven.ts": "import { x } from './gone';\nexport const y = { Code: x };\n",
  "src/comment.ts": "import { Code } from './lib/codes';\n// Code is read\nconst s = 'Code';\nexport const t = `${Code}`;\nexport const u = `Code`;\n",
  "src/shown.ts": "import { Code } from './lib/codes';\n\n@Decorated({\n  uses: [Code],\n})\nexport class Shown {\n  read() { return 0; }\n}\nexport const after = Code;\n",
  "src/app.component.ts": "import { Component } from '@angular/core';\n@Component({ selector: 'app-root', templateUrl: './app.component.html' })\nexport class AppComponent {}\n",
  "src/app.component.html": "<p>{{ Code }}</p>\n",
  "src/other.component.ts": "import { Component } from '@angular/core';\n@Component({ selector: 'app-other', templateUrl: './other.component.html' })\nexport class OtherComponent {}\n",
  "src/other.component.html": "<p class=\"Code\"></p>\n",
  "src/named.component.ts": "import { Component } from '@angular/core';\nimport { Code } from './lib/codes';\n@Component({ selector: 'app-named', templateUrl: './named.component.html' })\nexport class NamedComponent {}\n",
  "src/named.component.html": "<p>{{ Code }}</p>\n",
  "docs/page.html": "<h1>Code</h1>\n",
  "src/codes.spec.ts": "import { Code } from './lib/codes';\n",
  "src/main/java/app/Mention.java": "package app;\nclass Mention { int Code; }\n",
  "src/main/java/app/store/Store.java": "package app.store;\npublic interface Store {\n  String CACHE = \"c\";\n}\n",
  "src/main/java/app/store/Neighbor.java": "package app.store;\nclass Neighbor {\n  Store held;\n  // the Store\n}\n",
  "src/main/java/app/config/Qualified.java": "package app.config;\nclass Qualified {\n  String n() { return app.store.Store.CACHE; }\n}\n",
  "src/main/java/app/config/Imported.java": "package app.config;\nimport app.store.Store;\nclass Imported {\n  Store held;\n}\n",
  "src/main/java/app/other/Wild.java": "package app.other;\nimport app.store.*;\nclass Wild {\n  Store held;\n}\n",
  "src/main/java/app/other/Elsewhere.java": "package app.other;\nclass Elsewhere {\n  String Store = \"x\";\n}\n",
  "src/test/java/app/StoreTest.java": "package app;\nclass StoreTest { app.store.Store s; }\n",
  "src/main/java/app/store/Repo.java": "package app.store;\npublic class Repo {}\n",
  "src/main/java/app/store/Holder.java": "package app.store;\nclass Holder {\n  Repo first;\n  Repo second;\n}\n",
};
const rulesFact = {
  schema: "0.24.0",
  status: "partial",
  inputs: { declaredScope: { languages: ["java", "typescript"], frameworks: [], include: [], exclude: [] } },
  value: {
    seeds: [
      { file: "src/lib/codes.ts", symbol: "Code", line: 1, endLine: 1, basis: "lines" },
      { file: "src/main/java/app/store/Store.java", symbol: "Store", line: 2, endLine: 4, basis: "lines" },
      { file: "src/main/java/app/store/Repo.java", symbol: "Repo", line: 2, endLine: 2, basis: "lines" },
    ],
    symbols: [placed("src/shown.ts", "Shown", 6, 8), placed("src/app.component.ts", "AppComponent", 3, 3)],
  },
  cuts: [{ kind: "unresolved-link", at: ["src/main/java/app/store/Holder.java:3 Repo"], reason: "name-only", reach: { kind: "callers-of", declarations: ["src/main/java/app/store/Repo.java::Repo"] } }],
};
const listedSymbols = [
  declaration("src/Target.java", "Target", 3),
  declaration("src/Listed.java", "Listed", 3),
  { ...declaration("src/view.ts", "View", 1), via: { file: "src/Target.java", symbol: "Target", resource: "src/view.html", lines: [1], basis: "call" } },
];

interface ValueRow { family: string; language: string; collection: string; entries?: number; gained?: number; lost?: number; changed?: number }

describe("corpus gate", () => {
  let root: string;
  let engine: string;
  let corpus: string;
  let manifest: string;
  let parallelManifest: string;
  let workspaceManifest: string;
  let store: string;
  const commits: Record<"base" | "same" | "adds" | "lockfile" | "cuts" | "unknownCut" | "values" | "valuesSame" | "valuesGained" | "valuesChanged" | "valuesUnread" | "importers" | "importerGained" | "importerDropped" | "effectChanged" | "occurrences" | "occurrencesSame" | "occurrenceListed" | "occurrencesBounded" | "occurrenceRules" | "occurrenceRulesSame", string> = {
    base: "", same: "", adds: "", lockfile: "", cuts: "", unknownCut: "", values: "", valuesSame: "", valuesGained: "", valuesChanged: "", valuesUnread: "",
    importers: "", importerGained: "", importerDropped: "", effectChanged: "", occurrences: "", occurrencesSame: "", occurrenceListed: "", occurrencesBounded: "", occurrenceRules: "", occurrenceRulesSame: "",
  };
  let occurrenceManifest: string;
  let rulesManifest: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "corpus-gate-test-"));
    corpus = join(root, "corpus", "app");
    mkdirSync(corpus, { recursive: true });
    git(corpus, "init", "--quiet");
    const corpusSha = commit(corpus, { "a.txt": "a", "b.txt": "b" }, "corpus");
    const second = join(root, "corpus", "second");
    mkdirSync(second, { recursive: true });
    git(second, "init", "--quiet");
    const secondSha = commit(second, { "c.txt": "c" }, "second");

    engine = join(root, "engine");
    mkdirSync(engine);
    git(engine, "init", "--quiet");
    writeFileSync(join(engine, ".gitignore"), "node_modules\n");
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(engine, "node_modules"));
    const packageJson = JSON.stringify({ type: "module", scripts: { cli: "node --import tsx main.ts" } });
    commits.base = commit(engine, { "package.json": packageJson, "main.ts": engineSource("") }, "base");
    commits.same = commit(engine, { "main.ts": `// same behavior\n${engineSource("")}` }, "same");
    commits.adds = commit(engine, { "main.ts": engineSource(`"extra"`) }, "adds");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    commits.lockfile = commit(engine, { "package-lock.json": "{}" }, "lockfile");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    const partialWith = (reason: string) => engineSource("").replace(`status: "complete"`, `status: "partial", cuts: [{ kind: "depth", at: ["src/a.ts"], limit: 1, reason: "${reason}", reach: { kind: "anything" } }]`);
    commits.cuts = commit(engine, { "main.ts": partialWith("depth") }, "cuts");
    commits.unknownCut = commit(engine, { "main.ts": partialWith("other") }, "unknown cut");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    const withValue = (value: object) => engineSource("").replace(`status: "complete",`, `status: "complete", value: ${JSON.stringify(value)},`);
    commits.values = commit(engine, { "main.ts": withValue(baseValue) }, "values");
    commits.valuesSame = commit(engine, { "main.ts": `// same values\n${withValue(baseValue)}` }, "same values");
    git(engine, "checkout", "--quiet", "--detach", commits.values);
    commits.valuesGained = commit(engine, { "main.ts": withValue({ ...baseValue, symbols: [...baseValue.symbols, gainedSymbol], entrypoints: [...baseValue.entrypoints, { kind: "http", handler: { file: "src/c.ts" } }] }) }, "values gained");
    git(engine, "checkout", "--quiet", "--detach", commits.values);
    const reachedAnew = { ...baseValue.symbols[0], depth: 2, confidence: 0.5, via: { file: "src/c.ts" } };
    commits.valuesChanged = commit(engine, { "main.ts": withValue({ ...baseValue, symbols: [reachedAnew, baseValue.symbols[1], gainedSymbol, { file: "src/d.ts", symbol: "d" }] }) }, "values changed");
    git(engine, "checkout", "--quiet", "--detach", commits.values);
    const unread = withValue(baseValue).replace("console.log(JSON.stringify({ status:", "if (trusted) { console.log(\"not json\"); process.exit(0); } process.exitCode = 1; console.log(JSON.stringify({ status:");
    commits.valuesUnread = commit(engine, { "main.ts": unread }, "values unread");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    commits.importers = commit(engine, { "main.ts": withValue(importersValue) }, "importers");
    commits.importerGained = commit(engine, { "main.ts": withValue({ ...importersValue, files: [{ ...importedA, importers: [...importedA.importers, "src/d.ts"] }, importedC] }) }, "importer gained");
    git(engine, "checkout", "--quiet", "--detach", commits.importers);
    commits.importerDropped = commit(engine, { "main.ts": withValue({ ...importersValue, files: [importedA, { ...importedC, importers: [] }] }) }, "importer dropped");
    git(engine, "checkout", "--quiet", "--detach", commits.importers);
    commits.effectChanged = commit(engine, { "main.ts": withValue({ ...importersValue, effects: [{ ...importersValue.effects[0], operation: "load" }] }) }, "effect changed");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    commits.occurrences = commit(engine, { "main.ts": callersEngine(callersFact(listedSymbols)) }, "occurrences");
    commits.occurrencesSame = commit(engine, { "main.ts": `// same occurrences\n${callersEngine(callersFact(listedSymbols))}` }, "same occurrences");
    git(engine, "checkout", "--quiet", "--detach", commits.occurrences);
    commits.occurrenceListed = commit(engine, { "main.ts": callersEngine(callersFact([...listedSymbols, declaration("src/Silent.java", "Silent", 3)])) }, "occurrence listed");
    git(engine, "checkout", "--quiet", "--detach", commits.occurrences);
    const bounded = callersFact(listedSymbols);
    commits.occurrencesBounded = commit(engine, { "main.ts": callersEngine({ ...bounded, cuts: [...bounded.cuts, { kind: "depth", at: ["src/Listed.java::Listed"], limit: 1, reason: "depth", reach: { kind: "anything" } }] }) }, "occurrences bounded");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    commits.occurrenceRules = commit(engine, { "main.ts": callersEngine(rulesFact) }, "occurrence rules");
    commits.occurrenceRulesSame = commit(engine, { "main.ts": `// same rules\n${callersEngine(rulesFact)}` }, "same occurrence rules");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    store = join(engine, ".git", "corpus-gate");

    const sources = join(root, "corpus", "src");
    for (const directory of ["src", "docs"]) mkdirSync(join(sources, directory), { recursive: true });
    git(sources, "init", "--quiet");
    const sourcesSha = commit(sources, OCCURRENCE_SOURCES, "sources");
    const rules = join(root, "corpus", "rules");
    for (const directory of ["docs", "src/lib", "src/legacy", "src/main/java/app/store", "src/main/java/app/config", "src/main/java/app/other", "src/test/java/app"]) mkdirSync(join(rules, directory), { recursive: true });
    git(rules, "init", "--quiet");
    const rulesSha = commit(rules, RULE_SOURCES, "rules");

    manifest = join(root, "manifest", "corpus.json");
    mkdirSync(join(root, "manifest"));
    writeFileSync(manifest, JSON.stringify({
      groups: [{
        id: "g",
        repos: [{ id: "app", path: "../corpus/app", sha: corpusSha }],
        workspace: { launch: "app", members: [] },
        queries: [
          { id: "list", family: "files", argv: ["list", "{repo:app}"] },
          { id: "list-trusted", family: "files", trusted: true, argv: ["list", "{repo:app}"] },
        ],
      }],
    }));
    parallelManifest = join(root, "manifest", "parallel.json");
    writeFileSync(parallelManifest, JSON.stringify({
      groups: [
        { id: "first", repos: [{ id: "app", path: "../corpus/app", sha: corpusSha }], queries: [{ id: "list", family: "files", argv: ["list", "{repo:app}"] }] },
        { id: "second", repos: [{ id: "b", path: "../corpus/second", sha: secondSha }], queries: [{ id: "list", family: "files", argv: ["list", "{repo:b}"] }] },
      ],
    }));

    occurrenceManifest = join(root, "manifest", "occurrences.json");
    writeFileSync(occurrenceManifest, JSON.stringify({
      groups: [{
        id: "occ",
        repos: [{ id: "src", path: "../corpus/src", sha: sourcesSha }],
        queries: [
          { id: "callers", family: "callers", argv: ["callers", "{repo:src}"] },
          { id: "broken", family: "callers", argv: ["broken", "{repo:src}"] },
          { id: "unknown", family: "callers", argv: ["unknown", "{repo:src}"] },
          { id: "list", family: "files", argv: ["list", "{repo:src}"] },
        ],
      }],
    }));

    rulesManifest = join(root, "manifest", "rules.json");
    writeFileSync(rulesManifest, JSON.stringify({ groups: [{ id: "rules", repos: [{ id: "src", path: "../corpus/rules", sha: rulesSha }], queries: [{ id: "callers", family: "callers", argv: ["callers", "{repo:src}"] }] }] }));

    workspaceManifest = join(root, "manifest", "workspace.json");
    const workspaceGroup = (query: object) => ({
      groups: [{
        id: "w",
        repos: [{ id: "app", path: "../corpus/app", sha: corpusSha }, { id: "b", path: "../corpus/second", sha: secondSha }],
        workspace: { launch: "app", members: ["b"] },
        queries: [query],
      }],
    });
    writeFileSync(workspaceManifest, JSON.stringify(workspaceGroup({ id: "trace", family: "files", trusted: true, argv: ["list", "--workspace", "{workspace}", "{repo:app}"] })));
    writeFileSync(join(root, "manifest", "untrusted-workspace.json"), JSON.stringify(workspaceGroup({ id: "trace", family: "files", argv: ["list", "--workspace", "{workspace}", "{repo:app}"] })));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  async function gateWith(corpusManifest: string, ...args: string[]) {
    const out: string[] = [];
    const errs: string[] = [];
    const code = await runGate(["--corpus", corpusManifest, "--engine", engine, ...args], { out: (line) => out.push(line), err: (line) => errs.push(line) });
    const markdownFile = out.find((line) => line.startsWith("report: "))?.slice("report: ".length);
    const reportFile = markdownFile?.replace(/report\.md$/u, "report.json");
    return { code, out, errs, report: reportFile === undefined ? undefined : JSON.parse(readFileSync(reportFile, "utf8")), markdown: markdownFile === undefined ? undefined : readFileSync(markdownFile, "utf8") };
  }

  const gate = (...args: string[]) => gateWith(manifest, ...args);

  const tree = (rev: string) => git(engine, "rev-parse", `${rev}^{tree}`);

  it("passes engines that answer alike, shows both the same paths, records the pass, and leaves the corpus untouched", async () => {
    const corpusBefore = [git(corpus, "status", "--porcelain", "--ignored"), git(corpus, "for-each-ref"), git(corpus, "worktree", "list")];
    const { code, report, out } = await gate("--base", commits.base, "--candidate", commits.same);
    assert.equal(code, EXIT.pass);
    assert.equal(report.counts.differing, 0);
    assert.ok(existsSync(passMarkerPath(join(engine, ".git"), tree(commits.base), tree(commits.same))));
    assert.ok(out.some((line) => line.startsWith("Corpus-Gate: pass ")));
    assert.deepEqual([git(corpus, "status", "--porcelain", "--ignored"), git(corpus, "for-each-ref"), git(corpus, "worktree", "list")], corpusBefore);
    const answers = JSON.parse(readFileSync(join(report.candidate.answers, "answers.json"), "utf8")) as Answer[];
    assert.deepEqual(answers.filter((answer) => answer.exit !== 0).map((answer) => answer.id), []);
    const byId = new Map(answers.map((answer) => [answer.id, answer.stdout as { trusted: boolean; protocols: string; repo: string }]));
    assert.equal(byId.get("g/list")?.trusted, false);
    assert.equal(byId.get("g/list-trusted")?.trusted, true);
    assert.equal(byId.get("g/list")?.protocols, "file");
    assert.equal(git(engine, "worktree", "list").split("\n").length, 1);
  });

  it("fails an added element under none and passes it under its family's +, reusing the answers of the base", async () => {
    const failed = await gate("--base", commits.base, "--candidate", commits.adds);
    assert.equal(failed.code, EXIT.fail);
    assert.deepEqual(failed.report.violations.map((violation: { rule: string }) => violation.rule), ["undeclared-family", "undeclared-family"]);
    assert.equal(existsSync(passMarkerPath(join(engine, ".git"), tree(commits.base), tree(commits.adds))), false);

    const passed = await gate("--base", commits.base, "--candidate", commits.adds, "--expect", "files:+");
    assert.equal(passed.code, EXIT.pass);
    assert.equal(passed.report.base.cached, true);
    assert.equal(passed.report.families[0].added, 2);
  });

  it("reports the cut ledger without failing on it, and fails a declared reason that did not move as declared", async () => {
    const informative = await gate("--base", commits.base, "--candidate", commits.cuts, "--expect", "files:±");
    assert.equal(informative.code, EXIT.pass);
    assert.deepEqual(informative.report.ledger.difference.rows.map((row: { family: string; language: string; reason: string; candidate: { cuts: number } }) => [row.family, row.language, row.reason, row.candidate.cuts]), [["files", "typescript", "depth", 2]]);
    assert.equal((await gate("--base", commits.base, "--candidate", commits.cuts, "--expect", "files:±", "--expect-cuts", "depth:+")).code, EXIT.pass);

    const refuted = await gate("--base", commits.base, "--candidate", commits.cuts, "--expect", "files:±", "--expect-cuts", "depth:-");
    assert.equal(refuted.code, EXIT.fail);
    assert.deepEqual(refuted.report.cutViolations.map((violation: { reason: string; rule: string }) => [violation.reason, violation.rule]), [["depth", "cuts-not-as-declared"]]);
    assert.ok(refuted.out.some((line) => line.startsWith("Corpus-Gate: fail ") && line.endsWith(" expect-cuts=depth:-")));
    assert.equal(existsSync(passMarkerPath(join(engine, ".git"), tree(commits.base), tree(commits.cuts))), false);
  });

  const valueRows = (rows: ValueRow[], ...fields: ("entries" | "gained" | "lost" | "changed")[]) => rows.map((row) => [row.family, row.language, row.collection, ...fields.map((field) => row[field])]);

  it("reports the entries a candidate gained while every cut count stayed equal, by family, language and collection, sorted", async () => {
    const { code, report, markdown } = await gate("--base", commits.values, "--candidate", commits.valuesGained, "--expect", "files:+");
    assert.equal(code, EXIT.pass);
    assert.deepEqual(report.ledger.difference.totals, { base: 0, candidate: 0 });
    assert.deepEqual(valueRows(report.values.difference.rows, "gained", "lost", "changed"), [["files", "typescript", "entrypoints", 2, 0, 0], ["files", "typescript", "symbols", 2, 0, 0]]);
    assert.deepEqual(valueRows(report.values.base.rows, "entries"), [
      ["files", "java", "symbols", 2],
      ["files", "typescript", "entrypoints", 2],
      ["files", "typescript", "readingPlan/ranges", 2],
      ["files", "typescript", "symbols", 2],
    ]);
    assert.deepEqual([report.values.base.entries, report.values.candidate.entries, report.values.difference.totals], [8, 12, { gained: 4, lost: 0, changed: 0 }]);
    assert.ok(markdown?.includes("| files | typescript | symbols | 2 | 0 | 0 |"));
    const again = await gate("--base", commits.values, "--candidate", commits.valuesGained, "--expect", "files:+");
    assert.equal(JSON.stringify(again.report.values), JSON.stringify(report.values));
  });

  it("identifies an entry by its place, so one reached at another depth, confidence and via is changed, neither lost nor gained", async () => {
    const { report, markdown } = await gate("--base", commits.values, "--candidate", commits.valuesChanged, "--expect", "files:±");
    assert.deepEqual(valueRows(report.values.difference.rows, "gained", "lost", "changed"), [["files", "typescript", "symbols", 4, 0, 2]]);
    assert.deepEqual([report.values.base.entries, report.values.candidate.entries, report.values.difference.totals], [8, 12, { gained: 4, lost: 0, changed: 2 }]);
    assert.ok(markdown?.includes("entries 8 → 12, gained 4, lost 0, changed 2;"));
  });

  it("counts an importer a file gained in the nested collection, the file as changed, and no loss anywhere", async () => {
    const { report } = await gate("--base", commits.importers, "--candidate", commits.importerGained, "--expect", "files:±");
    assert.deepEqual(valueRows(report.values.difference.rows, "gained", "lost", "changed"), [["files", "typescript", "files", 0, 0, 2], ["files", "typescript", "files/importers", 2, 0, 0]]);
  });

  it("identifies a nested entry with the entry that holds it, so the same importer under two files is two entries", async () => {
    const { report } = await gate("--base", commits.importers, "--candidate", commits.importerDropped, "--expect", "files:±");
    assert.deepEqual(valueRows(report.values.base.rows, "entries"), [["files", "none", "effects", 2], ["files", "typescript", "files", 4], ["files", "typescript", "files/importers", 4]]);
    assert.deepEqual(valueRows(report.values.difference.rows, "gained", "lost", "changed"), [["files", "typescript", "files", 0, 0, 2], ["files", "typescript", "files/importers", 0, 2, 0]]);
  });

  it("identifies an entry that states no place by its whole content, so a modified one is one lost and one gained", async () => {
    const { report } = await gate("--base", commits.importers, "--candidate", commits.effectChanged, "--expect", "files:±");
    assert.deepEqual(valueRows(report.values.difference.rows, "gained", "lost", "changed"), [["files", "none", "effects", 2, 2, 0]]);
  });

  it("counts no entry of an answer that exited non-zero or printed no JSON, and still writes the report", async () => {
    const { code, report } = await gate("--base", commits.values, "--candidate", commits.valuesUnread, "--expect", "files:±");
    assert.equal(code, EXIT.fail);
    assert.deepEqual([report.values.candidate.rows, report.values.candidate.entries], [[], 0]);
    assert.deepEqual(report.values.difference.totals, { gained: 0, lost: 8, changed: 0 });
  });

  it("gives an empty value difference to sides whose answers hold the same entries", async () => {
    const { report } = await gate("--base", commits.values, "--candidate", commits.valuesSame);
    assert.equal(report.values.candidate.entries, 8);
    assert.deepEqual(report.values.difference, { rows: [], totals: { gained: 0, lost: 0, changed: 0 } });
  });

  interface OccurrenceRow { family: string; language: string; base: Record<string, number>; candidate: Record<string, number> }
  interface Lead { family: string; language: string; answer: string; target: string; file: string; line: number; text: string }
  const occurrenceGate = (candidate: string, ...args: string[]) => gateWith(occurrenceManifest, "--base", commits.occurrences, "--candidate", candidate, ...args);
  const classesOf = (report: { occurrences: { rows: OccurrenceRow[] } }, side: "base" | "candidate") => report.occurrences.rows.map((row) => [row.family, row.language, row[side]]);
  const place = (lead: Lead) => `${lead.file}:${lead.line}`;
  const leadsFile = (report: { occurrences: { leads: string } }) => readFileSync(report.occurrences.leads, "utf8");
  const counts = (some: Record<string, number>) => ({ ...Object.fromEntries(OCCURRENCE_CLASSES.map((name) => [name, 0])), ...some });

  it("classes an occurrence no listed declaration and no cut accounts for as unaccounted, and lists it among the leads with its place", async () => {
    const { report, markdown } = await occurrenceGate(commits.occurrencesSame);
    assert.deepEqual(report.occurrences.candidate.unaccounted.map(place), ["src/Silent.java:2"]);
    assert.deepEqual(report.occurrences.candidate.unaccounted[0], { family: "callers", language: "java", answer: "occ/callers", target: "src/Target.java::Target", file: "src/Silent.java", line: 2, text: "Object held = new Target();", fileListed: false });
    assert.ok(leadsFile(report).includes("occ/callers\tsrc/Target.java::Target\tsrc/Silent.java:2\tunlisted-file\tObject held = new Target();\n"));
    assert.ok(markdown?.includes("unaccounted occurrences 1 → 1."));
  });

  it("classes an occurrence inside a listed declaration, at a place a symbol's via, an entrypoint or a route names, or in a reached module's file as listed; at a cut's place, a call-at place, a module importer or under a runtime reach as cut; outside the declared languages or globs as out of scope", async () => {
    const { report } = await occurrenceGate(commits.occurrencesSame);
    assert.deepEqual(classesOf(report, "candidate"), [
      ["callers", "java", counts({ target: 2, listed: 3, cut: 3, "out-of-scope": 1, text: 1, unaccounted: 1 })],
      ["callers", "typescript", counts({ target: 1, listed: 2, cut: 1 })],
    ]);
  });

  it("classes an occurrence in the target's own lines as target", async () => {
    const { report } = await occurrenceGate(commits.occurrencesSame);
    assert.equal(report.occurrences.rows[0].base.target, 2);
  });

  it("reports an occurrence a newly listed dependent accounts for as having left the unaccounted class", async () => {
    const { report, markdown } = await occurrenceGate(commits.occurrenceListed, "--expect", "callers:±");
    assert.deepEqual(report.occurrences.difference.rows.map((row: { family: string; language: string; base: number; candidate: number; left: Lead[]; entered: Lead[] }) => [row.family, row.language, row.base, row.candidate, row.left.map(place), row.entered.map(place)]), [["callers", "java", 1, 0, ["src/Silent.java:2"], []], ["callers", "typescript", 0, 0, [], []]]);
    assert.deepEqual(classesOf(report, "candidate")[0], ["callers", "java", counts({ target: 2, listed: 4, cut: 3, "out-of-scope": 1, text: 1 })]);
    assert.ok(markdown?.includes("unaccounted occurrences 1 → 0."));
  });

  it("classes every line the answer does not list as cut under a cut whose reach is anything in any runtime", async () => {
    const { report } = await occurrenceGate(commits.occurrencesBounded, "--expect", "callers:±");
    assert.deepEqual(classesOf(report, "candidate"), [["callers", "java", counts({ target: 2, listed: 3, cut: 6 })], ["callers", "typescript", counts({ target: 1, listed: 2, cut: 1 })]]);
  });

  it("takes no occurrence from a family without declaration targets, from an answer that is not a fact or from an unknown one", async () => {
    const { code, report } = await occurrenceGate(commits.occurrencesSame);
    assert.equal(code, EXIT.pass);
    assert.deepEqual([...new Set(report.occurrences.rows.map((row: OccurrenceRow) => row.family))], ["callers"]);
    assert.deepEqual(report.occurrences.candidate.answers, 1);
  });

  it("gives the same occurrence report, leads and set-apart bytes to the same inputs", async () => {
    const first = await rulesGate();
    const firstFiles = [leadsFile(first.report), readFileSync(first.report.occurrences.setApart, "utf8")];
    const second = await rulesGate();
    assert.equal(JSON.stringify(second.report.occurrences), JSON.stringify(first.report.occurrences));
    assert.deepEqual([leadsFile(second.report), readFileSync(second.report.occurrences.setApart, "utf8")], firstFiles);
  });

  const rulesGate = () => gateWith(rulesManifest, "--base", commits.occurrenceRules, "--candidate", commits.occurrenceRulesSame);
  /** Each line the rules answer leaves unaccounted or sets apart, as `class target-name place`, in report order. */
  const linesOf = (report: { occurrences: { candidate: { unaccounted: Lead[] }; setApart: string } }) => [
    ...report.occurrences.candidate.unaccounted.map((lead) => `unaccounted ${lead.target.slice(lead.target.indexOf("::") + 2)} ${place(lead)}`),
    ...readFileSync(report.occurrences.setApart, "utf8").split("\n").slice(1).filter(Boolean).map((row) => {
      const [kind, , target, at] = row.split("\t");
      return `${kind} ${target!.slice(target!.indexOf("::") + 2)} ${at}`;
    }),
  ];
  let rules: { report: { occurrences: { rows: OccurrenceRow[]; candidate: { unaccounted: Lead[] }; setApart: string } }; markdown: string | undefined; lines: string[] };
  const rulesRun = async () => {
    if (rules === undefined) {
      const { report, markdown } = await rulesGate();
      rules = { report, markdown, lines: linesOf(report) };
    }
    return rules;
  };
  const linesIn = (lines: string[], file: string) => lines.filter((line) => line.endsWith(` ${file}`) || line.includes(` ${file}:`));

  it("counts an occurrence only in a file of the target's own runtime", async () => {
    const { report, lines } = await rulesRun();
    assert.deepEqual(linesIn(lines, "src/main/java/app/Mention.java"), []);
    assert.deepEqual(classesOf(report, "candidate"), [
      ["callers", "java", counts({ target: 2, cut: 1, "cut-by-reach": 1, "test-source": 1, text: 1, "cannot-name": 1, unaccounted: 5 })],
      ["callers", "typescript", counts({ target: 1, listed: 3, "unnamed-markup": 1, "test-source": 1, text: 3, "cannot-name": 2, unaccounted: 8 })],
    ]);
  });

  it("sets apart a line of a test source, by the engine's own test predicate, as test-source", async () => {
    const { lines } = await rulesRun();
    assert.deepEqual(lines.filter((line) => line.startsWith("test-source ")), ["test-source Code src/codes.spec.ts:1", "test-source Store src/test/java/app/StoreTest.java:2"]);
  });

  it("reads a template where a component names it: listed under a listed component, nameable through its component, and a markup file no component names as unnamed-markup", async () => {
    const { lines } = await rulesRun();
    assert.deepEqual(linesIn(lines, "src/app.component.html"), []);
    assert.deepEqual(linesIn(lines, "docs/page.html"), ["unnamed-markup Code docs/page.html:1"]);
    assert.deepEqual(linesIn(lines, "src/named.component.html"), ["unaccounted Code src/named.component.html:1"]);
    assert.deepEqual(linesIn(lines, "src/other.component.html"), ["cannot-name Code src/other.component.html:1"]);
  });

  it("counts the import statement and the decorator lines of a file whose declaration the answer lists as listed, and no other line of that file", async () => {
    const { lines } = await rulesRun();
    assert.deepEqual(linesIn(lines, "src/shown.ts"), ["unaccounted Code src/shown.ts:9"]);
  });

  it("sets apart a line that writes the name only in comments and string literals as text, and leaves one inside a template literal with an expression unaccounted", async () => {
    const { lines } = await rulesRun();
    assert.deepEqual([...linesIn(lines, "src/comment.ts"), ...linesIn(lines, "src/main/java/app/store/Neighbor.java")].sort(), [
      "text Code src/comment.ts:2", "text Code src/comment.ts:3", "text Code src/comment.ts:5", "text Store src/main/java/app/store/Neighbor.java:4",
      "unaccounted Code src/comment.ts:1", "unaccounted Code src/comment.ts:4", "unaccounted Store src/main/java/app/store/Neighbor.java:3",
    ]);
  });

  it("leaves unaccounted only a line whose file can name the target, through an alias and a barrel, an import the reader cannot prove names no file, the same package, an import of the type or its package, or the qualified name, and sets apart the others as cannot-name", async () => {
    const { lines } = await rulesRun();
    assert.deepEqual(lines.filter((line) => line.startsWith("cannot-name ")), ["cannot-name Code src/homonym.ts:1", "cannot-name Code src/other.component.html:1", "cannot-name Store src/main/java/app/other/Elsewhere.java:3"]);
    assert.deepEqual(lines.filter((line) => line.startsWith("unaccounted ")), [
      "unaccounted Code src/alias-user.ts:1", "unaccounted Code src/alias-user.ts:2", "unaccounted Code src/comment.ts:1", "unaccounted Code src/comment.ts:4",
      "unaccounted Code src/legacy/unproven.ts:2", "unaccounted Code src/named.component.html:1", "unaccounted Code src/named.component.ts:2", "unaccounted Code src/shown.ts:9",
      "unaccounted Store src/main/java/app/config/Imported.java:2", "unaccounted Store src/main/java/app/config/Imported.java:4", "unaccounted Store src/main/java/app/config/Qualified.java:3",
      "unaccounted Store src/main/java/app/other/Wild.java:4", "unaccounted Store src/main/java/app/store/Neighbor.java:3",
    ]);
  });

  it("sets apart every line under a cut whose callers-of reach lists the target as cut-by-reach, apart from the cut's own place and from other targets", async () => {
    const { lines, report } = await rulesRun();
    assert.deepEqual(lines.filter((line) => line.startsWith("cut-by-reach ")), ["cut-by-reach Repo src/main/java/app/store/Holder.java:4"]);
    assert.equal(report.occurrences.rows[0]!.candidate.cut, 1);
  });

  it("prints every class per family, language and side, and names the set-apart file", async () => {
    const { markdown, report } = await rulesRun();
    assert.ok(markdown?.includes("| callers | typescript | candidate | 1 | 3 | 1 | 0 | 0 | 0 | 1 | 3 | 2 | 8 |"));
    assert.ok(markdown?.includes(report.occurrences.setApart));
  });

  it("faults on a cut reason outside the facts contract before writing a report", async () => {
    const { code, report } = await gate("--base", commits.base, "--candidate", commits.unknownCut, "--expect", "files:±");
    assert.equal(code, EXIT.fault);
    assert.equal(report, undefined);
  });

  it("refuses a revision whose lockfile is not the installed one, before running anything", async () => {
    const { code, report } = await gate("--base", commits.base, "--candidate", commits.lockfile);
    assert.equal(code, EXIT.fault);
    assert.equal(report, undefined);
  });

  it("refuses to run while another run holds the lock", async () => {
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "lock"), "1\n");
    try {
      assert.equal((await gate("--base", commits.base, "--candidate", commits.same)).code, EXIT.fault);
    } finally {
      rmSync(join(store, "lock"));
    }
  });

  it("parallel groups retain manifest order in the answer file", async () => {
    const { code, report } = await gateWith(parallelManifest, "--base", commits.base, "--candidate", commits.same, "--concurrency", "2");
    assert.equal(code, EXIT.pass);
    assert.equal(report.counts.differing, 0);
    const answers = JSON.parse(readFileSync(join(report.candidate.answers, "answers.json"), "utf8")) as Answer[];
    assert.deepEqual(answers.map((answer) => answer.id), ["first/list", "second/list"]);
  });

  it("hands a trusted query the declared workspace with each member at its own clone, and refuses it elsewhere", async () => {
    const { code, report } = await gateWith(workspaceManifest, "--base", commits.base, "--candidate", commits.same);
    assert.equal(code, EXIT.pass);
    const answers = JSON.parse(readFileSync(join(report.candidate.answers, "answers.json"), "utf8")) as Answer[];
    const traced = answers.find((answer) => answer.id === "w/trace")?.stdout as { members: string[]; trusted: boolean };
    assert.deepEqual([traced.trusted, traced.members.map((member) => member.split("/").slice(-3).join("/"))], [true, ["trusted/w/b"]]);
    const refused = await gateWith(join(root, "manifest", "untrusted-workspace.json"), "--base", commits.base, "--candidate", commits.same);
    assert.equal(refused.code, EXIT.fault);
  });

  it("adds a query's candidate arguments on the candidate side only, so their effect is a declared difference", async () => {
    const candidateArgsManifest = join(root, "manifest", "candidate-args.json");
    const declared = JSON.parse(readFileSync(parallelManifest, "utf8"));
    declared.groups[0].queries[0].candidateArgs = ["--extra", "value"];
    writeFileSync(candidateArgsManifest, JSON.stringify(declared));
    assert.equal((await gateWith(candidateArgsManifest, "--base", commits.same, "--candidate", commits.base, "--expect", "files:±")).code, EXIT.pass);
    const undeclared = await gateWith(candidateArgsManifest, "--base", commits.base, "--candidate", commits.same);
    assert.equal(undeclared.code, EXIT.fail);
    const { code, report } = await gateWith(candidateArgsManifest, "--base", commits.base, "--candidate", commits.same, "--expect", "files:±");
    assert.equal(code, EXIT.pass);
    const optionsOf = (side: { answers: string }) => (JSON.parse(readFileSync(join(side.answers, "answers.json"), "utf8")) as Answer[]).map((answer) => (answer.stdout as { options: string[] }).options);
    assert.deepEqual(optionsOf(report.base), [[], []]);
    assert.deepEqual(optionsOf(report.candidate), [["--extra", "value"], []]);
  });

  it("refuses a concurrency that is not a positive integer", async () => {
    assert.equal((await gate("--base", commits.base, "--candidate", commits.same, "--concurrency", "0")).code, EXIT.usage);
    assert.equal((await gate("--base", commits.base, "--candidate", commits.same, "--concurrency", "two")).code, EXIT.usage);
  });
});

it("group concurrency is bounded while completion order never reorders results", async () => {
  const releases = [0, 1, 2].map(() => Promise.withResolvers<string>());
  const thirdStarted = Promise.withResolvers<void>();
  const completed = [0, 1, 2].map(() => Promise.withResolvers<void>());
  const starts: number[] = [];
  const finishes: number[] = [];
  const running = runGroups([0, 1, 2], 2, async (index) => {
    starts.push(index);
    if (index === 2) thirdStarted.resolve();
    const value = await releases[index]!.promise;
    finishes.push(index);
    completed[index]!.resolve();
    return value;
  });
  try {
    assert.deepEqual(starts, [0, 1]);
    releases[1]!.resolve("second");
    await thirdStarted.promise;
    assert.deepEqual(starts, [0, 1, 2]);
    releases[2]!.resolve("third");
    await completed[2]!.promise;
    releases[0]!.resolve("first");
    assert.deepEqual(await running, ["first", "second", "third"]);
    assert.deepEqual(finishes, [1, 2, 0]);
  } finally {
    for (const release of releases) release.resolve("cleanup");
    await running;
  }
});
