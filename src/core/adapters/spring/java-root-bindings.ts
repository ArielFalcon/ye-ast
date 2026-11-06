import type { Node } from "web-tree-sitter";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, RootBinding, UseSite } from "../../ports/import-origins.port.ts";
import { enclosingBody, fieldsOf, localBinding } from "../tree-sitter/java-function-value-calls.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaProject, describeFile, qualifiedTypeName, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";

const UNKNOWN: RootBinding = { kind: "unknown" };
/** Links of a chain whose first name is the root: a member access, a call on a receiver, a qualified name. */
const CHAIN_LINKS: readonly string[] = ["field_access", "method_invocation", "scoped_identifier", "scoped_type_identifier"];

/**
 * `ImportOrigins.rootBindings` for Java sources, from the types the snapshot's Java sources declare (`java-symbols`): a
 * local or parameter is declared in the file, a field or a method of the enclosing types is a member of `this`, a type
 * the sources declare is located by its fully qualified name, and a type a single import or `java.lang` names under a
 * platform package is external. A name only a wildcard import could supply stays unknown: `java.lang` may supply it too. Every Java source is read when a site asks, and released after.
 */
export function createJavaRootBindings(parser: Promise<JavaParser>, sources: readonly SourceFile[]): ImportOrigins["rootBindings"] {
  const java = sources.filter(({ path }) => isJavaSource(path));
  return async (sites, signal) => {
    const results: RootBinding[] = sites.map(() => UNKNOWN);
    if (!sites.some(({ file }) => isJavaSource(file))) return results;
    const read = await parser;
    const trees: JavaSyntaxTree[] = [];
    try {
      const files = new Map<string, JavaFile>();
      for (const source of java) {
        const parsed = read.parse(source.content);
        if (!parsed.ok) continue;
        trees.push(parsed.value);
        files.set(source.path, describeFile(source.path, parsed.value.root));
      }
      const project = createJavaProject([...files.values()]);
      for (const [index, site] of sites.entries()) {
        if (signal?.aborted) break;
        const file = files.get(site.file);
        if (file !== undefined && !project.unreadable.includes(file)) results[index] = bindingAt(site, file, project);
      }
      return results;
    } finally {
      for (const tree of trees) tree.dispose();
    }
  };
}

function bindingAt(site: UseSite, file: JavaFile, project: JavaProject): RootBinding {
  const spelled = spelledAt(file.root, site);
  if (spelled === undefined) return UNKNOWN;
  const whole = chainFrom(spelled);
  const names = chainNames(whole);
  const head = headOf(whole);
  const member = names[1];
  if (head.type === "this") return { kind: "this", ...(member === undefined ? {} : { member }) };
  if (head.type === "super") {
    const base = enclosingType(head, file, project)?.node.childForFieldName("superclass")?.namedChildren[0];
    return base === undefined || base === null ? UNKNOWN : typeBinding(headOf(base), file, project, site.owner);
  }
  if (head.parent?.type === "method_invocation" && head.parent.childForFieldName("object") === null) return staticImport(head.text, file, project) ?? { kind: "this", member: head.text };
  if (head.type === "identifier" && /^[a-z_$]/.test(head.text)) {
    const local = localBinding(head);
    if (local !== undefined) return declaredBinding(head, local, site.owner);
    const field = fieldIn(head);
    return field ? { kind: "this", member: head.text } : UNKNOWN;
  }
  return typeBinding(head, file, project, site.owner);
}

/** `local` when the declaration lies inside the syntax of the declaration whose body writes the use, otherwise declared by the line its name is written on. */
function declaredBinding(root: Node, declaration: Node, owner: UseSite["owner"]): RootBinding {
  const around = ownerAround(root, owner);
  if (around !== undefined && declaration.id !== around.id && around.startIndex <= declaration.startIndex && declaration.endIndex <= around.endIndex) return { kind: "local", root: root.text };
  /** `localBinding` stops at the type body, so a local it finds outside the owner is never one a function around the owner captures. */
  return { kind: "declared", root: root.text, lines: [(nameOf(declaration) ?? declaration).startPosition.row + 1], captured: false };
}

/** The innermost declaration around `node` that is `owner`: its name is the owner's, written on a line the owner spans. */
function ownerAround(node: Node, owner: UseSite["owner"]): Node | undefined {
  for (let around = node.parent; around !== null; around = around.parent) {
    const name = nameOf(around);
    if (name !== undefined && name.text === owner.name && owner.line <= name.startPosition.row + 1 && name.startPosition.row + 1 <= owner.endLine) return around;
  }
  return undefined;
}

function nameOf(declaration: Node): Node | undefined {
  if (declaration.type === "type_parameter") return declaration.namedChildren[0] ?? undefined;
  return declaration.childForFieldName("name") ?? undefined;
}

/** A capitalised name: a type variable around it, a type the sources declare, or a platform type a single import or `java.lang` names. */
function typeBinding(name: Node, file: JavaFile, project: JavaProject, owner: UseSite["owner"]): RootBinding {
  const type = enclosingType(name, file, project);
  const variable = typeVariableAround(name);
  if (variable !== undefined) return declaredBinding(name, variable, owner);
  const declared = project.lookupType(name.text, { file, type });
  if (declared === "ambiguous") return { kind: "ambiguous", root: name.text };
  /** A type only a wildcard import supplies may also be one `java.lang` supplies, so the sources do not prove it. */
  if (declared !== undefined && project.lookupType(name.text, { file: { ...file, onDemandImports: [] }, type }) === undefined) return { kind: "ambiguous", root: name.text };
  if (declared !== undefined) return { kind: "located", root: name.text, file: declared.file.path, path: declared.fqn };
  const named = qualifiedTypeName(name.text, { file, type }, project);
  return named !== undefined && project.isPlatformName(named) ? { kind: "import", root: name.text, origin: { kind: "external", module: named.slice(0, named.lastIndexOf(".")) } } : UNKNOWN;
}

/** The identifier, type name, `this` or `super` the site spells, starting where the index places it; an instantiation stands for its class. */
function spelledAt(root: Node, site: UseSite): Node | undefined {
  const point = { row: site.line - 1, column: site.column - 1 };
  for (let node: Node | null = root.descendantForPosition(point); node !== null && node.startPosition.row === point.row && node.startPosition.column === point.column; node = node.parent) {
    if (node.type === "object_creation_expression") {
      const created = node.childForFieldName("type");
      return created === null ? undefined : headOf(created).text === site.spelled ? headOf(created) : undefined;
    }
    if (["identifier", "type_identifier", "this", "super"].includes(node.type) && (node.text === site.spelled || chainNames(chainFrom(node)).includes(site.spelled))) return node;
  }
  return undefined;
}

/** The chain of member accesses, calls and qualified names `node` begins, up to its whole. */
function chainFrom(node: Node): Node {
  let whole = node;
  while (whole.parent !== null && CHAIN_LINKS.includes(whole.parent.type) && whole.parent.childForFieldName("arguments")?.id !== whole.id) whole = whole.parent;
  return whole;
}

function headOf(node: Node): Node {
  let head = node;
  for (;;) {
    const next = head.type === "field_access" || head.type === "method_invocation" ? head.childForFieldName("object") ?? (head.type === "method_invocation" ? head.childForFieldName("name") : null)
      : head.type === "scoped_identifier" || head.type === "scoped_type_identifier" || head.type === "generic_type" ? head.namedChildren[0] ?? null
      : null;
    if (next === null) return head;
    head = next;
  }
}

function chainNames(node: Node): string[] {
  if (node.type === "field_access") return [...chainNames(node.childForFieldName("object")!), node.childForFieldName("field")?.text ?? ""];
  if (node.type === "method_invocation") {
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name")?.text ?? "";
    return object === null ? [name] : [...chainNames(object), name];
  }
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") return node.namedChildren.flatMap((child) => (child === null ? [] : chainNames(child)));
  return [node.text];
}

function fieldIn(name: Node): boolean {
  for (let body = enclosingBody(name); body !== undefined; body = enclosingBody(body)) if (fieldsOf(body).some((declarator) => declarator.childForFieldName("name")?.text === name.text)) return true;
  return false;
}

function typeVariableAround(name: Node): Node | undefined {
  for (let scope = name.parent; scope !== null; scope = scope.parent) {
    const parameters = scope.childForFieldName("type_parameters");
    const found = parameters?.namedChildren.find((parameter) => parameter?.namedChildren[0]?.text === name.text);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}

function enclosingType(node: Node, file: JavaFile, project: JavaProject): TypeDecl | undefined {
  return project.types.filter((type) => type.file === file && type.node.startIndex <= node.startIndex && node.endIndex <= type.node.endIndex).sort((a, b) => b.node.startIndex - a.node.startIndex)[0];
}

/** A method a static import names: of a type the sources declare, or of one under a platform package. */
function staticImport(name: string, file: JavaFile, project: JavaProject): RootBinding | undefined {
  const imported = file.staticImports.filter(({ member }) => member === name);
  if (imported.length !== 1) return undefined;
  const { className } = imported[0]!;
  const declared = project.lookupType(className, { file, type: undefined });
  if (declared !== undefined && declared !== "ambiguous") return { kind: "located", root: name, file: declared.file.path, path: `${declared.fqn}.${name}` };
  return project.isPlatformName(className) ? { kind: "import", root: name, origin: { kind: "external", module: className.slice(0, className.lastIndexOf(".")) } } : undefined;
}
