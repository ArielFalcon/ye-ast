/** Where a module reference leads: a file of the repository, an external module, or why it is unresolved. */
export type ModuleTarget =
  | { kind: "repository"; file: string }
  | { kind: "external"; module: string }
  | { kind: "unresolved"; reason: string };
