import type { Node } from "web-tree-sitter";
import { resolve } from "./java-declared-types.ts";
import type { JavaFile, JavaProject, TypeDecl } from "./java-symbols.ts";

/**
 * A member the sources do not declare but a record or a Lombok annotation on the class adds (ADR-0066). `accessor`
 * returns the field's declared type; `mutator` returns nothing; `builder` yields the builder of `of`, which has the
 * fields' setters and `build()`; `built` yields `of`.
 */
export type GeneratedMember =
  | { kind: "accessor"; type: Node | undefined; file: JavaFile }
  | { kind: "mutator" }
  | { kind: "builder"; of: TypeDecl }
  | { kind: "built"; of: TypeDecl };

interface Field {
  name: string;
  type: Node | undefined;
  isStatic: boolean;
  isFinal: boolean;
  hasInitializer: boolean;
  annotations: readonly Node[];
}

const LOMBOK = "lombok.";
const ACCESSOR_TYPES: ReadonlySet<string> = new Set(["lombok.Getter", "lombok.Setter", "lombok.Data", "lombok.Value"]);
/** Annotations by which Lombok changes the names or the shape of what it generates, which the vocabulary below does not model. */
const UNMODELLED: ReadonlySet<string> = new Set(["lombok.experimental.Accessors", "lombok.experimental.SuperBuilder", "lombok.Singular", "lombok.experimental.FieldNameConstants"]);

/**
 * The member of `name` and `arity` that `type` is generated. None when the class is not annotated for it, a relevant
 * annotation carries an argument (an access level, a prefix, a rename) or is a name-changing one, or the class declares a
 * method of that name and arity itself: the declaration wins (Lombok skips a member that exists, ignoring case).
 */
export function generatedMember(type: TypeDecl, project: JavaProject, name: string, arity: number): GeneratedMember | undefined {
  if (type.methods.some((method) => method.name.toLowerCase() === name.toLowerCase() && method.parameterTypes.length === arity)) return undefined;
  if (type.node.type === "record_declaration") return recordAccessor(type, name, arity);
  if (type.kind !== "class" || type.node.type !== "class_declaration") return undefined;
  if (name === "builder" && arity === 0) return builderFields(type, project) === undefined ? undefined : { kind: "builder", of: type };
  return accessorOf(type, project, name, arity);
}

/** The member of `name` and `arity` that the builder of `of` is generated: a field's setter, and `build()`. */
export function builderMember(of: TypeDecl, project: JavaProject, name: string, arity: number): GeneratedMember | undefined {
  const fields = builderFields(of, project);
  if (fields === undefined) return undefined;
  if (name === "build" && arity === 0) return { kind: "built", of };
  return arity === 1 && fields.some((field) => field.name === name) ? { kind: "builder", of } : undefined;
}

function recordAccessor(type: TypeDecl, name: string, arity: number): GeneratedMember | undefined {
  if (arity !== 0) return undefined;
  const component = (type.node.childForFieldName("parameters")?.namedChildren ?? []).find((node) => node?.type === "formal_parameter" && node.childForFieldName("name")?.text === name);
  return component === undefined ? undefined : { kind: "accessor", type: component.childForFieldName("type") ?? undefined, file: type.file };
}

function accessorOf(type: TypeDecl, project: JavaProject, name: string, arity: number): GeneratedMember | undefined {
  const classLevel = lombokAnnotations(type.node, type, project);
  if (classLevel === undefined) return undefined;
  const fields = fieldsOf(type);
  if (fields.some((field) => lombokAnnotations(field.annotations, type, project) === undefined)) return undefined;
  const wants = (kinds: readonly string[], field: Field) => [...classLevel, ...(lombokAnnotations(field.annotations, type, project) ?? [])].some((fqn) => kinds.includes(fqn));
  for (const field of fields) {
    if (field.isStatic) continue;
    const pair = accessorNames(field);
    if (pair.getter === name && arity === 0 && wants(["lombok.Getter", "lombok.Data", "lombok.Value"], field) && !field.name.startsWith("$")) return { kind: "accessor", type: field.type, file: type.file };
    const settable = !field.isFinal && !classLevel.includes("lombok.Value");
    if (pair.setter === name && arity === 1 && settable && wants(["lombok.Setter", "lombok.Data"], field)) return { kind: "mutator" };
  }
  return undefined;
}

/** The fields a `@Builder` class's builder sets; none when the class carries no plain `@Builder` or declares what the builder would. */
function builderFields(type: TypeDecl, project: JavaProject): Field[] | undefined {
  const annotations = lombokAnnotations(type.node, type, project);
  if (annotations === undefined || !annotations.includes("lombok.Builder")) return undefined;
  if (type.members.has(`${type.name}Builder`)) return undefined;
  const fields = fieldsOf(type);
  if (fields.some((field) => lombokAnnotations(field.annotations, type, project) === undefined)) return undefined;
  return fields.filter((field) => !field.isStatic && !(field.isFinal && field.hasInitializer));
}

/** Lombok's accessor names for a field: `is` for a primitive `boolean`, and the field's own `is` prefix kept by the pair. */
function accessorNames(field: Field): { getter: string; setter: string } {
  const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  if (field.type?.text === "boolean") {
    const prefixed = /^is[A-Z]/.test(field.name);
    return { getter: prefixed ? field.name : `is${upper(field.name)}`, setter: `set${prefixed ? field.name.slice(2) : upper(field.name)}` };
  }
  return { getter: `get${upper(field.name)}`, setter: `set${upper(field.name)}` };
}

function fieldsOf(type: TypeDecl): Field[] {
  const body = type.node.childForFieldName("body");
  return (body?.namedChildren ?? []).flatMap((member) => {
    if (member.type !== "field_declaration") return [];
    const modifiers = member.namedChildren.find((child) => child.type === "modifiers");
    const words = modifiers?.children.map((child) => child?.text) ?? [];
    return member.namedChildren.filter((child) => child.type === "variable_declarator").map((declarator): Field => ({
      name: declarator.childForFieldName("name")?.text ?? "",
      type: member.childForFieldName("type") ?? undefined,
      isStatic: words.includes("static"),
      isFinal: words.includes("final"),
      hasInitializer: declarator.childForFieldName("value") !== null,
      annotations: modifiers?.namedChildren ?? [],
    }));
  });
}

/**
 * The Lombok annotation types a declaration (or a list of its annotations) carries; none when one carries an argument or
 * is a name-changing annotation, since the generated names or access are then not those of the plain annotation.
 */
function lombokAnnotations(declaration: Node | readonly Node[], type: TypeDecl, project: JavaProject): string[] | undefined {
  const nodes = Array.isArray(declaration) ? declaration : (declaration as Node).namedChildren.find((child) => child.type === "modifiers")?.namedChildren ?? [];
  const found: string[] = [];
  for (const annotation of nodes) {
    if (annotation.type !== "annotation" && annotation.type !== "marker_annotation") continue;
    const name = annotation.childForFieldName("name");
    const resolved = name === null ? undefined : resolve(name, type.file, project, type, name, true);
    if (resolved === undefined || resolved.kind === "repository" || !("fqn" in resolved) || !resolved.fqn.startsWith(LOMBOK)) continue;
    if (UNMODELLED.has(resolved.fqn)) return undefined;
    if (!ACCESSOR_TYPES.has(resolved.fqn) && resolved.fqn !== "lombok.Builder") continue;
    if ((annotation.childForFieldName("arguments")?.namedChildren.length ?? 0) > 0) return undefined;
    found.push(resolved.fqn);
  }
  return found;
}
