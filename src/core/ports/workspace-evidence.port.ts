import type { OutwardName } from "../domain/topology/outward-name.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

/**
 * What a repository states about the world outside it, read from the files of its snapshot: the URLs its configuration
 * declares, the coordinates its build and its package manifest depend on, the registries they declare, and the message
 * destinations its code names. The names are facts with their places; nothing here reaches the network.
 */
export interface WorkspaceEvidence {
  names(files: readonly SourceFile[]): readonly OutwardName[];
  /** The coordinates the repository's own build declares, which its own name is recognized by. */
  artifacts(files: readonly SourceFile[]): readonly string[];
}
