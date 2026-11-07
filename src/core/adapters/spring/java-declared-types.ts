import type { Node } from "web-tree-sitter";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DeclaredType, ImportOrigins } from "../../ports/import-origins.port.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { enclosingType, typeVariableAround } from "./java-root-bindings.ts";
import { createJavaProject, describeFile, qualifiedTypeName, type JavaFile, type JavaProject } from "./java-symbols.ts";

const UNKNOWN: DeclaredType = { kind: "unknown" };
const TYPE_DECLARATIONS: ReadonlySet<string> = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"]);
/** Values whose class is one no declaration names: an implementation of an interface the sources do not state. */
const FUNCTION_VALUES: ReadonlySet<string> = new Set(["lambda_expression", "method_reference"]);
const QUALIFIED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
/** A package starts lowercase, so a qualified name whose first segment does is one. */
const PACKAGE_SEGMENT = /^[a-z]/;
/** The supertypes every repository class, enum and record has without writing them (JLS 8.1.4, 8.9, 8.10). */
const IMPLICIT_SUPERTYPES: readonly string[] = ["java.lang.Object", "java.lang.Enum", "java.lang.Comparable", "java.io.Serializable", "java.lang.constant.Constable", "java.lang.Record"];

/** Where a type name written in a Java source leads: a type of the repository, a platform type by its qualified name, or nothing proven. */
type Resolved = { kind: "repository" } | { kind: "platform"; fqn: string } | undefined;

/**
 * `ImportOrigins.declaredTypes` for Java sources: a platform type (`JavaProject.isPlatformName`) the annotation names
 * through the project's one resolver, by its package and its name below it. Unknown when the name binds a repository type,
 * a type variable or a type no import names (generated code or a dependency outside the platform packages), when the
 * strict reading leaves it unsettled, or when the repository may run its own code behind any platform type: a supertype
 * outside the repository (whose own supertypes the sources do not state), an anonymous class, a lambda or a method
 * reference (whose interface they do not state), an aspect, or a Java source that does not parse (ADR-0029 decision 9).
 */
export function createJavaDeclaredTypes(parser: () => Promise<JavaParser>, sources: readonly SourceFile[]): ImportOrigins["declaredTypes"] {
  const java = sources.filter(({ path }) => isJavaSource(path));
  return async (sites, signal) => {
    const results: DeclaredType[] = sites.map(() => UNKNOWN);
    if (!sites.some(({ file }) => isJavaSource(file))) return results;
    const read = await parser();
    const trees: JavaSyntaxTree[] = [];
    try {
      const files = new Map<string, JavaFile>();
      let parsedAll = true;
      for (const source of java) {
        const parsed = read.parse(source.content);
        if (!parsed.ok) {
          parsedAll = false;
          continue;
        }
        trees.push(parsed.value);
        files.set(source.path, describeFile(source.path, parsed.value.root));
      }
      const project = createJavaProject([...files.values()]);
      if (!parsedAll || project.unreadable.length > 0) return results;
      const subtyped = subtypedTypes([...files.values()], project);
      if (subtyped === undefined) return results;
      for (const [index, site] of sites.entries()) {
        if (signal?.aborted) break;
        const file = files.get(site.file);
        const name = file === undefined ? undefined : annotationAt(file.root, site.line, site.column, site.spelled);
        const resolved = name === undefined ? undefined : resolve(name, file!, project, enclosingType(name, file!, project), name);
        if (resolved?.kind === "platform" && !subtyped.has(resolved.fqn)) results[index] = packageType(resolved.fqn);
      }
      return results;
    } finally {
      for (const tree of trees) tree.dispose();
    }
  };
}

/**
 * The platform types a repository type is declared below, implicit ones included; `undefined` when some declaration may
 * make a value of any platform type run repository code.
 */
function subtypedTypes(files: readonly JavaFile[], project: JavaProject): ReadonlySet<string> | undefined {
  for (const file of files) {
    const pending: Node[] = [file.root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (FUNCTION_VALUES.has(node.type) || isAspect(node)) return undefined;
      const scope = TYPE_DECLARATIONS.has(node.type) || isAnonymous(node) ? enclosingType(node.parent ?? node, file, project) : undefined;
      for (const supertype of supertypesOf(node)) if (resolve(supertype, file, project, scope, supertype)?.kind !== "repository") return undefined;
      for (const child of node.namedChildren) if (child !== null) pending.push(child);
    }
  }
  return new Set(IMPLICIT_SUPERTYPES);
}

/** The supertypes a declaration writes: a class's superclass and interfaces, an interface's, and an anonymous class's type. */
function supertypesOf(node: Node): Node[] {
  if (isAnonymous(node)) return [node.childForFieldName("type")!];
  if (!TYPE_DECLARATIONS.has(node.type)) return [];
  const superclass = node.childForFieldName("superclass")?.namedChildren[0];
  const clause = node.childForFieldName("interfaces") ?? node.namedChildren.find((child) => child?.type === "extends_interfaces");
  const listed = clause?.namedChildren.find((child) => child?.type === "type_list")?.namedChildren ?? [];
  return [...(superclass === null || superclass === undefined ? [] : [superclass]), ...listed.filter((type): type is Node => type !== null)];
}

function isAnonymous(node: Node): boolean {
  return node.type === "object_creation_expression" && node.namedChildren.some((child) => child?.type === "class_body");
}

function isAspect(node: Node): boolean {
  return (node.type === "marker_annotation" || node.type === "annotation") && node.childForFieldName("name")?.text.split(".").at(-1) === "Aspect";
}

/** The whole type name an annotation's first name `spelled` begins at the 1-based place. */
function annotationAt(root: Node, line: number, column: number, spelled: string): Node | undefined {
  const leaf = root.descendantForPosition({ row: line - 1, column: column - 1 });
  if (leaf === null || leaf.type !== "type_identifier" || leaf.text !== spelled || leaf.startPosition.column !== column - 1) return undefined;
  let name: Node = leaf;
  while (name.parent?.type === "scoped_type_identifier" && name.parent.startIndex === name.startIndex) name = name.parent;
  return name;
}

/** Where a type name leads, read through the project's one resolver in its strict reading. */
function resolve(type: Node, file: JavaFile, project: JavaProject, scope: ReturnType<typeof enclosingType>, at: Node): Resolved {
  const name = (type.type === "generic_type" ? type.namedChildren[0] : type)?.text.replace(/\s+/g, "") ?? "";
  if (!QUALIFIED.test(name)) return undefined;
  const [head = "", ...rest] = name.split(".");
  const where = { file, type: scope };
  if (rest.length > 0 && PACKAGE_SEGMENT.test(head)) {
    const declared = project.lookupType(name, where);
    if (declared !== undefined) return declared === "ambiguous" ? undefined : { kind: "repository" };
    return project.isPlatformName(name) ? { kind: "platform", fqn: name } : undefined;
  }
  if (typeVariableAround(at)?.namedChildren[0]?.text === head) return undefined;
  const bound = project.bindName(head, { ...where, at }, "strict");
  if (bound === "ambiguous" || bound === "unsettled") return undefined;
  if (bound !== undefined) {
    if ("local" in bound) return rest.length === 0 ? { kind: "repository" } : undefined;
    return typeof project.lookupType(name, where) === "object" ? { kind: "repository" } : undefined;
  }
  const fqn = qualifiedTypeName(name, where, project);
  return fqn !== undefined && project.isPlatformName(fqn) ? { kind: "platform", fqn } : undefined;
}

/** A platform type by its package, the segments before the first one that starts uppercase, and its name below it. */
function packageType(fqn: string): DeclaredType {
  const segments = fqn.split(".");
  const first = segments.findIndex((segment) => !PACKAGE_SEGMENT.test(segment));
  return { kind: "package", module: segments.slice(0, first).join("."), name: segments.slice(first).join(".") };
}
