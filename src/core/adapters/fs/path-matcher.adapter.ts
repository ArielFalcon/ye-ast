import { posix } from "node:path";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";

export function createPathMatcher(): PathMatcher {
  return { matches: (path, glob) => posix.matchesGlob(path, glob) };
}
