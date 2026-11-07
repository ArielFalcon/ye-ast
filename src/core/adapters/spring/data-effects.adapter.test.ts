import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaDataEffects } from "./data-effects.adapter.ts";

const source = (name: string) => readFileSync(new URL(`./fixtures/data-effects/${name}.java`, import.meta.url), "utf8");

test("Spring Data generic ancestry proves the entity; implemented methods and unrelated save names stay code", async () => {
  const reader = createJavaDataEffects(await createJavaParser());
  const sites = await reader.placed([{ path: "src/Repositories.java", content: source("repositories") }]);
  assert.deepEqual(sites.map(({ site }) => site.effect), [
    { kind: "data", line: 12, operation: "save", access: "write", target: { kind: "entity", name: "shop.Order" } },
    { kind: "data", line: 13, operation: "findById", access: "read", target: { kind: "entity", name: "shop.Order" } },
    { kind: "data", line: 14, operation: "findByCode", access: "read", target: { kind: "entity", name: "shop.Order" } },
  ]);
});

test("JDBC vocabulary distinguishes query from update and insert, without inventing SQL table targets", async () => {
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Jdbc.java", content: source("jdbc") }]);
  assert.deepEqual(sites.map(({ site }) => site.effect), [
    { kind: "data", line: 9, operation: "queryForObject", access: "read" },
    { kind: "data", line: 10, operation: "update", access: "write" },
    { kind: "data", line: 11, operation: "executeAndReturnKey", access: "write" },
  ]);
});

test("JPA records execution, including a chained query, and class literals prove entity targets", async () => {
  for (const namespace of ["javax", "jakarta"]) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Jpa.java", content: source("jpa").replace("jakarta.persistence", `${namespace}.persistence`) }]);
    assert.deepEqual(sites.map(({ site }) => site.effect), [
    { kind: "data", line: 8, operation: "find", access: "read", target: { kind: "entity", name: "shop.Order" } },
    { kind: "data", line: 9, operation: "persist", access: "write" },
    { kind: "data", line: 11, operation: "getResultList", access: "read" },
    ]);
  }
});

test("look-alike framework types and duplicate imports prove no data row", async () => {
  const reader = createJavaDataEffects(await createJavaParser());
  for (const content of [source("jdbc").replaceAll("org.springframework.jdbc.core.JdbcTemplate", "other.JdbcTemplate").replaceAll("org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate", "other.NamedParameterJdbcTemplate").replaceAll("org.springframework.jdbc.core.simple.SimpleJdbcInsert", "other.SimpleJdbcInsert"), source("jdbc").replace("import org.springframework.jdbc.core.JdbcTemplate;", "import org.springframework.jdbc.core.JdbcTemplate; import other.JdbcTemplate;").replace("named.update", "jdbc.update").replace("insert.executeAndReturnKey", "jdbc.getDataSource")]) {
    assert.deepEqual(await reader.placed([{ path: "src/Jdbc.java", content }]), []);
  }
});

test("repository query annotations own access semantics, while a raw generic proves no target", async () => {
  const content = `package shop;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.Modifying;
interface Raw<T> extends CrudRepository<T, Long> {
 @Query("delete from Order") @Modifying void findByExpired(boolean expired);
 @Query("select o from Order o") Object customQuery();
}
class Service { void run(Raw raw) { raw.findByExpired(true); raw.customQuery(); raw.save(null); } }
`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Raw.java", content }]);
  assert.deepEqual(sites.map(({ site }) => [site.effect?.operation, site.effect?.access, site.effect?.target]), [["findByExpired", "write", undefined], ["customQuery", "read", undefined], ["save", "write", undefined]]);
});

test("a local from a sibling block cannot prove the receiver of a data call", async () => {
  const content = `import org.springframework.jdbc.core.JdbcTemplate;
class Service {
 private Object db;
 void run() { { JdbcTemplate db = null; db.update("x"); } db.update("y"); }
}`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Service.java", content }]);
  assert.deepEqual(sites.map(({ site }) => site.effect?.operation), ["update"]);
});

test("a directly annotated framework repository has the same operation row, with only its stated generic entity", async () => {
  const content = `package shop;
import org.springframework.data.repository.CrudRepository;
class Order {}
class Direct { void run(CrudRepository<Order,Long> typed, CrudRepository raw) { typed.save(null); raw.findById(1L); } }`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Direct.java", content }]);
  assert.deepEqual(sites.map(({ site }) => [site.effect?.operation, site.effect?.access, site.effect?.target]), [["save", "write", { kind: "entity", name: "shop.Order" }], ["findById", "read", undefined]]);
});

test("a generic receiver substitutes its entity while a method type parameter does not bind a same-named entity", async () => {
  const content = `package shop;
import org.springframework.data.repository.CrudRepository;
class Order {}
interface Base<E> extends CrudRepository<E,Long> {}
class Service {
 void concrete(Base<Order> repo) { repo.save(null); }
 <Order> void generic(CrudRepository<Order,Long> repo) { repo.save(null); }
}`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Generic.java", content }]);
  assert.deepEqual(sites.map(({ site }) => site.effect?.target), [{ kind: "entity", name: "shop.Order" }, undefined]);
});

test("an inherited field and a chained query use the declaring file's import proof", async () => {
  const sources = [
    { path: "src/Base.java", content: `package shop; import other.JdbcTemplate; import org.springframework.jdbc.core.JdbcTemplate; class Base { protected JdbcTemplate jdbc; }` },
    { path: "src/Child.java", content: `package shop; class Child extends Base { void run() { jdbc.update("x"); } }` },
    { path: "src/Queries.java", content: `package shop; import other.EntityManager; import jakarta.persistence.EntityManager; class Queries { private EntityManager em; void run() { em.createQuery("x").getResultList(); } }` },
  ];
  assert.deepEqual(await createJavaDataEffects(await createJavaParser()).placed(sources), []);
});

test("JPA fluent query configuration preserves execution provenance, but an unknown fluent member does not", async () => {
  const content = `import jakarta.persistence.EntityManager;
class Service {
 private EntityManager em;
 void run() { em.createQuery("x").setParameter("id", id).setMaxResults(2).getResultList(); }
 void unknown() { em.createQuery("x").custom().getResultList(); }
}`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Fluent.java", content }]);
  assert.deepEqual(sites.map(({ site }) => [site.line, site.effect?.operation]), [[4, "getResultList"]]);
});
