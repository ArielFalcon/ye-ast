import type { Node } from "web-tree-sitter";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { constantNamesOf } from "./java-ambiguous-names.ts";
import type { JavaMarker } from "./java-declaration-questions.ts";
import { CALL_REWRITING_ANNOTATIONS, DYNAMIC_IMPLEMENTATIONS, FUNCTION_VALUES, isAnonymous, isAspect, supertypesOf } from "./java-declared-types.ts";
import { withJavaSources } from "./java-project.ts";
import { createJavaProject, isTypeDeclaration, modifierWords, supertypeClauses, typeNodeName, type JavaFile, type TypeDecl, type TypeKind } from "./java-symbols.ts";

/** How a source reads: its declarations and bodies, its declarations only (each syntax error lies in a member body), no syntax tree, or declarations that cannot be listed. */
export type DeclarationState = { state: "read" } | { state: "declarations-only"; line: number } | { state: "unparsed"; line: number } | { state: "unreadable" };

export interface DeclaredType {
  /** With the package: `app.Outer.Inner`. */
  fqn: string;
  name: string;
  kind: TypeKind;
  /** The qualified name, without the package, of the type around it. */
  outer: string | null;
  modifiers: readonly string[];
  typeVariables: readonly string[];
  line: number;
  /** The supertype clauses as written, without type arguments, in source order. */
  supertypes: readonly { name: string; isInterface: boolean }[];
  /** The simple names of the annotations the type carries. */
  annotations: readonly string[];
  memberTypes: readonly string[];
  /** The `static final` fields the type declares. */
  constantNames: readonly string[];
}

export interface JavaHeader {
  packageName: string;
  singleImports: readonly (readonly [simple: string, qualified: string])[];
  conflictingSingleImports: readonly string[];
  onDemandImports: readonly string[];
  staticImports: readonly { className: string; member: string }[];
  staticOnDemandImports: readonly string[];
}

/** What the bodies of a file write that a derivation over another file may ask about, by name. */
export interface BodySummary {
  /** The simple names the anonymous and the local classes of the file write as supertypes. */
  unplacedSupertypes: readonly string[];
  /** The names its method references write. */
  methodReferences: readonly string[];
  holdsFunctionValue: boolean;
  markers: readonly JavaMarker[];
}

type Stated = DeclarationState & {
  header: JavaHeader;
  types: readonly DeclaredType[];
  body: BodySummary;
};

/** The plain data one Java file states about the names it declares and writes (ADR-0116); no syntax tree, no node. */
export type JavaDeclarations = Stated & {
  /** The digest of the file's content. */
  content: string;
  /** The digest of the state, the header and the declared types: what a body edit that moves no line keeps. */
  declarationsDigest: string;
};

const EMPTY_HEADER: JavaHeader = { packageName: "", singleImports: [], conflictingSingleImports: [], onDemandImports: [], staticImports: [], staticOnDemandImports: [] };
const EMPTY_BODY: BodySummary = { unplacedSupertypes: [], methodReferences: [], holdsFunctionValue: false, markers: [] };

/** What `source` declares and writes: read through the parser's declarations reading, as the held project reads it. */
export function declarationsOf(parser: JavaParser, source: SourceFile, fingerprint: (inputs: object) => string): JavaDeclarations {
  const content = fingerprint({ content: source.content });
  const declared = (read: Stated): JavaDeclarations => ({ ...read, content, declarationsDigest: fingerprint({ state: read.state, line: "line" in read ? read.line : 0, header: read.header, types: read.types }) });
  return withJavaSources(parser, (parse) => {
    const parsed = parse([source]);
    const file = parsed.files[0];
    if (file === undefined) return declared({ state: parsed.declared.length > 0 ? "declarations-only" : "unparsed", line: parsed.unparsed[0]?.line ?? 1, header: EMPTY_HEADER, types: [], body: EMPTY_BODY });
    const project = createJavaProject([file]);
    if (project.unreadable.length > 0) return declared({ state: "unreadable", header: headerOf(file), types: [], body: EMPTY_BODY });
    return declared({ state: "read", header: headerOf(file), types: project.types.map(declaredType), body: bodyOf(file, project.types) });
  });
}

function headerOf(file: JavaFile): JavaHeader {
  return {
    packageName: file.packageName,
    singleImports: [...file.singleImports],
    conflictingSingleImports: [...file.conflictingSingleImports].toSorted(),
    onDemandImports: file.onDemandImports,
    staticImports: file.staticImports,
    staticOnDemandImports: file.staticOnDemandImports,
  };
}

export function declaredType(type: TypeDecl): DeclaredType {
  return {
    fqn: type.fqn,
    name: type.name,
    kind: type.kind,
    outer: type.outer?.qualifiedName ?? null,
    modifiers: modifierWords(type.node),
    typeVariables: [...type.typeVariables],
    line: (type.node.childForFieldName("name") ?? type.node).startPosition.row + 1,
    supertypes: supertypeClauses(type).map(({ node, isInterface }) => ({ name: typeNodeName(node), isInterface })),
    annotations: annotationNames(type.node),
    memberTypes: [...type.members.keys()],
    constantNames: constantNamesOf(type).map((name) => name.text),
  };
}

function annotationNames(declaration: Node): string[] {
  const modifiers = declaration.namedChildren.find((child) => child?.type === "modifiers");
  return (modifiers?.namedChildren ?? []).flatMap((child) => (child?.type === "marker_annotation" || child?.type === "annotation" ? [simpleName(child.childForFieldName("name")?.text ?? "")] : []));
}

const simpleName = (written: string): string => written.split(".").at(-1) ?? "";

export function bodyOf(file: JavaFile, types: readonly TypeDecl[]): BodySummary {
  const placed = new Set(types.map((type) => type.node.id));
  const unplaced = new Set<string>();
  const references = new Set<string>();
  const markers = new Set<JavaMarker>();
  let holdsFunctionValue = false;
  const pending: Node[] = [file.root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (FUNCTION_VALUES.has(node.type)) holdsFunctionValue = true;
    if (node.type === "method_reference") {
      const written = node.namedChildren.at(-1)?.text;
      if (written !== undefined) references.add(written);
    }
    if ((isTypeDeclaration(node) && !placed.has(node.id)) || isAnonymous(node)) for (const supertype of supertypesOf(node)) unplaced.add(simpleName(typeNodeName(supertype)));
    if ((node.type === "marker_annotation" || node.type === "annotation") && CALL_REWRITING_ANNOTATIONS.has(simpleName(node.childForFieldName("name")?.text ?? ""))) markers.add("call-rewriting");
    if (isAspect(node)) markers.add("aspect");
    if ((node.type === "identifier" || node.type === "type_identifier") && DYNAMIC_IMPLEMENTATIONS.has(node.text)) markers.add("dynamic-implementation");
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return { unplacedSupertypes: [...unplaced].sort(), methodReferences: [...references].sort(), holdsFunctionValue, markers: [...markers].sort() };
}
