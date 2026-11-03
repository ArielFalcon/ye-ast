/** A declaration the outline names: its kind, its name, and the span a reader opens instead of the whole file. */
export interface OutlineDeclaration {
  kind: string;
  name: string;
  /** 1-based first line of the declaration. */
  line: number;
  /** 1-based last line of the declaration, so a caller reads exactly it. */
  endLine: number;
}

/** The shape of one file: what it declares and which files it imports. */
export interface OutlineFile {
  file: string;
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
