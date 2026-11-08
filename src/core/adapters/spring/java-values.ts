import type { Node } from "web-tree-sitter";
import type { Binding } from "./java-members.ts";
import type { JavaFile, TypeDecl } from "./java-symbols.ts";
import type { UndecidedCause } from "../../domain/topology/evaluated.ts";

/** A call argument and the scope it is written in, which the called method's parameter stands for. */
export interface Closure {
  node: Node;
  scope: UrlScope;
}

/** Where an expression is written: the type, the names of its method and what a call of that method binds its parameters to. */
export interface UrlScope {
  type: TypeDecl;
  locals: ReadonlyMap<string, Binding>;
  env: ReadonlyMap<string, Closure>;
  receiver?: TypeDecl;
  instance?: ObjectValue;
  deferred?: boolean;
  /** Why method flow leaves every value written in this scope undecided. */
  undecided?: UndecidedCause;
  configurationFile?: JavaFile;
}

export interface ObjectValue {
  kind: "record";
  constructed?: boolean;
  type: TypeDecl;
  fields: ReadonlyMap<string, Closure>;
}

