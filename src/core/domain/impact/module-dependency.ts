import type { UnknownReason } from "../shared/fact.ts";

export type ModuleTarget =
  | { kind: "repository"; file: string }
  | { kind: "external"; module: string }
  | { kind: "unresolved"; reason: string };

export interface ModuleDependency {
  file: string;
  line: number;
  endLine: number;
  specifier: string;
  kind: "import" | "reexport";
  typeOnly: boolean;
  /** Absent for static statements; runtime imports remain conditional module evidence. */
  form?: "dynamic-import" | "type-query";
  /** Source offset distinguishes references sharing a line. */
  offset?: number;
  target: ModuleTarget;
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
  untraversed?: readonly { file: string; line: number; offset: number; form: "dynamic-import" | "type-query" | "require" }[];
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
  via?: { file: string; line: number; specifier: string; kind: ModuleDependency["kind"]; typeOnly: boolean; form?: ModuleDependency["form"] };
}

export interface ModuleImpactValue {
  origins: readonly ModuleOrigin[];
  modules: readonly ReachedModule[];
  cost: { expansionsUsed: number };
}
