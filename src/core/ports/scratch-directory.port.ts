export interface ScratchDirectory {
  /** Creates an empty directory only this process can use. */
  create(): Promise<string>;
  /** Removes the directory and everything under it. */
  remove(path: string): Promise<void>;
}
