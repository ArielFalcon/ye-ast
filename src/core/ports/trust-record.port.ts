import type { Result } from "../domain/shared/result.ts";
import type { TrustMode } from "../domain/shared/fact.ts";

export interface TrustRecordFault {
  kind:
    /** The record exists but cannot be read, or is not a record of this format for this repository. */
    | "unreadable"
    /** The record or its directory is a symbolic link, belongs to another account or is open to others; nothing was changed. */
    | "refused"
    /** The record cannot be created or replaced; nothing partial remains. */
    | "unwritable"
    /** The environment names no user-level place to keep it. */
    | "no-location";
  detail: string;
}

/** What the CLI and the MCP server read: the mode a user declared for a repository. */
export interface TrustRecordReader {
  /**
   * The mode declared for the repository at `root`, `undefined` when it has no declaration, or the fault that made the
   * record unusable, in which case the caller runs `untrusted`. Every spelling of one directory (a symlink, a relative
   * segment) is one repository.
   */
  read(root: string): Promise<Result<TrustMode | undefined, TrustRecordFault>>;
}

/** The user-level declaration of the trust mode per repository, kept outside every repository (ADR-0010 decision 6). */
export interface TrustRecords extends TrustRecordReader {
  /** Replaces the declaration for `root`; the declarations of other repositories are separate records and stay. */
  write(root: string, mode: TrustMode): Promise<Result<void, TrustRecordFault>>;
}
