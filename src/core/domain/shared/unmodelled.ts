import { compareText } from "./code-node.ts";

/** Why a symbol of a file the graph cannot place is missing, said once beside the names; empty for any other file. */
export function unmodelledNote(missing: readonly { file: string }[], unmodelled: readonly string[]): string {
  const files = [...new Set(missing.map(({ file }) => file).filter((file) => unmodelled.includes(file)))].sort(compareText);
  return files.length === 0 ? "" : `; ${files.join(", ")} declares a Java record, whose members the index does not place under it`;
}
