import type { Node } from "web-tree-sitter";
import type { Evidence, UnknownReason } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { spanOf } from "./findings.ts";
import { externalNames, scopeOf, type JavaProject, type Scope, type TypeDecl } from "./java-symbols.ts";
import { memberNodes } from "./java-members.ts";
import { annotationUses, type AnnotationUse } from "./request-mapping.ts";

/** Where a serialized property's type is written. */
export interface TypeSite {
  node: Node;
  scope: Scope;
}

/** What `@JsonInclude` says about a property's null: `always` writes it, `non-null` drops it, `other` is a rule this reader does not model. */
export type Inclusion = "always" | "non-null" | "other";

export interface WireProperty {
  name: string;
  type: TypeSite;
  inclusion: Inclusion;
  /** Set when an annotation on the property changes its value in a way this reader does not model. */
  undecided?: Evidence;
}

export interface Undecided {
  reason: UnknownReason;
  evidence: Evidence;
}

export type Properties = { properties: readonly WireProperty[] } | { unknown: Undecided };

/** The Jackson annotations whose effect on the serialized shape this reader models or that do not touch it. */
const HANDLED = new Set(["JsonProperty", "JsonGetter", "JsonIgnore", "JsonInclude", "JsonPropertyOrder", "JsonAlias", "JsonSetter", "JsonCreator", "JsonPropertyDescription", "JsonClassDescription", "JsonDeserialize", "JsonPOJOBuilder", "JsonAnySetter", "JsonEnumDefaultValue", "JsonRootName"]);
/** The Jackson annotations that change what a property holds but not that it exists under its name. */
const VALUE_ONLY = new Set(["JsonFormat", "JsonSerialize", "JsonRawValue"]);
/** The rest of Jackson's annotations: they add, drop, rename or reshape properties, or choose the class by run-time data. */
const DISRUPTIVE = new Set([
  "JsonAnyGetter",
  "JsonAutoDetect",
  "JsonBackReference",
  "JsonManagedReference",
  "JsonFilter",
  "JsonIdentityInfo",
  "JsonIdentityReference",
  "JsonIgnoreProperties",
  "JsonIgnoreType",
  "JsonIncludeProperties",
  "JsonTypeId",
  "JsonTypeInfo",
  "JsonSubTypes",
  "JsonTypeName",
  "JsonTypeIdResolver",
  "JsonTypeResolver",
  "JsonUnwrapped",
  "JsonValue",
  "JsonView",
  "JsonAppend",
  "JsonNaming",
  "JsonValueInstantiator",
  "JacksonAnnotationsInside",
  "JsonMerge",
  "JsonKey",
]);
const JACKSON_PACKAGES = ["com.fasterxml.jackson.annotation.", "com.fasterxml.jackson.databind.annotation."];
const LOMBOK_PACKAGES = ["lombok.", "lombok.experimental."];
const LOMBOK_NAMES: ReadonlySet<string> = new Set(["Data", "Value", "Getter", "Accessors"]);
/** The supertypes a class may name without changing how Jackson writes it. */
const HARMLESS_SUPERTYPES: ReadonlySet<string> = new Set(["java.lang.Object", "java.io.Serializable", "java.lang.Cloneable", "java.lang.Comparable", "java.lang.Record", "java.lang.Enum"]);
const ACCESS_LEVELS: ReadonlySet<string> = new Set(["WRITE_ONLY", "READ_ONLY", "READ_WRITE", "AUTO"]);

interface Notes {
  jackson: ReadonlyMap<string, AnnotationUse>;
  lombok: ReadonlyMap<string, AnnotationUse>;
  /** The first annotation that changes the shape beyond a property's value. */
  disruptive: AnnotationUse | undefined;
  valueOnly: AnnotationUse | undefined;
}

interface Accessor {
  implicit: string;
  role: "getter" | "component" | "field" | "setter";
  visible: boolean;
  type: Node | null;
  scope: Scope;
  notes: Notes;
  node: Node;
}

class UndecidedRead extends Error {
  constructor(readonly reason: UnknownReason, readonly evidence: Evidence) {
    super(reason);
  }
}

function undecided(reason: UnknownReason, scope: Scope, node: Node): never {
  throw new UndecidedRead(reason, spanOf(scope.file.path, node));
}

function nameIn(use: AnnotationUse, project: JavaProject, packages: readonly string[], known: (name: string) => boolean): string | undefined {
  if (project.lookupType(use.name, use.scope) !== undefined) return undefined;
  for (const candidate of externalNames(use.name, use.scope.file, false)) {
    for (const prefix of packages) {
      const name = candidate.slice(prefix.length);
      if (candidate.startsWith(prefix) && !name.includes(".") && known(name)) return name;
    }
  }
  return undefined;
}

/** A project annotation that carries Jackson's annotations on its own declaration stands for them. */
function composedByJackson(use: AnnotationUse, project: JavaProject): boolean {
  const declared = project.lookupType(use.name, use.scope);
  if (typeof declared !== "object" || declared.kind !== "annotation") return false;
  return annotationUses(declared.node, scopeOf(declared)).some((meta) => nameIn(meta, project, JACKSON_PACKAGES, (name) => HANDLED.has(name) || VALUE_ONLY.has(name) || DISRUPTIVE.has(name)) !== undefined);
}

function notesOf(declaration: Node, scope: Scope, project: JavaProject): Notes {
  const jackson = new Map<string, AnnotationUse>();
  const lombok = new Map<string, AnnotationUse>();
  let disruptive: AnnotationUse | undefined;
  let valueOnly: AnnotationUse | undefined;
  for (const use of annotationUses(declaration, scope)) {
    const name = nameIn(use, project, JACKSON_PACKAGES, (candidate) => HANDLED.has(candidate) || VALUE_ONLY.has(candidate) || DISRUPTIVE.has(candidate));
    if (name !== undefined) {
      jackson.set(name, use);
      if (DISRUPTIVE.has(name)) disruptive ??= use;
      if (VALUE_ONLY.has(name)) valueOnly ??= use;
      continue;
    }
    const lombokName = nameIn(use, project, LOMBOK_PACKAGES, (candidate) => LOMBOK_NAMES.has(candidate));
    if (lombokName !== undefined) lombok.set(lombokName, use);
    else if (composedByJackson(use, project)) disruptive ??= use;
  }
  return { jackson, lombok, disruptive, valueOnly };
}

function lastSegment(use: AnnotationUse | undefined, attribute: string): string | undefined {
  return use?.attributes.get(attribute)?.[0]?.node.text.split(".").pop();
}

function inclusionOf(use: AnnotationUse | undefined): Inclusion | "inherit" {
  if (use === undefined) return "inherit";
  if ([...use.attributes.keys()].some((key) => key !== "value")) return "other";
  const value = lastSegment(use, "value");
  if (value === undefined || value === "ALWAYS") return "always";
  if (value === "NON_NULL") return "non-null";
  return value === "USE_DEFAULTS" ? "inherit" : "other";
}

function modifiersOf(declaration: Node): string[] {
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  return modifiers === undefined ? [] : modifiers.children.filter((child) => !child.isNamed).map((child) => child.text);
}

/** Jackson's default property name for an accessor suffix: the leading upper-case run is lowered (`URL` is `url`, `FooBar` is `fooBar`). */
function mangle(suffix: string): string {
  let end = 0;
  while (end < suffix.length && isUpperCase(suffix[end])) end++;
  return suffix.slice(0, end).toLowerCase() + suffix.slice(end);
}

function isUpperCase(character: string | undefined): boolean {
  return character !== undefined && character !== character.toLowerCase();
}

function capitalized(name: string): string {
  return name.slice(0, 1).toUpperCase() + name.slice(1);
}

function isBooleanType(type: Node | null): boolean {
  return type?.text === "boolean" || type?.text === "Boolean";
}

function getterName(method: string, returns: Node | null): string | undefined {
  if (method === "getClass") return undefined;
  if (method.startsWith("get") && method.length > 3) return mangle(method.slice(3));
  return method.startsWith("is") && method.length > 2 && isBooleanType(returns) ? mangle(method.slice(2)) : undefined;
}

function isIgnored(accessor: Accessor): boolean {
  const ignore = accessor.notes.jackson.get("JsonIgnore");
  return ignore !== undefined && lastSegment(ignore, "value") !== "false";
}

function isExplicit(accessor: Accessor): boolean {
  return accessor.notes.jackson.has("JsonProperty") || accessor.notes.jackson.has("JsonGetter");
}

function lombokGetterIsPublic(use: AnnotationUse | undefined): boolean {
  const level = lastSegment(use, "value");
  return level === undefined || level === "PUBLIC";
}

function accessorsOf(type: TypeDecl, project: JavaProject): Accessor[] {
  const scope = scopeOf(type);
  const classNotes = notesOf(type.node, scope, project);
  const accessors: Accessor[] = [];
  const accessorsAnnotation = classNotes.lombok.get("Accessors");
  if (accessorsAnnotation !== undefined) undecided("no-extractor", scope, accessorsAnnotation.node);
  const generatesAll = classNotes.lombok.has("Data") || classNotes.lombok.has("Value");
  const classGetter = classNotes.lombok.get("Getter");
  for (const member of memberNodes(type)) {
    if (member.type === "field_declaration") {
      const modifiers = modifiersOf(member);
      if (modifiers.includes("static")) continue;
      const notes = notesOf(member, scope, project);
      if (notes.lombok.has("Accessors")) undecided("no-extractor", scope, member);
      const typeNode = member.childForFieldName("type");
      const fieldGetter = notes.lombok.get("Getter");
      const generates = fieldGetter !== undefined ? lombokGetterIsPublic(fieldGetter) : generatesAll || (classGetter !== undefined && lombokGetterIsPublic(classGetter));
      for (const declarator of member.childrenForFieldName("declarator")) {
        const name = declarator.childForFieldName("name")?.text;
        if (name === undefined) continue;
        accessors.push({ implicit: name, role: "field", visible: modifiers.includes("public") && !modifiers.includes("transient"), type: typeNode, scope, notes, node: member });
        if (generates && !name.startsWith("$")) {
          const prefixed = typeNode?.text === "boolean" && name.startsWith("is") && isUpperCase(name[2]);
          accessors.push({ implicit: mangle(prefixed ? name.slice(2) : capitalized(name)), role: "getter", visible: true, type: typeNode, scope, notes, node: member });
        }
      }
    }
  }
  for (const method of type.methods) {
    const modifiers = method.modifiers;
    if (modifiers.includes("static")) continue;
    const parameters = method.node.childForFieldName("parameters")?.namedChildren ?? [];
    const returns = method.node.childForFieldName("type");
    const notes = notesOf(method.node, scope, project);
    if (parameters.length === 0 && returns !== null && returns.type !== "void_type") {
      const implicit = getterName(method.name, returns) ?? (isExplicit({ notes } as Accessor) ? method.name : undefined);
      if (implicit !== undefined) accessors.push({ implicit, role: "getter", visible: modifiers.includes("public"), type: returns, scope, notes, node: method.node });
    } else if (parameters.length === 1 && method.name.startsWith("set") && method.name.length > 3) {
      accessors.push({ implicit: mangle(method.name.slice(3)), role: "setter", visible: modifiers.includes("public"), type: null, scope, notes, node: method.node });
    }
  }
  const components = type.node.childForFieldName("parameters");
  for (const component of type.node.type === "record_declaration" ? (components?.namedChildren ?? []) : []) {
    const name = component.childForFieldName("name")?.text;
    if (name !== undefined) accessors.push({ implicit: name, role: "component", visible: true, type: component.childForFieldName("type"), scope, notes: notesOf(component, scope, project), node: component });
  }
  return accessors;
}

const ROLE_ORDER = { getter: 0, component: 1, field: 2, setter: 3 } as const;

function directSupertypes(type: TypeDecl): Node[] {
  const clause = type.kind === "interface" ? type.node.namedChildren.find((child) => child.type === "extends_interfaces") : type.node.childForFieldName("interfaces");
  const listed = clause?.namedChildren.find((child) => child.type === "type_list")?.namedChildren ?? [];
  const superclass = type.node.childForFieldName("superclass")?.namedChildren[0];
  return [...(superclass === undefined ? [] : [superclass]), ...listed];
}

/** Reads the hierarchy of a type once: a supertype the sources do not state, or one the platform writes its own way, leaves the properties undecided. */
function checkHierarchy(type: TypeDecl, project: JavaProject): readonly TypeDecl[] {
  const { types } = project.hierarchy(type);
  for (const member of types) {
    for (const node of directSupertypes(member)) {
      const name = (node.type === "generic_type" ? node.namedChildren[0] : node)?.text.replace(/\s+/g, "") ?? "";
      const found = project.lookupType(name, scopeOf(member));
      if (typeof found === "object") continue;
      const candidates = externalNames(name, member.file, true);
      if (found === undefined && candidates.some((candidate) => HARMLESS_SUPERTYPES.has(candidate))) continue;
      undecided(found === "ambiguous" || !candidates.every(project.isPlatformName) ? "unresolved" : "no-extractor", scopeOf(member), node);
    }
  }
  return types;
}

function classInclusion(hierarchy: readonly TypeDecl[], project: JavaProject): Inclusion {
  for (const member of hierarchy) {
    const found = inclusionOf(notesOf(member.node, scopeOf(member), project).jackson.get("JsonInclude"));
    if (found !== "inherit") return found;
  }
  return "always";
}

function explicitNames(group: readonly Accessor[], project: JavaProject): string[] {
  const names = new Set<string>();
  for (const accessor of group) {
    for (const key of ["JsonProperty", "JsonGetter", "JsonSetter"]) {
      const use = accessor.notes.jackson.get(key);
      const expression = use?.attributes.get("value")?.[0];
      if (use === undefined || expression === undefined) continue;
      const value = project.evaluate(expression);
      if ("gap" in value) undecided("unresolved", accessor.scope, expression.node);
      if (value.value !== "") names.add(value.value);
    }
  }
  return [...names];
}

function isWriteOnly(group: readonly Accessor[]): boolean {
  return group.some((accessor) => {
    const use = accessor.notes.jackson.get("JsonProperty");
    const access = lastSegment(use, "access");
    if (access !== undefined && !ACCESS_LEVELS.has(access) && use !== undefined) undecided("unresolved", accessor.scope, use.node);
    return access === "WRITE_ONLY";
  });
}

/**
 * The properties Jackson's default configuration writes for a class: the accessors it detects (public getters and fields,
 * record components, the getters Lombok generates) merged by implicit name, renamed by `@JsonProperty` and `@JsonGetter`,
 * dropped by `@JsonIgnore` and write-only access. Undecided where an annotation or a supertype changes the shape in a way
 * this reader does not model.
 */
export function serializedProperties(type: TypeDecl, project: JavaProject): Properties {
  try {
    const hierarchy = checkHierarchy(type, project);
    for (const member of hierarchy) {
      const disruptive = notesOf(member.node, scopeOf(member), project);
      const use = disruptive.disruptive ?? disruptive.valueOnly;
      if (use !== undefined) undecided("no-extractor", scopeOf(member), use.node);
    }
    const inherited = classInclusion(hierarchy, project);
    const groups = new Map<string, Accessor[]>();
    for (const member of project.classChain(type)) {
      for (const accessor of accessorsOf(member, project)) groups.set(accessor.implicit, [...(groups.get(accessor.implicit) ?? []), accessor]);
    }
    const candidates: WireProperty[] = [];
    for (const [implicit, group] of groups) {
      const property = propertyOf(implicit, group, inherited, project);
      if (property !== undefined) candidates.push(property);
    }
    candidates.sort((a, b) => compareText(a.name, b.name));
    return { properties: mergedByName(candidates, type) };
  } catch (error) {
    if (error instanceof UndecidedRead) return { unknown: { reason: error.reason, evidence: error.evidence } };
    throw error;
  }
}

/** Two implicit names renamed to one wire name are one property to Jackson; they must agree on what they write. */
function mergedByName(candidates: readonly WireProperty[], type: TypeDecl): WireProperty[] {
  const merged: WireProperty[] = [];
  for (const property of candidates) {
    const previous = merged.at(-1);
    if (previous?.name !== property.name) {
      merged.push(property);
      continue;
    }
    if (previous.type.node.text !== property.type.node.text || previous.inclusion !== property.inclusion || property.undecided !== undefined) undecided("unresolved", scopeOf(type), property.type.node);
  }
  return merged;
}

function propertyOf(implicit: string, group: readonly Accessor[], inherited: Inclusion, project: JavaProject): WireProperty | undefined {
  const ignored = group.some(isIgnored);
  const explicit = group.filter((accessor) => !isIgnored(accessor) && isExplicit(accessor));
  const [kept] = explicit;
  if (ignored && kept !== undefined) undecided("unresolved", kept.scope, kept.node);
  if (ignored || isWriteOnly(group)) return undefined;
  const written = group.filter((accessor) => accessor.role !== "setter" && (accessor.visible || isExplicit(accessor))).toSorted((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const source = written.find((accessor) => accessor.type !== null);
  if (source === undefined || source.type === null) return undefined;
  const names = explicitNames(group, project);
  if (names.length > 1) undecided("unresolved", source.scope, source.type);
  const own = group.map((accessor) => inclusionOf(accessor.notes.jackson.get("JsonInclude"))).find((found) => found !== "inherit");
  const valueOnly = group.map((accessor) => accessor.notes.valueOnly).find((use) => use !== undefined);
  const disruptive = group.map((accessor) => accessor.notes.disruptive).find((use) => use !== undefined);
  if (disruptive !== undefined) undecided("no-extractor", source.scope, disruptive.node);
  return {
    name: names[0] ?? implicit,
    type: { node: source.type, scope: source.scope },
    inclusion: own ?? inherited,
    ...(valueOnly === undefined ? {} : { undecided: spanOf(source.scope.file.path, valueOnly.node) }),
  };
}

/** The wire names of an enumeration's constants; undecided where Jackson's annotations choose another value. */
export function enumerationNames(type: TypeDecl, project: JavaProject): { names: readonly string[] } | { unknown: Undecided } {
  try {
    const scope = scopeOf(type);
    for (const member of checkHierarchy(type, project)) {
      const notes = notesOf(member.node, scopeOf(member), project);
      const use = notes.disruptive ?? notes.valueOnly;
      if (use !== undefined) undecided("no-extractor", scopeOf(member), use.node);
    }
    const names: string[] = [];
    for (const member of memberNodes(type)) {
      const notes = notesOf(member, scope, project);
      if (notes.disruptive !== undefined) undecided("no-extractor", scope, notes.disruptive.node);
      if (member.type !== "enum_constant") continue;
      const constant = member.childForFieldName("name")?.text;
      if (constant === undefined) continue;
      const expression = notes.jackson.get("JsonProperty")?.attributes.get("value")?.[0];
      const evaluated = expression === undefined ? undefined : project.evaluate(expression);
      if (evaluated !== undefined && "gap" in evaluated) undecided("unresolved", scope, expression!.node);
      names.push(evaluated === undefined || evaluated.value === "" ? constant : evaluated.value);
    }
    return { names: names.toSorted(compareText) };
  } catch (error) {
    if (error instanceof UndecidedRead) return { unknown: { reason: error.reason, evidence: error.evidence } };
    throw error;
  }
}
