import type { Node } from "web-tree-sitter";
import { isJavaSource } from "../../domain/languages/java.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { RootOrigin } from "../../domain/impact/edge-policy.ts";
import type { ImportOrigins, ResolvedNameSite } from "../../ports/import-origins.port.ts";
import { createJavaRootBindings } from "./java-root-bindings.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaProject, describeFile, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";

const TYPE_DECLARATIONS: ReadonlySet<string> = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
const VARIABLE_DECLARATIONS: ReadonlySet<string> = new Set(["variable_declarator", "formal_parameter", "spread_parameter", "catch_formal_parameter", "resource", "enhanced_for_statement"]);
/** Where a bare identifier declares a variable: a lambda parameter, or a pattern variable. */
const PATTERN_OR_LAMBDA: ReadonlySet<string> = new Set(["lambda_expression", "inferred_parameters", "instanceof_expression", "type_pattern", "record_pattern_component"]);
const PLAIN_CHAIN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
/** A package starts lowercase, so a qualified name whose first segment does is one. */
const PACKAGE_SEGMENT = /^[a-z]/;

/** What a site spells: its dotted name, whether it stands where a type does, and the node the name sits in. */
interface Spelled {
  chain: string;
  typePosition: boolean;
  node: Node;
}

/**
 * Where the names Java sources use are rooted, by Java's own scoping read from the sources (`java-symbols.ts`): the
 * types around the use and their member types, a single-type import, the file's package, its on-demand imports, and a
 * name qualified by a package. A use the scoping does not settle from the snapshot alone (a member type a supertype
 * outside the snapshot may declare, two on-demand imports that may both offer the name, a variable that obscures a
 * type, a class the reader does not place) is `unknown`. Nothing comes from the graph.
 */
export function createJavaNameBindings(parser: () => Promise<JavaParser>, sources: readonly SourceFile[]): ImportOrigins {
  const javaSources = sources.filter(({ path }) => isJavaSource(path));
  return {
    origins: async (sites) => sites.map((site) => unresolved(site)),
    rootBindings: (sites, signal) => createJavaRootBindings(parser(), sources)(sites, signal),
    declaredTypes: async (sites) => sites.map(() => ({ kind: "unknown" as const })),
    replacedRoots: async () => ({ paths: [], globalObjects: new Set(), packages: new Set() }),
    rootOrigins: async (sites, signal) => {
      const results: RootOrigin[] = sites.map((site) => unresolved(site));
      const asked = sites.flatMap((site, index) => (isJavaSource(site.file) ? [{ site, index }] : []));
      if (asked.length === 0 || signal?.aborted) return results;
      const java = await parser();
      const trees: JavaSyntaxTree[] = [];
      try {
        const files = new Map<string, JavaFile>();
        for (const source of javaSources) {
          const parsed = java.parse(source.content);
          if (!parsed.ok) continue;
          trees.push(parsed.value);
          files.set(source.path, describeFile(source.path, parsed.value.root));
        }
        const project = createJavaProject([...files.values()]);
        const unreadable = new Set(project.unreadable);
        for (const { site, index } of asked) {
          const file = files.get(site.file);
          if (file === undefined || unreadable.has(file)) continue;
          const root = rootOf(site, file, project);
          if (root !== undefined) results[index] = { status: "complete", value: root.origin, ...(root.bare ? { bare: true as const } : {}), evidence: [{ path: site.file, line: site.line }] };
        }
      } finally {
        for (const tree of trees) tree.dispose();
      }
      return results;
    },
  };
}

function unresolved(site: { file: string; line: number }): Finding<ImportOrigin> {
  return { status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] };
}

function rootOf(site: ResolvedNameSite, file: JavaFile, project: JavaProject): { origin: ImportOrigin; bare: boolean } | undefined {
  const spelled = spelledAt(site, file.root);
  if (spelled === undefined) return undefined;
  const enclosing = enclosingTypes(spelled.node, file, project);
  if (enclosing === undefined) return undefined;
  const segments = spelled.chain.split(".");
  const head = segments[0]!;
  if (!spelled.typePosition && (declaresVariable(file.root, head) || enclosing.some((type) => project.hierarchy(type).types.some((member) => member.file !== file && declaresVariable(member.node, head))))) return undefined;
  const bare = segments.length === 1;
  /** A qualified name whose first segment is lowercase names a package, unless a source declares a type of that name. */
  if (!bare && PACKAGE_SEGMENT.test(head) && project.lookupType(head, { file, type: enclosing[0] }) === undefined) return packageQualified(segments, spelled.typePosition, file, project);
  const bound = project.bindName(head, { file, type: enclosing[0], at: spelled.node }, "strict");
  if (typeof bound === "object") return "local" in bound ? undefined : { origin: declaredBy(bound), bare };
  const imported = bound === undefined ? file.singleImports.get(head) : undefined;
  return imported !== undefined && project.isPlatformName(imported) ? { origin: { kind: "external", module: packageOf(imported) }, bare } : undefined;
}

/**
 * The dotted name the site spells, read where the graph writes the edge: a call at the start of its receiver, an
 * instantiation at `new`, a type at its last segment. Only a chain of plain names that ends in the site's name counts.
 */
function spelledAt(site: ResolvedNameSite, root: Node): Spelled | undefined {
  const { line, column } = site;
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return undefined;
  const point = { row: line - 1, column: column - 1 };
  const leaf = root.descendantForPosition(point);
  if (leaf === null || leaf.startPosition.row !== point.row || leaf.startPosition.column !== point.column) return undefined;
  const spelled = site.kind === "calls" ? callAt(leaf, site.name) : site.kind === "instantiates" ? instantiationAt(leaf) : typeAt(leaf);
  if (spelled === undefined || !PLAIN_CHAIN.test(spelled.chain) || spelled.chain.split(".").at(-1) !== site.name) return undefined;
  return spelled;
}

function callAt(leaf: Node, name: string): Spelled | undefined {
  for (let node: Node | null = leaf; node !== null && node.startIndex === leaf.startIndex; node = node.parent) {
    if (node.type !== "method_invocation" || node.childForFieldName("name")?.text !== name) continue;
    const object = node.childForFieldName("object");
    return object === null || !["identifier", "field_access", "scoped_identifier"].includes(object.type) ? undefined : { chain: `${object.text}.${name}`, typePosition: false, node };
  }
  return undefined;
}

function instantiationAt(leaf: Node): Spelled | undefined {
  const creation = leaf.type === "new" ? leaf.parent : undefined;
  if (creation?.type !== "object_creation_expression" || creation.namedChildren.some((child) => child?.type === "class_body")) return undefined;
  const type = creation.childForFieldName("type");
  const name = type?.type === "generic_type" ? type.namedChildren[0] : type;
  return name === null || name === undefined ? undefined : { chain: name.text, typePosition: true, node: creation };
}

function typeAt(leaf: Node): Spelled | undefined {
  if (leaf.type !== "type_identifier") return undefined;
  let name: Node = leaf;
  while (name.parent?.type === "scoped_type_identifier" && name.parent.lastNamedChild?.id === name.id) name = name.parent;
  return { chain: name.text, typePosition: true, node: name };
}

/**
 * The declared types around a node, innermost first; `undefined` when a class around it is one the reader does not
 * place (anonymous, or declared inside a method), since its members are then not known.
 */
function enclosingTypes(node: Node, file: JavaFile, project: JavaProject): TypeDecl[] | undefined {
  const declared = project.types.filter((type) => type.file === file);
  const around: TypeDecl[] = [];
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "class_body" && parent.parent?.type === "object_creation_expression") return undefined;
    if (!TYPE_DECLARATIONS.has(parent.type)) continue;
    const type = declared.find((candidate) => candidate.node.id === parent.id);
    if (type === undefined) return undefined;
    around.push(type);
  }
  return around;
}

/** Whether the file declares a variable of the name anywhere: a variable obscures a type of the same name. */
function declaresVariable(root: Node, name: string): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (VARIABLE_DECLARATIONS.has(node.type) && node.childForFieldName("name")?.text === name) return true;
    if (node.type === "identifier" && node.text === name && PATTERN_OR_LAMBDA.has(node.parent?.type ?? "")) return true;
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return false;
}

/** A name whose first segment is a package: rooted at the type of the repository its longest type prefix names, or outside. */
function packageQualified(segments: readonly string[], typePosition: boolean, file: JavaFile, project: JavaProject): { origin: ImportOrigin; bare: boolean } | undefined {
  const typeName = typePosition ? segments.join(".") : segments.slice(0, -1).join(".");
  for (let end = segments.length; end > 1; end--) {
    const declared = project.lookupType(segments.slice(0, end).join("."), { file, type: undefined });
    if (declared === "ambiguous") return undefined;
    if (declared !== undefined) return { origin: declaredBy(declared), bare: false };
  }
  return project.isPlatformName(typeName) ? { origin: { kind: "external", module: packageOf(typeName) }, bare: false } : undefined;
}

function declaredBy(type: TypeDecl): ImportOrigin {
  return { kind: "repository", file: type.file.path, declared: type.fqn };
}

/** The package of a qualified type name: the segments before the first one that starts uppercase. */
function packageOf(fqn: string): string {
  const segments = fqn.split(".");
  const first = segments.findIndex((segment) => !PACKAGE_SEGMENT.test(segment));
  return segments.slice(0, first < 0 ? -1 : first).join(".");
}
