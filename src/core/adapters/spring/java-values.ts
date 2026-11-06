import type { Node } from "web-tree-sitter";
import type { Binding } from "./java-members.ts";
import type { JavaFile, TypeDecl } from "./java-symbols.ts";


/** Why method flow leaves a value undecided. */
export type FlowCause = "recursive" | "dispatch-disagreement";

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
  undecided?: boolean;
  undecidedCause?: FlowCause;
  configurationFile?: JavaFile;
}

export interface ObjectValue {
  kind: "record";
  constructed?: boolean;
  type: TypeDecl;
  fields: ReadonlyMap<string, Closure>;
}

