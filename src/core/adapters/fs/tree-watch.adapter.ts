import { watch as fsWatch } from "node:fs";
import { sep } from "node:path";
import type { TreeWatch, TreeWatchFault } from "../../ports/tree-watch.port.ts";

export interface TreeWatchDeps {
  watch: typeof fsWatch;
}

export const defaultTreeWatchDeps: TreeWatchDeps = { watch: fsWatch };

function faultOf(error: unknown): TreeWatchFault {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "unknown";
  return { code, detail: error instanceof Error ? error.message : String(error) };
}

/** The platform's recursive watcher (`fs.watch`), never persistent, so that no watcher it opens holds the process open. */
export function createTreeWatch(deps: TreeWatchDeps = defaultTreeWatchDeps): TreeWatch {
  return {
    watch(root, listener) {
      try {
        const watcher = deps.watch(root, { recursive: true, persistent: false, encoding: "utf8" }, (_event, filename) => {
          listener.changed(filename === null ? undefined : filename.split(sep).join("/"));
        });
        watcher.on("error", (error) => {
          watcher.close();
          listener.failed(faultOf(error));
        });
        return { close: () => watcher.close() };
      } catch (error) {
        return { fault: faultOf(error) };
      }
    },
  };
}
