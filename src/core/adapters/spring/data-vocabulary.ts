import type { DataEffect } from "../../domain/trace/trace-fact.ts";

type Access = DataEffect["access"];
const operations = (read: readonly string[], write: readonly string[], unknown: readonly string[] = []): ReadonlyMap<string, Access> => new Map([...read.map((name) => [name, "read"] as const), ...write.map((name) => [name, "write"] as const), ...unknown.map((name) => [name, "unknown"] as const)]);

export const REPOSITORY_TYPES: ReadonlySet<string> = new Set([
  "org.springframework.data.repository.Repository", "org.springframework.data.repository.CrudRepository",
  "org.springframework.data.repository.ListCrudRepository", "org.springframework.data.repository.PagingAndSortingRepository",
  "org.springframework.data.repository.ListPagingAndSortingRepository", "org.springframework.data.jpa.repository.JpaRepository",
]);
/** Interfaces a repository adds to the ones above for operations of the same names (`findAll`, `count`, `delete` by specification). */
export const REPOSITORY_FRAGMENTS: ReadonlySet<string> = new Set(["org.springframework.data.jpa.repository.JpaSpecificationExecutor"]);
export const QUERY_ANNOTATION = "org.springframework.data.jpa.repository.Query";
export const MODIFYING_ANNOTATION = "org.springframework.data.jpa.repository.Modifying";
/** Every Spring Data type the engine reads by name: the repository interfaces and the query annotations. */
export const SPRING_DATA_TYPES: ReadonlySet<string> = new Set([...REPOSITORY_TYPES, ...REPOSITORY_FRAGMENTS, QUERY_ANNOTATION, MODIFYING_ANNOTATION]);
/** The Lombok types the engine reads by name: the annotations that generate members and the access levels they take. */
export const LOMBOK_TYPES: ReadonlySet<string> = new Set([
  "lombok.Getter", "lombok.Setter", "lombok.Data", "lombok.Value", "lombok.Builder", "lombok.AccessLevel", "lombok.Singular",
  "lombok.experimental.SuperBuilder", "lombok.experimental.Accessors", "lombok.experimental.FieldNameConstants",
]);
export const REPOSITORY_OPERATIONS = operations(
  ["findById", "findAll", "findAllById", "count", "existsById", "getOne", "getById", "getReferenceById"],
  ["save", "saveAll", "saveAndFlush", "saveAllAndFlush", "delete", "deleteById", "deleteAll", "deleteAllById", "deleteInBatch", "deleteAllInBatch", "deleteAllByIdInBatch", "flush"],
);
/** Every member name a repository interface of the vocabulary declares: its operations and the query-by-example ones the sources never state. */
export const REPOSITORY_MEMBER_NAMES: ReadonlySet<string> = new Set([...REPOSITORY_OPERATIONS.keys(), "findOne", "exists", "findBy"]);
const JDBC_OPERATIONS = operations(["query", "queryForObject", "queryForList", "queryForMap", "queryForRowSet", "queryForStream"], ["update", "batchUpdate"], ["execute", "call"]);
const INSERT_OPERATIONS = operations([], ["execute", "executeAndReturnKey", "executeAndReturnKeyHolder", "executeBatch"]);
export const ENTITY_OPERATIONS = operations(["find", "refresh"], ["persist", "merge", "remove", "flush"]);
export const QUERY_OPERATIONS = operations(["getResultList", "getSingleResult", "getSingleResultOrNull", "getResultStream"], ["executeUpdate"]);
export const DATA_CLIENTS: ReadonlyMap<string, ReadonlyMap<string, Access>> = new Map([
  ...["org.springframework.jdbc.core.JdbcTemplate", "org.springframework.jdbc.core.JdbcOperations", "org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate", "org.springframework.jdbc.core.namedparam.NamedParameterJdbcOperations"].map((name) => [name, JDBC_OPERATIONS] as const),
  ...["org.springframework.jdbc.core.simple.SimpleJdbcInsert", "org.springframework.jdbc.core.simple.SimpleJdbcInsertOperations"].map((name) => [name, INSERT_OPERATIONS] as const),
  ...["javax.persistence", "jakarta.persistence"].flatMap((pkg) => [[`${pkg}.EntityManager`, ENTITY_OPERATIONS], [`${pkg}.Query`, QUERY_OPERATIONS], [`${pkg}.TypedQuery`, QUERY_OPERATIONS]] as const),
]);
export const QUERY_FACTORIES: ReadonlySet<string> = new Set(["createQuery", "createNamedQuery", "createNativeQuery"]);
export const QUERY_CONFIGURATION: ReadonlySet<string> = new Set(["setParameter", "setMaxResults", "setFirstResult", "setHint", "setFlushMode", "setLockMode"]);
