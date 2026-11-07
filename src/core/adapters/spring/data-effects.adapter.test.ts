import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaDataEffects } from "./data-effects.adapter.ts";

const source = (name: string) => readFileSync(new URL(`./fixtures/data-effects/${name}.java`, import.meta.url), "utf8");

test("Spring Data generic ancestry proves the entity; implemented methods and unrelated save names stay code", async () => {
  const reader = createJavaDataEffects(await createJavaParser());
  const sites = await reader.placed([{ path: "src/Repositories.java", content: source("repositories") }]);
  assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined).map(({ site }) => site.effect), [
    { kind: "data", line: 12, operation: "save", access: "write", target: { kind: "entity", name: "shop.Order" } },
    { kind: "data", line: 13, operation: "findById", access: "read", target: { kind: "entity", name: "shop.Order" } },
    { kind: "data", line: 14, operation: "findByCode", access: "read", target: { kind: "entity", name: "shop.Order" } },
  ]);
});

test("JDBC vocabulary distinguishes query from update and insert, without inventing SQL table targets", async () => {
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Jdbc.java", content: source("jdbc") }]);
  assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined).map(({ site }) => site.effect), [
    { kind: "data", line: 9, operation: "queryForObject", access: "read" },
    { kind: "data", line: 10, operation: "update", access: "write" },
    { kind: "data", line: 11, operation: "executeAndReturnKey", access: "write" },
  ]);
});

test("JPA records execution, including a chained query, and class literals prove entity targets", async () => {
  for (const namespace of ["javax", "jakarta"]) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Jpa.java", content: source("jpa").replace("jakarta.persistence", `${namespace}.persistence`) }]);
    assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined).map(({ site }) => site.effect), [
    { kind: "data", line: 8, operation: "find", access: "read", target: { kind: "entity", name: "shop.Order" } },
    { kind: "data", line: 9, operation: "persist", access: "write" },
    { kind: "data", line: 11, operation: "getResultList", access: "read" },
    ]);
  }
});

test("look-alike framework types and duplicate imports prove no data row", async () => {
  const reader = createJavaDataEffects(await createJavaParser());
  for (const content of [source("jdbc").replaceAll("org.springframework.jdbc.core.JdbcTemplate", "other.JdbcTemplate").replaceAll("org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate", "other.NamedParameterJdbcTemplate").replaceAll("org.springframework.jdbc.core.simple.SimpleJdbcInsert", "other.SimpleJdbcInsert"), source("jdbc").replace("import org.springframework.jdbc.core.JdbcTemplate;", "import org.springframework.jdbc.core.JdbcTemplate; import other.JdbcTemplate;").replace("named.update", "jdbc.update").replace("insert.executeAndReturnKey", "jdbc.getDataSource")]) {
    assert.deepEqual((await reader.placed([{ path: "src/Jdbc.java", content }])).filter(({ site }) => site.effect !== undefined), []);
  }
});

test("repository query annotations own access semantics, while a raw generic proves no target", async () => {
  const content = `package shop;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.Modifying;
interface Raw<T> extends CrudRepository<T, Long> {
 @org.springframework.data.jpa.repository.Query("delete from Order") @org.springframework.data.jpa.repository.Modifying void findByExpired(boolean expired);
 @org.springframework.data.jpa.repository.Query("select o from Order o") Object customQuery();
}
class Service { void run(Raw raw) { raw.findByExpired(true); raw.customQuery(); raw.save(null); } }
`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Raw.java", content }]);
  assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined).map(({ site }) => [site.effect?.operation, site.effect?.access, site.effect?.target]), [["findByExpired", "write", undefined], ["customQuery", "read", undefined], ["save", "write", undefined]]);
});

test("a local from a sibling block cannot prove the receiver of a data call", async () => {
  const content = `import org.springframework.jdbc.core.JdbcTemplate;
class Service {
 private Object db;
 void run() { { JdbcTemplate db = null; db.update("x"); } db.update("y"); }
}`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Service.java", content }]);
  assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined).map(({ site }) => site.effect?.operation), ["update"]);
});

test("a directly annotated framework repository has the same operation row, with only its stated generic entity", async () => {
  const content = `package shop;
import org.springframework.data.repository.CrudRepository;
class Order {}
class Direct { void run(CrudRepository<Order,Long> typed, CrudRepository raw) { typed.save(null); raw.findById(1L); } }`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Direct.java", content }]);
  assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined).map(({ site }) => [site.effect?.operation, site.effect?.access, site.effect?.target]), [["save", "write", { kind: "entity", name: "shop.Order" }], ["findById", "read", undefined]]);
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
  assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined).map(({ site }) => site.effect?.target), [{ kind: "entity", name: "shop.Order" }, undefined]);
});

test("an inherited field and a chained query use the declaring file's import proof", async () => {
  const sources = [
    { path: "src/Base.java", content: `package shop; import other.JdbcTemplate; import org.springframework.jdbc.core.JdbcTemplate; class Base { protected JdbcTemplate jdbc; }` },
    { path: "src/Child.java", content: `package shop; class Child extends Base { void run() { jdbc.update("x"); } }` },
    { path: "src/Queries.java", content: `package shop; import other.EntityManager; import jakarta.persistence.EntityManager; class Queries { private EntityManager em; void run() { em.createQuery("x").getResultList(); } }` },
  ];
  assert.deepEqual((await createJavaDataEffects(await createJavaParser()).placed(sources)).filter(({ site }) => site.effect !== undefined), []);
});

test("JPA fluent query configuration preserves execution provenance, but an unknown fluent member does not", async () => {
  const content = `import jakarta.persistence.EntityManager;
class Service {
 private EntityManager em;
 void run() { em.createQuery("x").setParameter("id", id).setMaxResults(2).getResultList(); }
 void unknown() { em.createQuery("x").custom().getResultList(); }
}`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Fluent.java", content }]);
  assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined).map(({ site }) => [site.line, site.effect?.operation]), [[4, "getResultList"]]);
});

test("lexical project types never become framework receivers or unrelated entity targets", async () => {
  const content = `import org.springframework.jdbc.core.JdbcTemplate;
import jakarta.persistence.EntityManager;
class Order {}
class LocalType {
 void run(EntityManager em) {
  class JdbcTemplate { int update(String sql) { return 0; } }
  class Order {}
  JdbcTemplate db = new JdbcTemplate(); db.update("noop");
  em.find(Order.class, 1L);
 }
}`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/LocalType.java", content }]);
  assert.deepEqual(sites.flatMap(({ site }) => site.effect === undefined ? [] : [site.effect]), [{ kind: "data", line: 9, operation: "find", access: "read" }]);
});

test("lexical value bindings shadow a framework field across parameters, loops, lambdas, catches and inner classes", async () => {
  const cases = [
    'void run(Other db) { db.update("noop"); }',
    'void run(Other[] values) { for (Other db : values) db.update("noop"); }',
    'void run() { java.util.function.Consumer<Other> f = (Other db) -> db.update("noop"); }',
    'void run() { try { throw new Other(); } catch (Other db) { db.update("noop"); } }',
    'class Inner { private Other db; void run() { db.update("noop"); } }',
  ];
  for (const body of cases) {
    const content = `import org.springframework.jdbc.core.JdbcTemplate;
class Shadow { private JdbcTemplate db; static class Other extends Exception { void update(String sql) {} } ${body} }`;
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Shadow.java", content }]);
    assert.deepEqual(sites.flatMap(({ site }) => site.effect === undefined ? [] : [site.effect]), [], body);
  }
});

test("repository overloads need one proven signature before access or body semantics are claimed", async () => {
  const content = `import org.springframework.data.repository.Repository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.Modifying;
class Item {}
interface Repo extends Repository<Item,Long> {
 @org.springframework.data.jpa.repository.Query("select i from Item i") Item findByCode(java.lang.String s);
 @org.springframework.data.jpa.repository.Modifying @org.springframework.data.jpa.repository.Query("delete from Item") int findByCode(int s);
}
class Overload { void run(Repo r) { r.findByCode("x"); } }`;
  for (const [variant, access] of [[content, undefined], [content.replace("java.lang.String s", "long s").replace('findByCode("x")', "findByCode(1L)"), "read"]] as const) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Overload.java", content: variant }]);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.site.effect?.access, access);
  }
});


test("an open method type variable or inherited declarations leave the called signature unproven", async () => {
  const cases = [
    `interface Repo<T> extends org.springframework.data.repository.Repository<T,Long> { T findByCode(T code); } class Service { void run(Repo repo) { repo.findByCode(null); } }`,
    `class Item {} interface Base extends org.springframework.data.repository.Repository<Item,Long> { int countByCode(long code); } interface Repo extends Base { int countByCode(long code); } class Service { void run(Repo repo) { repo.countByCode(1L); } }`,
  ];
  for (const content of cases) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Signature.java", content }]);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.site.effect, undefined);
  }
});

test("a shared receiver candidate without value ownership is a cut, never an annotated effect", async () => {
  for (const member of ['protected org.springframework.jdbc.core.JdbcTemplate db;', 'private org.springframework.jdbc.core.JdbcTemplate db; Service(org.springframework.jdbc.core.JdbcTemplate db) { this.db = db; }']) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Service.java", content: `class Service { ${member} void run() { db.update("x"); } }` }]);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.site.effect, undefined);
  }
});

test("declared annotations need an exact argument signature, including unknown inherited framework overloads", async () => {
  const prelude = `import org.springframework.data.jpa.repository.JpaRepository;
class Item {}
`;
  const modifying = '@org.springframework.data.jpa.repository.Modifying @org.springframework.data.jpa.repository.Query("delete from Item")';
  const reading = '@org.springframework.data.jpa.repository.Query("select i from Item i")';
  const cases = [
    source("inherited-overload"),
    prelude + `interface Repo extends JpaRepository<Item,Long> { ${reading} int save(int id); } class Svc { void run(Repo r, Item item) { r.save(item); } }`,
    prelude + `interface Repo extends JpaRepository<Item,Long> { ${reading} int deleteById(int id); } class Svc { void run(Repo r) { r.deleteById(1L); } }`,
    prelude + `interface Base extends JpaRepository<Item,Long> { ${modifying} int findById(int id); } interface Repo extends Base {} class Svc { void run(Repo r) { r.findById(1L); } }`,
    prelude + `interface Repo extends JpaRepository<Item,Long> { ${modifying} int arbitrary(int id); } class Svc { int value() { return 1; } void run(Repo r) { r.arbitrary(value()); } }`,
  ];
  for (const content of cases) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Overload.java", content }]);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.site.effect, undefined, content);
  }
});

test("exact literal and lexical parameter types preserve the invoked declaration's own read or write", async () => {
  const content = `import org.springframework.data.jpa.repository.JpaRepository;
class Item {}
interface Repo extends JpaRepository<Item,Long> {
 @org.springframework.data.jpa.repository.Modifying @org.springframework.data.jpa.repository.Query("delete from Item") int arbitrary(int id);
 @org.springframework.data.jpa.repository.Query("select i from Item i") int arbitrary(long id);
}
class Svc { void run(Repo r, int id) { r.arbitrary(1); r.arbitrary(1L); r.arbitrary(id); } }`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Exact.java", content }]);
  assert.deepEqual(sites.map(({ site }) => site.effect?.access), ["write", "read", "write"]);
});

test("reference argument identity is lexical; an unplaced local homonym cannot match a declared signature", async () => {
  const prelude = `class Item {}
interface Named { @org.springframework.data.jpa.repository.Modifying @org.springframework.data.jpa.repository.Query("delete from Item") int named(Item item); }
interface Repo extends Named, org.springframework.data.jpa.repository.JpaRepository<Item,Long> {}
`;
  for (const [body, expected] of [
    ['void run(Repo r, Item item) { r.named(item); }', "write"],
    ['void run(Repo r) { class Item {} Item item = new Item(); r.named(item); }', undefined],
  ] as const) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Reference.java", content: prelude + `class Svc { ${body} }` }]);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.site.effect?.access, expected);
  }
});
