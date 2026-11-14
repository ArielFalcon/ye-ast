import type { UnknownReason } from "../shared/fact.ts";
import type { ModuleTarget } from "../shared/module-target.ts";

/** A module reference that is not a top-level statement: conditional evidence of a dependency. */
export type ModuleReferenceForm = "dynamic-import" | "type-query";

/** One name a module statement binds, as the syntax states it. */
export interface ModuleBinding {
  /** The name this file uses (exposes, for a re-export); absent for `export *`. */
  local?: string;
  /** The exported name it takes: a name, `default`, or `*` for the module itself. */
  imported: string;
  line: number;
  /** 1-based column of the local name (of the property name in `export { a as b } from`), where the graph writes it. */
  column: number;
  typeOnly: boolean;
  /**
   * The dotted containment path, from the top level of the repository file it leads to, of the declaration the bound
   * value is, when syntax proves it: the declaration a TypeScript file exports as default, or the qualified name of the
   * type or member a Java import names (its package is the namespace that contains the file's types).
   */
  exportedAs?: string;
}

export interface ModuleDependency {
  file: string;
  line: number;
  endLine: number;
  specifier: string;
  kind: "import" | "reexport";
  typeOnly: boolean;
  /** Absent for static statements; runtime imports remain conditional module evidence; `import-equals` is static. */
  form?: ModuleReferenceForm | "import-equals";
  /** Where the statement or reference starts in its source, so those sharing a line keep their order. */
  offset?: number;
  target: ModuleTarget;
  /** Set on an unresolved target when no path of the snapshot could be its target. */
  namesNoFile?: true;
  /** What the statement binds, in source order; empty for a side-effect import or a runtime reference. */
  bindings: readonly ModuleBinding[];
}

export interface ModuleSource {
  file: string;
  statements: readonly string[];
  moduleOnly: boolean;
  /** A referenced data file, not a TypeScript declaration container. */
  resource?: true;
}

export interface ModuleDependencies {
  files: readonly ModuleSource[];
  dependencies: readonly ModuleDependency[];
  /**
   * `reaches`: for a source whose module statements are not read, the repository files the strings it writes resolve to,
   * sorted, a bound of the modules its statements may name (ADR-0085); absent where the reader stated none.
   */
  unread: readonly { file: string; reason: UnknownReason; reaches?: readonly string[] }[];
  /** Present when the reader accounted for nested module references; absent for older injected readers. */
  untraversed?: readonly UntraversedReference[];
}

/**
 * A module reference module traversal does not follow; a `require` of a string literal carries where it leads, or why
 * it is unresolved when the file binds a `require` of its own.
 */
export interface UntraversedReference {
  file: string;
  line: number;
  offset: number;
  form: ModuleReferenceForm | "require";
  endLine?: number;
  specifier?: string;
  target?: ModuleTarget;
}

export interface ModuleOrigin {
  file: string;
  change: "added" | "modified" | "deleted";
}

export interface ReachedModule {
  file: string;
  snapshot: "base" | "head";
  depth: number;
  origins: readonly number[];
  via?: { file: string; line: number; specifier: string; kind: ModuleDependency["kind"]; typeOnly: boolean; form?: ModuleReferenceForm };
}

export interface ModuleImpactValue {
  origins: readonly ModuleOrigin[];
  modules: readonly ReachedModule[];
  cost: { expansionsUsed: number };
}
