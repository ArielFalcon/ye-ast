/** A source of a snapshot: its path relative to the repository root and its content as read. */
export interface SourceFile {
  path: string;
  content: string;
}
