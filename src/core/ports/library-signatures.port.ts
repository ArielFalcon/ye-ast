/** A method or constructor (`<init>`) of a library type, with its types as the generic signature writes them. */
export interface LibraryMember {
  name: string;
  typeParameters: readonly string[];
  parameters: readonly string[];
  returns: string;
  static: boolean;
  abstract: boolean;
  varargs: boolean;
}

/** The public and protected declarations of one library type; `typeOf` never answers a partial type. */
export interface LibraryType {
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  abstract: boolean;
  typeParameters: readonly string[];
  supertypes: readonly string[];
  members: readonly LibraryMember[];
}

/** Who the signatures came from: the declared JDK, its feature release, and the digest of the archive that was read. */
export interface LibraryBasis {
  vendor?: string;
  version: string;
  feature: number;
  release: number;
  basis: "declared-jdk";
  digest: string;
}

export interface LibrarySignatures {
  basis: LibraryBasis;
  /** The declaration of a type by its qualified name; `undefined` when the source does not hold exactly one for it. */
  typeOf(fqn: string): LibraryType | undefined;
}

/** The library signatures a snapshot read holds, by the longest declared `at` that contains a path. */
export interface LibraryReading {
  /** The signatures declared for the directory a path is in; `undefined` where none was declared or none was usable. */
  of(path: string): LibrarySignatures | undefined;
}

export type LibraryUnusableReason = "jdk-unreadable" | "release-not-held";

export type LibraryOutcome = { kind: "used"; signatures: LibrarySignatures } | { kind: "unused"; reason: LibraryUnusableReason };

/** Opens the signatures of a library the host declared at a host path. */
export interface LibrarySignatureSource {
  open(declared: { path: string }): LibraryOutcome;
}
