import type { Result } from "../domain/shared/result.ts";

/** The directory of the fixed layer, directly under the repository root. */
export const FIXED_LAYER_DIRECTORY = ".ye-ast";

export interface FixedLayerFault {
  kind:
    /** The file exists but cannot be read, or the layer directory is not a directory. */
    | "unreadable"
    /** The layer directory or the file cannot be created or replaced; nothing partial remains. */
    | "unwritable"
    /** The file name holds a path separator or is a dot entry, so it would leave the layer directory. */
    | "invalid-name";
  detail: string;
}

/** Where the fixed layer of one repository lives; the use case decides what it holds. */
export interface FixedLayerStore {
  /** The content of the file `name` of the layer under `root`, or `undefined` when there is none. */
  read(root: string, name: string): Promise<Result<string | undefined, FixedLayerFault>>;
  /**
   * Replaces the file `name` of the layer under `root`, creating the layer directory: the content goes to a temporary
   * file in the same directory and is renamed over `name`, so a reader sees the old file or the new one, never a part.
   */
  write(root: string, name: string, content: string): Promise<Result<void, FixedLayerFault>>;
}
