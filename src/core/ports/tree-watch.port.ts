/** Why a watcher could not open or stopped: the platform's error code when it gave one, and a description. */
export interface TreeWatchFault {
  code: string;
  detail: string;
}

/** Receives what a watcher saw: a changed path relative to the root with `/` separators, or `undefined` when the platform named none. */
export interface TreeWatchListener {
  changed(path: string | undefined): void;
  /** The watcher stopped and reports nothing more. */
  failed(fault: TreeWatchFault): void;
}

/** An open watcher; closing it twice is harmless. */
export interface TreeWatcher {
  close(): void;
}

/**
 * Watches a directory tree recursively (ADR-0152). It only says that something changed under the root: it never reads a
 * file, and it never keeps the process alive by itself.
 */
export interface TreeWatch {
  watch(root: string, listener: TreeWatchListener): TreeWatcher | { fault: TreeWatchFault };
}
