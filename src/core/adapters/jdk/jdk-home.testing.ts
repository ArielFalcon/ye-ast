import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipBytes } from "./archive.testing.ts";
import { ACC_ABSTRACT, ACC_INTERFACE, ACC_PUBLIC, buildClass, type ClassSpec } from "./class-file.testing.ts";

/** One `.sig` of a synthetic `ct.sym`: the release sets it covers, an optional module directory, and the class it holds. */
export interface SyntheticSignature {
  set: string;
  /** `null` writes the layout without a module directory (JDK 11); absent writes `java.base`. */
  module?: string | null;
  spec: ClassSpec;
}

export interface SyntheticHome {
  signatures: readonly SyntheticSignature[];
  /** The text of the `release` file; absent writes none. */
  release?: string;
  /** Raw members instead of signatures, for an archive of another layout. */
  members?: readonly { name: string; content: string | Buffer }[];
}

export const TEMURIN_RELEASE = 'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="25.0.5"\nJAVA_RUNTIME_VERSION="25.0.5+10-LTS"\n';

export const OBJECT_SPEC: ClassSpec = { access: ACC_PUBLIC, name: "java/lang/Object", superName: null };

/** A `java.util.function.Function` with one abstract method, which is all the readers of the library need to see. */
export const FUNCTION_SPEC: ClassSpec = {
  access: ACC_PUBLIC | ACC_INTERFACE | ACC_ABSTRACT,
  name: "java/util/function/Function",
  signature: "<T:Ljava/lang/Object;R:Ljava/lang/Object;>Ljava/lang/Object;",
  members: [{ flags: ACC_PUBLIC | ACC_ABSTRACT, name: "apply", descriptor: "(Ljava/lang/Object;)Ljava/lang/Object;", signature: "(TT;)TR;" }],
};

/** Writes a JDK home under `directory` from hand-written bytes: `lib/ct.sym` and, when given, `release`. */
export async function writeJdkHome(directory: string, home: SyntheticHome): Promise<string> {
  await mkdir(join(directory, "lib"), { recursive: true });
  const members = home.members ?? home.signatures.map(({ set, module, spec }) => ({
    name: [set, ...(module === null ? [] : [module ?? "java.base"]), `${spec.name}.sig`].join("/"),
    content: buildClass(spec),
  }));
  await writeFile(join(directory, "lib", "ct.sym"), zipBytes(members));
  if (home.release !== undefined) await writeFile(join(directory, "release"), home.release);
  return directory;
}
