export interface ScopeFault {
  kind: "unknown-scope-path";
  detail: string;
  globs: readonly string[];
}
