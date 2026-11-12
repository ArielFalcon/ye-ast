/** What reading or calling a field runs when the field was initialized by a call to a package export. */
export type ValueCellRun =
  | { readonly kind: "nothing" }
  | { readonly kind: "callback"; readonly argument: number };

/** An export of a package: its module specifier and the names written after the imported one. */
export interface CellFactory {
  readonly module: string;
  readonly path: readonly string[];
}

/**
 * The closed vocabulary of one framework's value cells: the exports whose result holds a value, read or called later,
 * and what that read runs. An export the vocabulary does not list is not a cell.
 */
export interface FrameworkValueCells {
  runOf(factory: CellFactory): ValueCellRun | undefined;
  /** Members of a cell that return a cell running the same as the one they are called on. */
  readonly projections: ReadonlySet<string>;
}
