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
  const unsettledArgument = content.replace("import org.springframework.data.repository.Repository;", "import org.springframework.data.repository.Repository;\nimport com.acme.Mystery;").replace('findByCode("x")', "findByCode(Mystery.of())");
  for (const [variant, access] of [[content, "read"], [unsettledArgument, undefined], [content.replace("java.lang.String s", "long s").replace('findByCode("x")', "findByCode(1L)"), "read"]] as const) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Overload.java", content: variant }]);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.site.effect?.access, access);
  }
});

test("a query method of a repository below a Spring Data interface settles its signature, a repository below any other interface does not", async () => {
  const repository = (parent: string, imports: string) => `${imports}
import org.springframework.data.jpa.repository.Query;
class User {}
interface Repo extends ${parent}<User,Long> {
 @Query("select u from User u") User findByLogin(String login);
}
class Svc { void run(Repo r) { r.findByLogin("x"); } }`;
  const access = async (content: string, ...others: readonly { path: string; content: string }[]) => (await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Svc.java", content }, ...others]))[0]?.site.effect?.access;
  const claimsPackage = { path: "src/Claim.java", content: "package org.springframework.data.repository;\ninterface Claim {}\n" };

  assert.equal(await access(repository("JpaRepository", "import org.springframework.data.jpa.repository.JpaRepository;")), "read");
  assert.equal(await access(repository("CrudRepository", "import org.springframework.data.repository.CrudRepository;")), "read");
  assert.equal(await access(repository("Base", "import com.acme.Base;")), undefined);
  assert.equal(await access(repository("JpaRepository", "import com.acme.JpaRepository;")), undefined);
  assert.equal(await access(repository("CrudRepository", "import org.springframework.data.repository.CrudRepository;"), claimsPackage), undefined);
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
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Service.java", content: `class Service { protected org.springframework.jdbc.core.JdbcTemplate db; void run() { db.update("x"); } }` }]);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.site.effect, undefined);
});

const REPOSITORY = `package shop;
import org.springframework.data.repository.CrudRepository;
class Item {}
interface ItemRepository extends CrudRepository<Item, Long> {}
`;

test("a constructor parameter named like the injected field does not shadow the field in other methods", async () => {
  const content = `${REPOSITORY}class Service {
 private final ItemRepository repo;
 Service(ItemRepository repo) { this.repo = repo; }
 void run(Item item) { repo.save(item); }
}`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Service.java", content }]);
  assert.deepEqual(sites.map(({ site }) => site.effect), [{ kind: "data", line: 8, operation: "save", access: "write", target: { kind: "entity", name: "shop.Item" } }]);
});

test("an untyped local or lambda variable of the field's name in the same method still shadows the field", async () => {
  for (const body of ["void run(Item item, ItemRepository other) { var repo = other; repo.save(item); }", "void run(Item item) { java.util.function.Consumer<Item> c = repo -> repo.save(item); }", "void run(Item item, Object repo) { repo.save(item); }"]) {
    const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Service.java", content: `${REPOSITORY}class Service {\n private final ItemRepository repo;\n ${body}\n}` }]);
    assert.deepEqual(sites.filter(({ site }) => site.effect !== undefined), [], body);
  }
});

test("Spring Data derived names with a subject between the verb and By read or delete", async () => {
  const names = ["findOneByActive", "findUserByActive", "findDistinctByActive", "getOneByActive", "countDistinctByActive", "existsUserByActive", "findFirst3ByActive", "findTopByActive"];
  const declarations = names.map((name) => `Item ${name}(boolean active);`).join(" ") + " void deleteUserByActive(boolean active); void removeDistinctByActive(boolean active); Item findings(boolean a);";
  const calls = [...names, "deleteUserByActive", "removeDistinctByActive", "findings"].map((name) => `r.${name}(true);`).join(" ");
  const content = `package shop;
import org.springframework.data.repository.Repository;
class Item {}
interface ItemRepository extends Repository<Item, Long> { ${declarations} }
class Service { void run(ItemRepository r) { ${calls} } }`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Derived.java", content }]);
  assert.deepEqual(sites.map(({ site }) => site.effect?.access), [...names.map(() => "read"), "write", "write", undefined]);
});

test("a repository-named call on a type with an unknown ancestor is an explicit unplaced effect", async () => {
  const content = `package shop;
interface ItemRepository extends org.unknown.Base<Long> {}
class Service { void run(ItemRepository repo) { repo.findById(1L); } }`;
  const sites = await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Unknown.java", content }]);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.site.effect, undefined);
  for (const quiet of [content.replace("org.unknown.Base<Long>", "java.io.Serializable"), content.replace("org.unknown.Base<Long>", "Base") + " interface Base {}", content.replace("repo.findById(1L)", "repo.describe(1L)")]) {
    assert.deepEqual(await createJavaDataEffects(await createJavaParser()).placed([{ path: "src/Closed.java", content: quiet }]), [], quiet);
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
