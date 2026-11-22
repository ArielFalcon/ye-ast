/** A source of a snapshot: its path relative to the repository root and its content as read. */
export interface SourceFile {
  path: string;
  content: string;
  /**
   * The git blob id of the bytes `content` was read from, as the snapshot's listing names the path; absent for a file no
   * listing named. Equal blob ids mean equal content (ADR-0126), so a copy that changes `content` must drop it.
   */
  blob?: string;
}
