import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

interface Manifest {
  name?: string;
  version: string;
}

export class PackageManifestNotFoundError extends Error {
  constructor(readonly packageName: string) {
    super(`no package.json found for ${packageName}`);
    this.name = "PackageManifestNotFoundError";
  }
}

export function ownVersion(): string {
  return readManifest(new URL("../../package.json", import.meta.url)).version;
}

/** Version of an installed package, found from its entry point because a package's `exports` may hide its manifest. */
export function installedVersion(packageName: string): string {
  let directory = dirname(createRequire(import.meta.url).resolve(packageName));
  for (;;) {
    const manifest = tryReadManifest(join(directory, "package.json"));
    if (manifest?.name === packageName) return manifest.version;
    const parent = dirname(directory);
    if (parent === directory) throw new PackageManifestNotFoundError(packageName);
    directory = parent;
  }
}

function readManifest(path: string | URL): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function tryReadManifest(path: string): Manifest | undefined {
  try {
    return readManifest(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
