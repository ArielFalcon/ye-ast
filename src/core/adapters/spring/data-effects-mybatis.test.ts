import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaDataEffects } from "./data-effects.adapter.ts";

const PATHS: Readonly<Record<string, string>> = {
  "UserMapper.java": "src/main/java/shop/mapper/UserMapper.java", "UserMapper.xml": "src/main/resources/mapper/UserMapper.xml", "AccountMapper.java": "src/main/java/shop/mapper/AccountMapper.java",
  "Scanned.java": "src/main/java/shop/scanned/Scanned.java", "Elsewhere.java": "src/main/java/shop/elsewhere/Elsewhere.java", "Config.java": "src/main/java/shop/Config.java", "Use.java": "src/main/java/shop/Use.java", "Accounts.java": "src/main/java/shop/Accounts.java",
};

function fixtures(replace: (name: string, content: string) => string = (_, content) => content) {
  return Object.entries(PATHS).map(([name, path]) => ({ path, content: replace(name, readFileSync(new URL(`./fixtures/data-effects/mybatis/${name}`, import.meta.url), "utf8")) }));
}

async function placedIn(file: string, sources = fixtures()) {
  const sites = await createJavaDataEffects(await createJavaParser()).placed(sources);
  return sites.filter(({ site }) => site.file.endsWith(file)).map(({ site }) => [site.line, site.effect?.operation, site.effect?.access, site.effect?.target, site.cause]);
}

const table = (name: string) => ({ kind: "table", name });

test("a call of a @Mapper method takes its access from the XML statement of the namespace and its table only when one statement proves it", async () => {
  assert.deepEqual(await placedIn("Use.java"), [
    [10, "insert", "write", table("users"), undefined],
    [11, "findById", "read", table("users"), undefined],
    [12, "touch", "write", table("users"), undefined],
    [13, undefined, undefined, undefined, "mapper-statement-absent"],
    [14, undefined, undefined, undefined, "mapper-statement-ambiguous"],
    [15, "renamed", "write", undefined, undefined],
    [17, "list", "read", table("audits"), undefined],
  ]);
});

test("a SQL annotation decides the access and the table; a join, a placeholder table, two annotations or a locking clause do not invent a table", async () => {
  assert.deepEqual(await placedIn("Accounts.java"), [
    [6, "find", "read", table("accounts"), undefined],
    [7, "add", "write", table("accounts"), undefined],
    [8, "rename", "write", table("accounts"), undefined],
    [9, "clear", "write", table("accounts"), undefined],
    [10, "owners", "read", undefined, undefined],
    [11, "dynamic", "read", undefined, undefined],
    [12, undefined, undefined, undefined, "mapper-statement-ambiguous"],
    [13, "locked", "read", table("accounts"), undefined],
  ]);
});

test("an interface is a mapper only by the MyBatis @Mapper or a @MapperScan package: a look-alike annotation or an unscanned package is plain code", async () => {
  const lookAlike = fixtures((name, content) => name === "UserMapper.java" ? content.replace("org.apache.ibatis.annotations.Mapper", "other.Mapper") : content);
  assert.deepEqual((await placedIn("Use.java", lookAlike)).map(([line]) => line), [17]);
  const unscanned = fixtures((name, content) => name === "Config.java" ? content.replace("shop.scanned", "shop.other") : content);
  assert.deepEqual((await placedIn("Use.java", unscanned)).map(([line]) => line), [10, 11, 12, 13, 14, 15]);
});
