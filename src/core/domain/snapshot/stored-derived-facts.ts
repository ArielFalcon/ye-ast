/**
 * The derived-fact slots that persist across processes (ADR-0077), each with the version of the reader that owns it.
 * A reader that changes what it derives bumps its slot's version, so entries stored under the old one are never read; a
 * slot absent here is kept in memory only. Slots keyed by one file's content come first (decision 7).
 */
export const STORED_DERIVED_FACT_VERSIONS: Readonly<Record<string, number>> = {
  "ts-member-names": 1,
  "java-member-names": 1,
  "ts-binding-uses": 1,
  "ts-script-globals": 1,
  "ts-written-roots": 1,
  "ts-module-statements": 1,
  "ts-default-declaration": 1,
  "java-receiver-bindings": 1,
  "java-declarations": 2,
  "java-relations": 1,
  "java-entrypoints": 1,
  "java-callbacks": 1,
  "java-receiver-sites": 1,
  "java-declared-supertypes": 1,
  "java-implemented-declarations": 1,
  "java-receiver-fits": 1,
  "java-implicit-chains": 1,
  "java-argument-counts": 1,
  "java-accepted-counts": 1,
  "java-import-statements": 1,
  "java-import-targets": 1,
  "java-root-origins": 1,
  tokens: 1,
  "ts-module-resolutions": 1,
};
