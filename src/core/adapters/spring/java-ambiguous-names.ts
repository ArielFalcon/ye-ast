import type { Node } from "web-tree-sitter";
import { declaresInScope, declaresLocal, type DeclaredVariables } from "../tree-sitter/java-declared-variables.ts";
import type { JavaAmbiguousName, JavaSimpleName } from "../tree-sitter/java-relations.adapter.ts";
import { PLATFORM_TYPE_NAMES } from "./java-platform-type-names.ts";
import { externalNames, isTypeDeclaration, MEMBERLESS_PLATFORM_INTERFACES, qualifiedTypeName, supertypeClauses, typeNodeName, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";

/** A repository type an expression's name begins with: `settled` unless a variable the sources do not show may obscure its first segment. */
export interface DenotedType {
  name: string;
  settled: boolean;
}

type Obscuring = "variable" | "maybe" | undefined;

/**
 * The repository type a name written in an expression denotes through a package or a member type, read as Java
 * reclassifies an ambiguous name (JLS 6.5.2) under the assumption that the repository compiles (ADR-0062): a variable in
 * scope of its first segment makes it an expression, otherwise its shortest prefix that names a type of the repository,
 * extended by the member types its next segments name. A name whose type is its first segment alone is not one, and
 * neither is a name no prefix of which names a repository type. When the sources do not show every variable that may be
 * in scope (a supertype outside them, a local whose scope they leave open), the type is not settled; a static import, and
 * a supertype outside them of a type they declare, already leave the strict reading of the name itself unsettled
 * (`JavaProject.resolveTypeName`).
 */
export function typeOfAmbiguousName(name: JavaAmbiguousName, file: JavaFile, owner: TypeDecl, project: JavaProject, locals: DeclaredVariables): DenotedType | undefined {
  const { segments, typeSegments, node } = name;
  const prefix = (end: number) => segments.slice(0, end).join(".");
  const scope = { file, type: owner };
  let end = 1;
  while (end <= typeSegments && project.lookupType(prefix(end), scope) === undefined) end++;
  if (end > typeSegments) return undefined;
  while (end < typeSegments && typeof project.lookupType(prefix(end), scope) === "object" && project.lookupType(prefix(end + 1), scope) !== undefined) end++;
  if (end === 1) return undefined;
  const head = segments[0]!;
  const obscuring = declaresInScope(head, node) ? "variable" : strongest([...enclosingScopes(node, file, owner, project, head), declaresLocal(locals, head, node) ? "maybe" : undefined]);
  return obscuring === "variable" ? undefined : { name: prefix(end), settled: obscuring === undefined };
}

/** The repository types a simple name denotes a member of through the file's static imports: `settled` when nothing else may bind it. */
export interface ImportedMemberOwners {
  types: readonly TypeDecl[];
  settled: boolean;
}

/** `certain`: every type that binds the name is known to declare or inherit the member. */
type Offered = ImportedMemberOwners & { certain: boolean };

/**
 * The static imports of a file, read once per file: per import, the repository types its class name denotes, none when
 * the repository declares none; `single` by the member each one names.
 */
export interface StaticImports {
  file: JavaFile;
  single: ReadonlyMap<string, readonly (readonly TypeDecl[])[]>;
  onDemand: readonly (readonly TypeDecl[])[];
  members: Map<string, Obscuring>;
}

/** The file's static imports, or nothing when none of them names a type the repository declares. */
export function staticImportsOf(file: JavaFile, typesByFqn: ReadonlyMap<string, readonly TypeDecl[]>): StaticImports | undefined {
  const imported = (className: string): readonly TypeDecl[] => typesByFqn.get(className) ?? [];
  const single = Map.groupBy(file.staticImports, ({ member }) => member);
  const imports: StaticImports = { file, single: new Map([...single].map(([member, entries]) => [member, entries.map(({ className }) => imported(className))])), onDemand: file.staticOnDemandImports.map(imported), members: new Map() };
  return [...imports.single.values(), imports.onDemand].some((entries) => entries.some((types) => types.length > 0)) ? imports : undefined;
}

type Offer = { type: TypeDecl | undefined; has: "yes" | "maybe" };

/**
 * The repository types whose static member a simple name read in an expression denotes through a static import (JLS
 * 6.4.1, 7.5.3, 7.5.4, 15.12.1), under the assumption that the repository compiles (ADR-0062). A variable in scope, or a
 * field the type bodies around it declare or inherit, obscures a static import of a field, and a method they declare or
 * inherit one of a method; a single-static import of a field shadows the on-demand ones, while methods of every static
 * import overload one another. A static import of a type the repository does not declare may bring any member; one of a
 * repository type brings the static members the type declares or inherits that are accessible from the file. The answer
 * is settled when one import is the only one that may bind the name, or a field it brings is certain, and nothing around
 * the name that the sources do not show may obscure it. The first identifier of a qualified name may also be a type: one
 * the file names binds it unless a member is certain, and any other leaves it unsettled.
 */
export function typesOfStaticImport(name: JavaSimpleName, imports: StaticImports, owner: TypeDecl | undefined, project: JavaProject, locals: DeclaredVariables): ImportedMemberOwners | undefined {
  const { node, kind } = name;
  const head = node.text;
  const wanted: Wanted = { member: kind === "method" ? "method" : "field", onlyStatic: true, enumConstants: kind !== "case" };
  const offers = (entries: readonly (readonly TypeDecl[])[]): Offer[] => entries.flatMap((types): Offer[] => (types.length === 0 ? [{ type: undefined, has: "maybe" }] : types.flatMap((type): Offer[] => {
    const has = importedMember(type, head, wanted, imports, project);
    return has === undefined ? [] : [{ type, has: has === "variable" ? "yes" : "maybe" }];
  })));
  const single = offers(imports.single.get(head) ?? []);
  const onDemand = offers(imports.onDemand);
  const offered = wanted.member === "method" ? decide([...single, ...onDemand], false) : single.some(({ has }) => has === "yes") ? decide(single, true) : single.length === 0 ? decide(onDemand, true) : decide([...single, ...onDemand], false);
  if (offered === undefined || (kind === "qualifier" && !offered.certain && namesType(head, imports.file, owner, project))) return undefined;
  const settled = offered.settled && (kind !== "qualifier" || offered.certain);
  const obscuring = wanted.member === "field" && declaresInScope(head, node) ? "variable" : strongest([...enclosingScopes(node, imports.file, owner, project, head, { ...wanted, onlyStatic: false, enumConstants: true }), wanted.member === "field" && declaresLocal(locals, head, node) ? "maybe" : undefined]);
  return obscuring === "variable" ? undefined : { types: offered.types, settled: settled && obscuring === undefined };
}

function namesType(head: string, file: JavaFile, owner: TypeDecl | undefined, project: JavaProject): boolean {
  return qualifiedTypeName(head, { file, type: owner }, project) !== undefined || ["java.lang", ...file.onDemandImports].some((container) => PLATFORM_TYPE_NAMES.get(container)?.has(head) === true);
}

/** Which offers bind the name: a certain field when `certainBinds` (two would make it ambiguous), all when every one is certain, the only one when there is one. */
function decide(offers: readonly Offer[], certainBinds: boolean): Offered | undefined {
  const types = [...new Set(offers.flatMap(({ type }) => (type === undefined ? [] : [type])))];
  if (types.length === 0) return undefined;
  const certain = offers.filter(({ has }) => has === "yes").map(({ type }) => type!);
  if (certainBinds && certain.length > 0) return { types: [...new Set(certain)], settled: true, certain: true };
  const everyCertain = offers.every(({ has }) => has === "yes");
  return { types, settled: offers.length === 1 || everyCertain, certain: everyCertain };
}

function importedMember(type: TypeDecl, head: string, wanted: Wanted, imports: StaticImports, project: JavaProject): Obscuring {
  const key = `${type.fqn}\0${type.node.id}\0${wanted.member}\0${wanted.enumConstants}\0${head}`;
  if (imports.members.has(key)) return imports.members.get(key);
  const from = type.file.packageName === imports.file.packageName ? "package" : "outside";
  const has = membersOf(type.node, head, from, wanted) ?? inheritedMember(type, head, new Set([type]), project, wanted);
  imports.members.set(key, has);
  return has;
}

function strongest(readings: readonly Obscuring[]): Obscuring {
  return readings.includes("variable") ? "variable" : readings.includes("maybe") ? "maybe" : undefined;
}

/** The members the type bodies around `node` declare or inherit, innermost first: an anonymous or a local class included. */
function enclosingScopes(node: Node, file: JavaFile, owner: TypeDecl | undefined, project: JavaProject, head: string, wanted: Wanted = VARIABLE): Obscuring[] {
  const readings: Obscuring[] = [];
  for (let around = node.parent; around !== null; around = around.parent) {
    const declared = isTypeDeclaration(around) ? project.types.find((type) => type.file === file && type.node.id === around.id) : undefined;
    if (declared !== undefined) readings.push(membersOf(declared.node, head, "own", wanted) ?? inheritedMember(declared, head, new Set([declared]), project, wanted));
    else if (isTypeDeclaration(around) || (around.type === "class_body" && around.parent?.type === "object_creation_expression")) {
      const supertypes = around.type === "class_body" ? [around.parent!.childForFieldName("type")] : [around.childForFieldName("superclass")?.namedChildren[0] ?? null, ...(around.childForFieldName("interfaces")?.namedChildren.find((child) => child?.type === "type_list")?.namedChildren ?? [])];
      const body = around.type === "class_body" ? around.parent! : around;
      readings.push(membersOf(body, head, "own", wanted) ?? strongest(supertypes.filter((written) => written !== null).map((written) => throughSupertype(typeNodeName(written!), { file, type: owner }, head, file.packageName, new Set(), project, wanted))));
    }
  }
  return readings;
}

function inheritedMember(type: TypeDecl, head: string, visited: Set<TypeDecl>, project: JavaProject, wanted: Wanted): Obscuring {
  return strongest(supertypeClauses(type).map(({ node }) => throughSupertype(typeNodeName(node), { file: type.file, type: type.outer }, head, type.file.packageName, visited, project, wanted)));
}

function throughSupertype(written: string, scope: { file: JavaFile; type: TypeDecl | undefined }, head: string, from: string, visited: Set<TypeDecl>, project: JavaProject, wanted: Wanted): Obscuring {
  const found = project.lookupType(written, scope);
  if (found === undefined) return externalNames(written, scope.file, false).every((fqn) => MEMBERLESS_PLATFORM_INTERFACES.has(fqn) || fqn === "java.lang.Object") ? undefined : "maybe";
  if (found === "ambiguous") return "maybe";
  if (visited.has(found)) return undefined;
  visited.add(found);
  return membersOf(found.node, head, found.file.packageName === from ? "package" : "outside", wanted) ?? inheritedMember(found, head, visited, project, wanted);
}

/** The member kind a name is looked up as: a field or a method, only a static one, and whether an enum constant counts. */
interface Wanted {
  member: "field" | "method";
  onlyStatic: boolean;
  enumConstants: boolean;
}

const VARIABLE: Wanted = { member: "field", onlyStatic: false, enumConstants: true };

/**
 * Whether a type body declares a member of the name that is in scope from where it is read: its own body sees every
 * member, a subclass or a static import every member but a private one, and one outside the package no package-private
 * one. An enum declares its `values` and `valueOf`, and a record an accessor per component.
 */
function membersOf(declaration: Node, head: string, from: "own" | "package" | "outside", wanted: Wanted): Obscuring {
  const body = declaration.childForFieldName("body");
  const members = body === null ? [] : body.namedChildren.flatMap((child) => (child?.type === "enum_body_declarations" ? child.namedChildren : [child]));
  const interfaceLike = declaration.type === "interface_declaration" || declaration.type === "annotation_type_declaration";
  const components = (declaration.type === "record_declaration" ? declaration.childForFieldName("parameters")?.namedChildren ?? [] : []).map((parameter) => parameter?.childForFieldName("name")?.text);
  const declared = wanted.member === "field" ? fieldsIn(members, interfaceLike, wanted) : methodsIn(members, interfaceLike);
  const implicit = wanted.member === "field"
    ? components.map((name) => ({ name, access: "private", isStatic: false }))
    : [...components.map((name) => ({ name, access: "public", isStatic: false })), ...(declaration.type === "enum_declaration" ? ["values", "valueOf"].map((name) => ({ name, access: "public", isStatic: true })) : [])];
  const visible = (access: string) => from === "own" || (access !== "private" && (from === "package" || access === "public"));
  return [...implicit, ...declared].some((member) => member.name === head && visible(member.access) && (member.isStatic || !wanted.onlyStatic)) ? "variable" : undefined;
}

type Declared = { name: string | undefined; access: string; isStatic: boolean };

function modifierWords(member: Node): (string | undefined)[] {
  return member.namedChildren.find((child) => child?.type === "modifiers")?.children.map((word) => word?.text) ?? [];
}

function accessOf(words: readonly (string | undefined)[], interfaceLike: boolean): string {
  return words.includes("private") ? "private" : words.includes("public") || words.includes("protected") || interfaceLike ? "public" : "package";
}

function fieldsIn(members: readonly (Node | null)[], interfaceLike: boolean, wanted: Wanted): Declared[] {
  return members.flatMap((member) => {
    if (member?.type === "enum_constant") return wanted.enumConstants ? [{ name: member.childForFieldName("name")?.text, access: "public", isStatic: true }] : [];
    if (member?.type === "constant_declaration") return member.childrenForFieldName("declarator").map((declarator) => ({ name: declarator?.childForFieldName("name")?.text, access: "public", isStatic: true }));
    if (member?.type !== "field_declaration") return [];
    const words = modifierWords(member);
    const isStatic = interfaceLike || words.includes("static");
    return member.childrenForFieldName("declarator").map((declarator) => ({ name: declarator?.childForFieldName("name")?.text, access: accessOf(words, interfaceLike), isStatic }));
  });
}

function methodsIn(members: readonly (Node | null)[], interfaceLike: boolean): Declared[] {
  return members.flatMap((member) => {
    if (member?.type === "annotation_type_element_declaration") return [{ name: member.childForFieldName("name")?.text, access: "public", isStatic: false }];
    if (member?.type !== "method_declaration") return [];
    const words = modifierWords(member);
    return [{ name: member.childForFieldName("name")?.text, access: accessOf(words, interfaceLike), isStatic: words.includes("static") }];
  });
}
