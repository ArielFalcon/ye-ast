/** Validates only names already proposed by the diff; unknown evidence keeps a name. */
export interface DeclarationEvidenceReader {
  validate(input: { path: string; base: string | undefined; head: string | undefined; names: readonly string[]; deleted: boolean }): readonly string[];
}
