/** The slot of the per-file declarations fact (ADR-0116). */
export const JAVA_DECLARATIONS_SLOT = "java-declarations";

export const NAMING_KINDS = ["supertype", "unplaced-supertype", "method-reference", "annotation", "constant"] as const;
export type NamingKind = (typeof NAMING_KINDS)[number];

/** What a file holds that a derivation over another file may ask about without reading its syntax. */
export const JAVA_MARKERS = ["call-rewriting", "dynamic-implementation", "aspect", "introduction"] as const;
export type JavaMarker = (typeof JAVA_MARKERS)[number];

/** Whether a source declares a package that is the name or lies below it (`prefix`), or declares a type in the package of that name (`typed`). */
export const PACKAGE_QUESTIONS = ["prefix", "typed"] as const;
export type PackageQuestion = (typeof PACKAGE_QUESTIONS)[number];

export const BUILD_PARTS = ["claimed", "generatesInterfaces"] as const;
export type BuildPart = (typeof BUILD_PARTS)[number];

/** The questions a derivation asks of the declaration index, as the strings a record keeps (RFC-0039 section 3.2). */
export const questions = {
  file: (path: string): string => `file|${path}`,
  declarations: (path: string): string => `declarations|${path}`,
  declaring: (qualifiedName: string): string => `declaring|${qualifiedName}`,
  package: (kind: PackageQuestion, name: string): string => `package|${kind}|${name}`,
  named: (simpleName: string): string => `named|${simpleName}`,
  naming: (kind: NamingKind, name: string): string => `naming|${kind}|${name}`,
  marked: (marker: JavaMarker): string => `marked|${marker}`,
  unread: (): string => "unread",
  build: (part: BuildPart): string => `build|${part}`,
  listing: (): string => "listing",
};
