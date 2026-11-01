export interface PathMatcher {
  /** Whether the repository-relative `path`, with `/` separators, matches `glob`; `*` and `**` never cross into a dot-prefixed segment. */
  matches(path: string, glob: string): boolean;
}
