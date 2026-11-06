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

/** The shape of one file: what it declares and which files it imports. */
export interface OutlineFile {
  file: string;
  /**
   * The top-level declarations, in line then name order, each holding its children: those the file contains, and those
   * no contains edge places inside a declaration of the file. Nesting comes from contains edges only, never from spans.
   */
  declarations: readonly OutlineDeclaration[];
  /** Repo-relative files this one imports, sorted: a package outside the repository is not an edge of the graph. */
  imports: readonly string[];
}

/** A container of a focused declaration, without the other declarations it holds. */
export type OutlineAncestor = Omit<OutlineDeclaration, "children">;

/** One declaration a focus selector matched, cut out of its file. */
export interface OutlineFocus {
  file: string;
  /** What followed the file in the selector: a dotted path or a line. */
  selector: string;
  /** The declaration's dotted path in its file, its containers outermost first; `callers` resolves it to the same declarations. */
  path: string;
  /** Its containers, outermost first. */
  ancestors: readonly OutlineAncestor[];
  /** The matched declaration with every declaration nested under it. */
  declaration: OutlineDeclaration;
  /** How many of the file's declarations are neither an ancestor nor under the declaration: the answer is a cut of the file. */
  omitted: number;
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
