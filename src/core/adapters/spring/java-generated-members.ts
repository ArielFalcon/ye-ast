import type { Node } from "web-tree-sitter";
import { resolve } from "./java-declared-types.ts";
import type { JavaFile, JavaProject, TypeDecl } from "./java-symbols.ts";

/**
 * A member the sources do not declare but a record or a Lombok annotation on the class adds (ADR-0067), or one a Spring
 * Data repository interface has its proxy supply (`proxied`, ADR-0070). `accessor`
 * returns the field's declared type; `mutator` returns nothing; `builder` yields the builder of `of`, which has the
 * fields' setters and `build()`; `built` yields `of`.
 */
export type GeneratedMember =
  | { kind: "accessor"; type: Node | undefined; file: JavaFile }
  | { kind: "mutator" }
  | { kind: "builder"; of: TypeDecl }
  | { kind: "built"; of: TypeDecl }
  | { kind: "proxied" };

interface Field {
  name: string;
  type: Node | undefined;
  isStatic: boolean;
  isFinal: boolean;
  hasInitializer: boolean;
  annotations: readonly Node[];
}

const LOMBOK = "lombok.";
const GETTER = "lombok.Getter";
const SETTER = "lombok.Setter";
const GETTER_FAMILY: ReadonlySet<string> = new Set([GETTER, "lombok.Data", "lombok.Value"]);
const SETTER_FAMILY: ReadonlySet<string> = new Set([SETTER, "lombok.Data"]);
const ACCESSOR_TYPES: ReadonlySet<string> = new Set([GETTER, SETTER, "lombok.Data", "lombok.Value"]);
const BUILDER = "lombok.Builder";
const SUPER_BUILDER = "lombok.experimental.SuperBuilder";
const BUILDER_DEFAULT = "lombok.Builder.Default";
const ACCESS_LEVEL = "lombok.AccessLevel.";
const ACCESS_LEVELS: ReadonlySet<string> = new Set(["PUBLIC", "MODULE", "PROTECTED", "PACKAGE", "PRIVATE", "NONE"]);
/** Annotations by which Lombok changes the names or the shape of what it generates, which the vocabulary below does not model. */
const UNMODELLED: ReadonlySet<string> = new Set(["lombok.experimental.Accessors", "lombok.Singular", "lombok.experimental.FieldNameConstants"]);

/** A Lombok annotation of the modelled vocabulary on a declaration; `none` when its access level is `AccessLevel.NONE`, which generates nothing. */
interface LombokUse {
  fqn: string;
  none: boolean;
}

/**
 * The member of `name` and `arity` that `type` is generated, or inherits from a superclass of the project that is. None
 * when the class is not annotated for it, a relevant annotation carries an argument the vocabulary does not model or is a
 * name-changing one, or the class declares a method of that name and arity itself: the declaration wins (Lombok skips a
 * member that exists, ignoring case). The caller proves the hierarchy closed.
 */
export function generatedMember(type: TypeDecl, project: JavaProject, name: string, arity: number): GeneratedMember | undefined {
  if (type.methods.some((method) => method.name.toLowerCase() === name.toLowerCase() && method.parameterTypes.length === arity)) return undefined;
  if (type.node.type === "record_declaration") return recordAccessor(type, name, arity);
  if (type.kind !== "class" || type.node.type !== "class_declaration") return undefined;
  if (name === "builder" && arity === 0) return builderFields(type, project) === undefined ? undefined : { kind: "builder", of: type };
  return inheritedAccessor(type, project, name, arity);
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

/** The nearest class of the chain that generates the accessor; none once a class of it leaves its members unsettled. */
function inheritedAccessor(type: TypeDecl, project: JavaProject, name: string, arity: number): GeneratedMember | undefined {
  for (const owner of project.classChain(type)) {
    const made = accessorOf(owner, project, name, arity);
    if (made !== undefined) return made;
    if (!isSettled(owner, project)) return undefined;
  }
  return undefined;
}

/** Whether every Lombok annotation of the class and of its fields is one the vocabulary models. */
function isSettled(type: TypeDecl, project: JavaProject): boolean {
  return lombokAnnotations(type.node, type, project) !== undefined && fieldsOf(type).every((field) => lombokAnnotations(field.annotations, type, project) !== undefined);
}

function accessorOf(type: TypeDecl, project: JavaProject, name: string, arity: number): GeneratedMember | undefined {
  const classLevel = lombokAnnotations(type.node, type, project);
  if (classLevel === undefined) return undefined;
  const fields = fieldsOf(type);
  const fieldLevel = new Map<Field, LombokUse[]>();
  for (const field of fields) {
    const uses = lombokAnnotations(field.annotations, type, project);
    if (uses === undefined) return undefined;
    fieldLevel.set(field, uses);
  }
  const generatesAll = classLevel.some((use) => use.fqn === "lombok.Data" || use.fqn === "lombok.Value");
  if (generatesAll && classLevel.some((use) => (use.fqn === GETTER || use.fqn === SETTER) && use.none)) return undefined;
  const wants = (single: string, family: ReadonlySet<string>, field: Field): boolean => {
    const own = fieldLevel.get(field)!.find((use) => use.fqn === single);
    if (own !== undefined) return !own.none;
    return classLevel.some((use) => family.has(use.fqn) && !use.none);
  };
  const isValue = classLevel.some((use) => use.fqn === "lombok.Value");
  for (const field of fields) {
    if (field.isStatic) continue;
    const pair = accessorNames(field);
    if (pair.getter === name && arity === 0 && wants(GETTER, GETTER_FAMILY, field) && !field.name.startsWith("$")) return { kind: "accessor", type: field.type, file: type.file };
    if (pair.setter === name && arity === 1 && !field.isFinal && !isValue && wants(SETTER, SETTER_FAMILY, field)) return { kind: "mutator" };
  }
  return undefined;
}

/**
 * The fields the builder of a class sets; none when the class carries no plain `@Builder` or `@SuperBuilder`, declares
 * what the builder would, or (for `@SuperBuilder`) has a superclass of the project without `@SuperBuilder`, whose fields
 * the builder would also set, or one outside the project, whose builder members are unknown.
 */
function builderFields(type: TypeDecl, project: JavaProject): Field[] | undefined {
  const own = lombokAnnotations(type.node, type, project);
  if (own === undefined || own.some((use) => use.fqn === BUILDER) === own.some((use) => use.fqn === SUPER_BUILDER)) return undefined;
  const marker = own.some((use) => use.fqn === SUPER_BUILDER) ? SUPER_BUILDER : BUILDER;
  const chain = marker === SUPER_BUILDER ? project.classChain(type) : [type];
  if (marker === SUPER_BUILDER && chain.at(-1)!.node.childForFieldName("superclass") !== null) return undefined;
  const fields: Field[] = [];
  for (const owner of chain) {
    const uses = lombokAnnotations(owner.node, owner, project);
    if (owner.node.type !== "class_declaration" || uses === undefined || !uses.some((use) => use.fqn === marker) || owner.members.has(`${owner.name}Builder`)) return undefined;
    const declared = fieldsOf(owner);
    const read = declared.map((field) => lombokAnnotations(field.annotations, owner, project));
    if (read.includes(undefined)) return undefined;
    declared.forEach((field, index) => {
      const defaulted = read[index]!.some((use) => use.fqn === BUILDER_DEFAULT);
      if (!field.isStatic && !(field.isFinal && field.hasInitializer && !defaulted)) fields.push(field);
    });
  }
  return fields;
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
 * The Lombok annotations of the vocabulary a declaration (or a list of its annotations) carries; none when one carries an
 * argument the vocabulary does not model or is a name-changing annotation, since the generated names or access are then
 * not those of the plain annotation. `@Getter` and `@Setter` may state an access level: a call that names the member is
 * accessible when the repository compiles, so only `AccessLevel.NONE` changes what is generated. Names are read from the
 * scope around the class, so a supertype outside the sources does not withhold an annotation's name (ADR-0064).
 */
function lombokAnnotations(declaration: Node | readonly Node[], type: TypeDecl, project: JavaProject): LombokUse[] | undefined {
  const nodes = Array.isArray(declaration) ? declaration : (declaration as Node).namedChildren.find((child) => child.type === "modifiers")?.namedChildren ?? [];
  const found: LombokUse[] = [];
  for (const annotation of nodes) {
    if (annotation.type !== "annotation" && annotation.type !== "marker_annotation") continue;
    const name = annotation.childForFieldName("name");
    const resolved = name === null ? undefined : resolve(name, type.file, project, type.outer, name, true);
    if (resolved === undefined || resolved.kind === "repository" || !("fqn" in resolved) || !resolved.fqn.startsWith(LOMBOK)) continue;
    if (UNMODELLED.has(resolved.fqn)) return undefined;
    if (resolved.fqn === BUILDER_DEFAULT) {
      found.push({ fqn: resolved.fqn, none: false });
      continue;
    }
    if (!ACCESSOR_TYPES.has(resolved.fqn) && resolved.fqn !== BUILDER && resolved.fqn !== SUPER_BUILDER) continue;
    const arguments_ = annotation.childForFieldName("arguments")?.namedChildren ?? [];
    if (arguments_.length === 0) found.push({ fqn: resolved.fqn, none: false });
    else {
      const level = resolved.fqn === GETTER || resolved.fqn === SETTER ? accessLevelOf(arguments_, type, project) : undefined;
      if (level === undefined) return undefined;
      found.push({ fqn: resolved.fqn, none: level === "NONE" });
    }
  }
  return found;
}

/** The access level an annotation's one argument names, as `AccessLevel.X` or `value = AccessLevel.X`; none for anything else. */
function accessLevelOf(argumentNodes: readonly Node[], type: TypeDecl, project: JavaProject): string | undefined {
  if (argumentNodes.length !== 1) return undefined;
  let argument: Node | null = argumentNodes[0]!;
  if (argument.type === "element_value_pair") argument = argument.childForFieldName("key")?.text === "value" ? argument.childForFieldName("value") : null;
  if (argument === null) return undefined;
  const resolved = resolve(argument, type.file, project, type.outer, argument, true);
  if (resolved === undefined || resolved.kind === "repository" || !("fqn" in resolved) || !resolved.fqn.startsWith(ACCESS_LEVEL)) return undefined;
  const level = resolved.fqn.slice(ACCESS_LEVEL.length);
  return ACCESS_LEVELS.has(level) ? level : undefined;
}
