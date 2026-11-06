import type { UnknownReason } from "../shared/fact.ts";

export type ModuleTarget =
  | { kind: "repository"; file: string }
  | { kind: "external"; module: string }
  | { kind: "unresolved"; reason: string };

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
  /** For a `default` binding of a repository file: the name of the declaration that file exports as default. */
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
  /** Source offset distinguishes references sharing a line. */
  offset?: number;
  target: ModuleTarget;
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
  unread: readonly { file: string; reason: UnknownReason }[];
  /** Present when the reader accounted for nested module references; absent for older injected readers. */
  untraversed?: readonly UntraversedReference[];
}

/** A module reference module traversal does not follow; a `require` of a string literal carries where it leads. */
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
