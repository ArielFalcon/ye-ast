import type { ModuleTarget } from "../shared/module-target.ts";

/** A declaration the outline names: its kind, its name, and the span a reader opens instead of the whole file. */
export interface OutlineDeclaration {
  kind: string;
  name: string;
  /** 1-based first line of the declaration. */
  line: number;
  /** 1-based last line of the declaration, so a caller reads exactly it. */
  endLine: number;
  /** The declarations a contains edge of the graph places directly inside this one, in line then name order; absent when none. */
  children?: readonly OutlineDeclaration[];
}

/** One name a module statement binds, and the declaration it reaches when that is proven. */
export interface OutlineBinding {
  /** The name the file uses (exposes, for a re-export); absent for `export *`. */
  local?: string;
  /** The exported name it takes: a name, `default`, or `*` for the module itself. */
  imported: string;
  typeOnly?: true;
  /** The declaration the binding reaches, through re-exports; absent when it binds a module (`*`) or is not proven. */
  declaration?: { file: string; name: string; kind: string; line: number; endLine: number };
}

/** One module statement or runtime module reference of a file, with where it leads and what it binds. */
export interface OutlineImport {
  line: number;
  endLine: number;
  /** The module as written; absent when a computed expression names it. */
  specifier?: string;
  kind: "import" | "reexport";
  /** Absent for a static statement. */
  form?: "dynamic-import" | "type-query" | "require" | "import-equals";
  typeOnly: boolean;
  target: ModuleTarget;
  bindings: readonly OutlineBinding[];
}

/** The shape of one file: what it declares and what it imports. */
export interface OutlineFile {
  file: string;
  /**
   * The top-level declarations, in line then name order, each holding its children: those the file contains, and those
   * no contains edge places inside a declaration of the file. Nesting comes from contains edges only, never from spans.
   */
  declarations: readonly OutlineDeclaration[];
  /** Every module statement and runtime module reference, in source order, each resolved or explicitly unresolved. */
  imports: readonly OutlineImport[];
}

/** A container of a focused declaration, without the other declarations it holds. */
export type OutlineAncestor = Omit<OutlineDeclaration, "children">;

/** Where a use leads: a declaration of the repository, a package, or a name the language's own libraries declare. */
export type OutlineUseTarget = { declaration: { file: string; name: string; kind: string; line: number; endLine: number } } | { module: string } | { global: string };

/** A place of the focused declaration's body, 1-based. */
export interface OutlinePlace {
  line: number;
  /** Absent when the index records no column. */
  column?: number;
}

/** One thing the focused declaration's own body uses that is bound outside the body, with every place it uses it. */
export type OutlineUse = OutlineUseTarget & {
  /** How the body uses it, by graph edge kind (`calls`, `instantiates`, `references`, `extends`, `implements`), sorted. */
  relations: readonly string[];
  /** The places of the uses in source order; empty when the index places none. */
  at: readonly OutlinePlace[];
};

/** One declaration a focus selector matched, cut out of its file. */
export interface OutlineFocus {
  file: string;
  /** What followed the file in the selector: a dotted path or a line. */
  selector: string;
  /** The proven dotted path, containers outermost first; absent when no binding proves one. */
  path?: string;
  /** Its containers, outermost first. */
  ancestors: readonly OutlineAncestor[];
  /** The matched declaration with every declaration nested under it. */
  declaration: OutlineDeclaration;
  /** How many of the file's declarations are neither an ancestor nor under the declaration: the answer is a cut of the file. */
  omitted: number;
  /**
   * What the declaration's own body uses that is bound outside it, in order of first use, places without a line last; a
   * use no binding proves is an `unresolved-link` cut, and a member used on a local value is not listed. Absent when not
   * evaluated; empty when the body uses nothing outside itself.
   */
  uses?: readonly OutlineUse[];
}

/** Every requested file whole. */
export interface OutlineListing {
  /** One entry per requested file the index holds a node of, in path order. */
  files: readonly OutlineFile[];
  /** Requested files the index holds no node of, in path order: what they declare cannot be told, which is not "nothing". */
  unheld: readonly string[];
  focus?: never;
}

/** Only the declarations focus selectors matched, without imports. */
export interface OutlineFocusValue {
  /** Every match of every selector, by file then line, ties in the request's fixed order; a selector matching several lists each. */
  focus: readonly OutlineFocus[];
  /** Files of the selectors the index holds no node of, in path order. */
  unheld: readonly string[];
  files?: never;
}

export type OutlineValue = OutlineListing | OutlineFocusValue;
