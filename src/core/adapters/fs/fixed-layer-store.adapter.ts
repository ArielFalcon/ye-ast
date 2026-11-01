import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import { FIXED_LAYER_DIRECTORY, type FixedLayerFault, type FixedLayerStore } from "../../ports/fixed-layer-store.port.ts";

export interface FixedLayerStoreDeps {
  lstat: (path: string) => Promise<{ isDirectory(): boolean }>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string, options: { force: true }) => Promise<void>;
}

export const defaultFixedLayerStoreDeps: FixedLayerStoreDeps = { lstat, mkdir, readFile, writeFile, rename, rm };

export function createFixedLayerStore(deps: FixedLayerStoreDeps = defaultFixedLayerStoreDeps): FixedLayerStore {
  return {
    async read(root, name) {
      const invalid = invalidName(name);
      if (invalid) return invalid;
      try {
        return { ok: true, value: await deps.readFile(join(root, FIXED_LAYER_DIRECTORY, name), "utf8") };
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { ok: true, value: undefined };
        return fault("unreadable", error);
      }
    },

    async write(root, name, content) {
      const invalid = invalidName(name);
      if (invalid) return invalid;
      const directory = join(root, FIXED_LAYER_DIRECTORY);
      const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
      try {
        await assertPlainDirectoryOrAbsent(deps, directory);
        await deps.mkdir(directory, { recursive: true });
        await deps.writeFile(temporary, content);
        await deps.rename(temporary, join(directory, name));
        return { ok: true, value: undefined };
      } catch (error) {
        await deps.rm(temporary, { force: true }).catch(() => undefined);
        return fault("unwritable", error);
      }
    },
  };
}

async function assertPlainDirectoryOrAbsent(deps: FixedLayerStoreDeps, directory: string): Promise<void> {
  const entry = await deps.lstat(directory).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (entry !== undefined && !entry.isDirectory()) throw new Error(`${directory} is not a plain directory`);
}

function invalidName(name: string): Result<never, FixedLayerFault> | undefined {
  if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) {
    return { ok: false, fault: { kind: "invalid-name", detail: `not a file of the layer: ${JSON.stringify(name)}` } };
  }
  return undefined;
}

function fault(kind: "unreadable" | "unwritable", error: unknown): Result<never, FixedLayerFault> {
  return { ok: false, fault: { kind, detail: error instanceof Error ? error.message : String(error) } };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
