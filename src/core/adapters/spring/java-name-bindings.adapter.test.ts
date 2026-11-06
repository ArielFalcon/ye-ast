import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { RootOrigin } from "../../domain/impact/edge-policy.ts";
import type { ResolvedNameSite } from "../../ports/import-origins.port.ts";

const USER: SourceFile = { path: "src/main/java/app/domain/User.java", content: "package app.domain;\n\npublic class User {}\n" };
const LOCAL_USER: SourceFile = { path: "src/main/java/app/service/User.java", content: "package app.service;\n\npublic class User {}\n" };
const LIMITS: SourceFile = { path: "src/main/java/app/other/Limits.java", content: "package app.other;\n\npublic class Limits {\n  public static int limit() { return 1; }\n}\n" };
const MORE: SourceFile = { path: "src/main/java/app/more/Limits.java", content: "package app.more;\n\npublic class Limits {}\n" };

function java(path: string, lines: readonly string[]): SourceFile {
  return { path, content: `${lines.join("\n")}\n` };
}

/** The site the graph writes at the `occurrence`-th `needle` of `source`: 1-based, on the needle's first character. */
function at(source: SourceFile, needle: string, kind: string, name: string, occurrence = 1): ResolvedNameSite {
  const lines = source.content.split("\n");
  let seen = 0;
  for (const [index, text] of lines.entries()) {
    for (let column = text.indexOf(needle); column >= 0; column = text.indexOf(needle, column + 1)) {
      if (++seen === occurrence) return { file: source.path, line: index + 1, column: column + 1, kind, name };
    }
  }
  throw new Error(`${needle} is not in ${source.path}`);
}

async function rootOf(sources: readonly SourceFile[], site: ResolvedNameSite): Promise<RootOrigin> {
  const [root] = await createJavaNameBindings(createJavaParser, sources).rootOrigins([site]);
  assert.ok(root !== undefined);
  return root;
}

const unknownAt = (site: ResolvedNameSite): RootOrigin => ({ status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] });

test("a type name spelled with a platform package is rooted outside the repository, whatever the file imports by its simple name", async () => {
  const use = java("src/main/java/app/service/Accounts.java", ["package app.service;", "", "import app.domain.User;", "", "class Accounts {", "  org.springframework.security.core.userdetails.User build(User user) { return null; }", "}"]);
  const site = at(use, "User build", "references", "User");

  assert.deepEqual(await rootOf([USER, use], site), { status: "complete", value: { kind: "external", module: "org.springframework.security.core.userdetails" }, evidence: [{ path: use.path, line: site.line }] });
});

test("a type name a single import binds to a platform type is rooted outside the repository, and bare", async () => {
  const use = java("src/main/java/app/api/Accounts.java", ["package app.api;", "", "import org.springframework.security.core.userdetails.User;", "", "class Accounts {", "  User load() { return new User(); }", "}"]);
  const site = at(use, "new", "instantiates", "User");

  assert.deepEqual(await rootOf([USER, use], site), { status: "complete", value: { kind: "external", module: "org.springframework.security.core.userdetails" }, bare: true, evidence: [{ path: use.path, line: site.line }] });
});

test("a type name a single import binds to a type of the repository is rooted at its file, and bare", async () => {
  const use = java("src/main/java/app/api/Accounts.java", ["package app.api;", "", "import app.domain.User;", "", "class Accounts {", "  User load() { return null; }", "}"]);
  const site = at(use, "User load", "references", "User");

  assert.deepEqual(await rootOf([USER, use], site), { status: "complete", value: { kind: "repository", file: USER.path, declared: "app.domain.User" }, bare: true, evidence: [{ path: use.path, line: site.line }] });
});

test("a type of the file's own package wins over a type an on-demand import offers", async () => {
  const use = java("src/main/java/app/service/Accounts.java", ["package app.service;", "", "import app.domain.*;", "", "class Accounts {", "  User load() { return null; }", "}"]);
  const site = at(use, "User load", "references", "User");

  assert.deepEqual(await rootOf([USER, LOCAL_USER, use], site), { status: "complete", value: { kind: "repository", file: LOCAL_USER.path, declared: "app.service.User" }, bare: true, evidence: [{ path: use.path, line: site.line }] });
});

test("a member type of the enclosing class, a record included, is rooted at the file that declares it, by its containment path", async () => {
  const use = java("src/main/java/app/web/VisitResource.java", ["package app.web;", "", "class VisitResource {", "  Visits read() { return new Visits(); }", "", "  record Visits() {}", "}"]);
  const site = at(use, "Visits read", "references", "Visits");

  assert.deepEqual(await rootOf([use], site), { status: "complete", value: { kind: "repository", file: use.path, declared: "app.web.VisitResource.Visits" }, bare: true, evidence: [{ path: use.path, line: site.line }] });
});

test("a nested type that shadows an import of the same name proves nothing about the name", async () => {
  const use = java("src/main/java/app/api/Accounts.java", ["package app.api;", "", "import app.domain.User;", "", "class Accounts {", "  static class User {}", "  User load() { return null; }", "}"]);
  const site = at(use, "User load", "references", "User");

  assert.deepEqual(await rootOf([USER, use], site), unknownAt(site));
});

test("a simple type name inside a class with a supertype the snapshot does not declare proves nothing, since a platform supertype may declare a member type of the name", async () => {
  const use = java("src/main/java/app/api/Accounts.java", ["package app.api;", "", "import app.domain.User;", "", "class Accounts extends org.springframework.web.Base {", "  User load() { return null; }", "}"]);
  const site = at(use, "User load", "references", "User");

  assert.deepEqual(await rootOf([USER, use], site), unknownAt(site));
});

test("a name only on-demand imports offer is bound only when exactly one of them declares it and every other is a package of the repository", async () => {
  const both = java("src/main/java/app/api/Both.java", ["package app.api;", "", "import app.other.*;", "import app.more.*;", "", "class Both {", "  Limits limits;", "}"]);
  const external = java("src/main/java/app/api/External.java", ["package app.api;", "", "import app.other.*;", "import com.acme.*;", "", "class External {", "  Limits limits;", "}"]);
  const single = java("src/main/java/app/api/Single.java", ["package app.api;", "", "import app.other.*;", "", "class Single {", "  Limits limits;", "}"]);
  const sources = [LIMITS, MORE, both, external, single];

  assert.deepEqual(await rootOf(sources, at(both, "Limits", "references", "Limits")), unknownAt(at(both, "Limits", "references", "Limits")));
  assert.deepEqual(await rootOf(sources, at(external, "Limits", "references", "Limits")), unknownAt(at(external, "Limits", "references", "Limits")));
  assert.deepEqual((await rootOf(sources, at(single, "Limits", "references", "Limits"))).status, "complete");
});

test("a call on a type name is rooted at that type and is not bare", async () => {
  const use = java("src/main/java/app/api/Meter.java", ["package app.api;", "", "import app.other.Limits;", "", "class Meter {", "  int a() { return Limits.limit(); }", "}"]);
  const site = at(use, "Limits.limit", "calls", "limit");

  assert.deepEqual(await rootOf([LIMITS, use], site), { status: "complete", value: { kind: "repository", file: LIMITS.path, declared: "app.other.Limits" }, evidence: [{ path: use.path, line: site.line }] });
});

test("a call whose receiver a variable of the same name as a type holds proves nothing about the type", async () => {
  const use = java("src/main/java/app/api/Meter.java", ["package app.api;", "", "import app.other.Limits;", "", "class Meter {", "  int a(Object Limits) { return Limits.limit(); }", "}"]);
  const site = at(use, "Limits.limit", "calls", "limit");

  assert.deepEqual(await rootOf([LIMITS, use], site), unknownAt(site));
  const pattern = java("src/main/java/app/api/Pattern.java", ["package app.api;", "", "import app.other.Limits;", "", "class Pattern {", "  int a(Object o) { return o instanceof Object Limits ? Limits.limit() : 0; }", "}"]);
  const patternSite = at(pattern, "Limits.limit", "calls", "limit");
  assert.deepEqual(await rootOf([LIMITS, pattern], patternSite), unknownAt(patternSite));
});

test("a static import, which may import a member type of the name, proves nothing about a name it may bind", async () => {
  const sibling: SourceFile = { path: "src/main/java/app/api/Limits.java", content: "package app.api;\n\npublic class Limits {}\n" };
  const single = java("src/main/java/app/api/Single.java", ["package app.api;", "", "import static app.other.Holder.Limits;", "", "class Single {", "  Limits limits;", "}"]);
  const onDemand = java("src/main/java/app/api/OnDemand.java", ["package app.api;", "", "import app.other.*;", "import static app.more.Holder.*;", "", "class OnDemand {", "  Limits limits;", "}"]);
  const singleSite = at(single, "Limits limits", "references", "Limits");
  const onDemandSite = at(onDemand, "Limits limits", "references", "Limits");

  assert.deepEqual(await rootOf([LIMITS, sibling, single], singleSite), unknownAt(singleSite));
  assert.deepEqual(await rootOf([LIMITS, onDemand], onDemandSite), unknownAt(onDemandSite));
});

test("a name inside a class whose declaration the reader does not place, anonymous or local, proves nothing", async () => {
  const use = java("src/main/java/app/api/Meter.java", ["package app.api;", "", "import app.other.Limits;", "", "class Meter {", "  Object a() {", "    return new Object() {", "      Limits limits;", "    };", "  }", "}"]);
  const site = at(use, "Limits limits", "references", "Limits");

  assert.deepEqual(await rootOf([LIMITS, use], site), unknownAt(site));
});

test("a site that spells another name, a bare call, or a file the parser rejects proves nothing", async () => {
  const use = java("src/main/java/app/api/Meter.java", ["package app.api;", "", "import app.other.Limits;", "", "class Meter {", "  int a() { return limit(); }", "  Limits b() { return null; }", "}"]);
  const broken = java("src/main/java/app/api/Broken.java", ["package app.api;", "import app.other.Limits;", "class {"]);
  const sites = [at(use, "limit()", "calls", "limit"), { ...at(use, "Limits b", "references", "Limits"), name: "Other" }, { file: broken.path, line: 2, column: 18, kind: "references", name: "Limits" }];

  assert.deepEqual(await createJavaNameBindings(createJavaParser, [LIMITS, use, broken]).rootOrigins(sites), sites.map(unknownAt));
});
