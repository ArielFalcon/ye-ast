import { join } from "node:path";
import type { JdkSignatureSource } from "../../ports/jdk-signature.port.js";
import { openJdkArchive, type JdkArchive } from "./jdk-archive.adapter.js";
import { generateJdkSignatures } from "./jdk-signature-generator.js";
import { JdkSignaturesFault, parseJdkSignatures, type JdkSignatures } from "./jdk-signatures.js";

export interface JdkSignatureSourceDeps {
  open(path: string): JdkArchive;
}

export const defaultJdkSignatureSourceDeps: JdkSignatureSourceDeps = {
  open: (path) => openJdkArchive(path),
};

const tables = new Map<string, JdkSignatures | undefined>();

/**
 * The table of a source, generated once per process and per host path. `undefined` when the source is none, the path
 * is unreadable, its digest is not pinned, or the pinned archive does not generate a table: no table is ever invented.
 */
export function jdkSignaturesOf(source: JdkSignatureSource, deps: JdkSignatureSourceDeps = defaultJdkSignatureSourceDeps): JdkSignatures | undefined {
  if (source.kind === "none") return undefined;
  if (!tables.has(source.path)) tables.set(source.path, readTable(deps.open(join(source.path, "lib", "ct.sym"))));
  return tables.get(source.path);
}

function readTable(archive: JdkArchive): JdkSignatures | undefined {
  try {
    return parseJdkSignatures(generateJdkSignatures(archive));
  } catch (error) {
    if (error instanceof JdkSignaturesFault) return undefined;
    throw error;
  }
}
