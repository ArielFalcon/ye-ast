import type { Node } from "web-tree-sitter";
import { declaresInScope, declaresLocal, type DeclaredVariables } from "../tree-sitter/java-declared-variables.ts";
import type { JavaAmbiguousName } from "../tree-sitter/java-relations.adapter.ts";
import { externalNames, isTypeDeclaration, MEMBERLESS_PLATFORM_INTERFACES, supertypeClauses, typeNodeName, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";

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

function strongest(readings: readonly Obscuring[]): Obscuring {
  return readings.includes("variable") ? "variable" : readings.includes("maybe") ? "maybe" : undefined;
}

/** The fields the type bodies around `node` declare or inherit, innermost first: an anonymous or a local class included. */
function enclosingScopes(node: Node, file: JavaFile, owner: TypeDecl, project: JavaProject, head: string): Obscuring[] {
  const readings: Obscuring[] = [];
  for (let around = node.parent; around !== null; around = around.parent) {
    const declared = isTypeDeclaration(around) ? project.types.find((type) => type.file === file && type.node.id === around.id) : undefined;
    if (declared !== undefined) readings.push(fieldsOf(declared.node, head, "own") ?? inheritedField(declared, head, new Set([declared]), project));
    else if (isTypeDeclaration(around) || (around.type === "class_body" && around.parent?.type === "object_creation_expression")) {
      const supertypes = around.type === "class_body" ? [around.parent!.childForFieldName("type")] : [around.childForFieldName("superclass")?.namedChildren[0] ?? null, ...(around.childForFieldName("interfaces")?.namedChildren.find((child) => child?.type === "type_list")?.namedChildren ?? [])];
      const body = around.type === "class_body" ? around.parent! : around;
      readings.push(fieldsOf(body, head, "own") ?? strongest(supertypes.filter((written) => written !== null).map((written) => throughSupertype(typeNodeName(written!), { file, type: owner }, head, file.packageName, new Set(), project))));
    }
  }
  return readings;
}

function inheritedField(type: TypeDecl, head: string, visited: Set<TypeDecl>, project: JavaProject): Obscuring {
  return strongest(supertypeClauses(type).map(({ node }) => throughSupertype(typeNodeName(node), { file: type.file, type: type.outer }, head, type.file.packageName, visited, project)));
}

function throughSupertype(written: string, scope: { file: JavaFile; type: TypeDecl | undefined }, head: string, from: string, visited: Set<TypeDecl>, project: JavaProject): Obscuring {
  const found = project.lookupType(written, scope);
  if (found === undefined) return externalNames(written, scope.file, false).every((fqn) => MEMBERLESS_PLATFORM_INTERFACES.has(fqn) || fqn === "java.lang.Object") ? undefined : "maybe";
  if (found === "ambiguous") return "maybe";
  if (visited.has(found)) return undefined;
  visited.add(found);
  return fieldsOf(found.node, head, found.file.packageName === from ? "package" : "outside") ?? inheritedField(found, head, visited, project);
}

/**
 * Whether a type body declares a field of the name that is in scope from where it is read: its own body sees every
 * field, a subclass or a static import every field but a private one, and one outside the package no package-private one.
 */
function fieldsOf(declaration: Node, head: string, from: "own" | "package" | "outside"): Obscuring {
  const body = declaration.childForFieldName("body");
  const members = body === null ? [] : body.namedChildren.flatMap((child) => (child?.type === "enum_body_declarations" ? child.namedChildren : [child]));
  const components = declaration.type === "record_declaration" ? (declaration.childForFieldName("parameters")?.namedChildren ?? []).map((parameter) => ({ name: parameter?.childForFieldName("name")?.text, access: "private" })) : [];
  const fields = members.flatMap((member) => {
    if (member?.type === "enum_constant") return [{ name: member.childForFieldName("name")?.text, access: "public" }];
    if (member?.type === "constant_declaration") return member.childrenForFieldName("declarator").map((declarator) => ({ name: declarator?.childForFieldName("name")?.text, access: "public" }));
    if (member?.type !== "field_declaration") return [];
    const words = member.namedChildren.find((child) => child?.type === "modifiers")?.children.map((word) => word?.text) ?? [];
    const access = words.includes("private") ? "private" : words.includes("public") || words.includes("protected") || declaration.type === "interface_declaration" ? "public" : "package";
    return member.childrenForFieldName("declarator").map((declarator) => ({ name: declarator?.childForFieldName("name")?.text, access }));
  });
  const visible = (access: string) => from === "own" || (access !== "private" && (from === "package" || access === "public"));
  return [...components, ...fields].some((field) => field.name === head && visible(field.access)) ? "variable" : undefined;
}
