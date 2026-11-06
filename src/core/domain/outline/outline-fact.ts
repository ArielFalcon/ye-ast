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

export interface OutlineValue {
  /** One entry per requested file the index holds a node of, in path order. */
  files: readonly OutlineFile[];
  /** Requested files the index holds no node of, in path order: what they declare cannot be told, which is not "nothing". */
  unheld: readonly string[];
}
