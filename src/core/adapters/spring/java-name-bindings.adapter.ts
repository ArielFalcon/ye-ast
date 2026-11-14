import type { Node } from "web-tree-sitter";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { LibraryReading } from "../../ports/library-signatures.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import { readsPastRoot, type RootOrigin } from "../../domain/impact/edge-policy.ts";
import type { ImportOrigins, ResolvedNameSite } from "../../ports/import-origins.port.ts";
import { createJavaRootBindings } from "./java-root-bindings.ts";
import { createJavaDeclaredTypes } from "./java-declared-types.ts";
import { createJavaDispatchTargets, createJavaOutsideSupertypes } from "./java-dispatch-targets.ts";
import { createJavaDeclaredSupertypes, createJavaImplementedDeclarations, createJavaImplicitChains, createJavaReceiverMethods, provesBinding } from "./java-receiver-methods.ts";
import { declaredVariablesOnce, declaresAnyVariable, type DeclaredVariables } from "../tree-sitter/java-declared-variables.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import { withJavaSources } from "./java-project.ts";
import { createJavaProject, isTypeDeclaration, platformTypeName, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import { isUncoveredJvmSource } from "../../domain/languages/path-class.ts";
import { projectBuildIn } from "./api-delegates.ts";

const PLAIN_CHAIN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
/** A package starts lowercase, so a qualified name whose first segment does is one. */
const PACKAGE_SEGMENT = /^[a-z]/;
/** The written qualifiers of a constructor reference that name a type. */
const REFERENCE_QUALIFIERS: readonly string[] = ["identifier", "type_identifier", "field_access", "scoped_identifier", "scoped_type_identifier"];

/**
 * What a site spells: its dotted name, whether it stands where a type does, and the node the name sits in. `runsType`: a
 * construction, written or as a constructor reference, which runs the constructor of the type its root names.
 */
interface Spelled {
  chain: string;
  typePosition: boolean;
  node: Node;
  runsType?: true;
}

/**
 * Where the names Java sources use are rooted, by Java's own scoping read from the sources (`java-symbols.ts`): the
 * types around the use and their member types, a single-type import, the file's package, its on-demand imports, and a
 * name qualified by a package. A construction or a constructor reference whose type no declaration of the repository binds
 * is also rooted at the platform type `java.lang` offers by its name (`platformTypeName`), where the strict binding proves
 * over every source (`provesBinding`), since a type of the file's package an unread source declares would shadow it. A use the
 * scoping does not settle from the snapshot alone (a member type a supertype outside the snapshot may declare, two
 * on-demand imports that may both offer the name, a variable that obscures a type, a class the reader does not place) is
 * `unknown`. Nothing comes from the graph.
 */
export function createJavaNameBindings(parser: () => Promise<JavaParser>, sources: readonly SourceFile[], paths: readonly string[] = sources.map(({ path }) => path), facts?: DerivedFacts, hold?: ParseHold, context: readonly SourceFile[] = [], libraries?: LibraryReading): ImportOrigins {
  const build = projectBuildIn(context);
  const unreadJvm = paths.some(isUncoveredJvmSource);
  return {
    origins: async (sites) => sites.map((site) => unresolved(site)),
    rootBindings: (sites, signal) => createJavaRootBindings(parser(), sources, build)(sites, signal),
    declaredTypes: createJavaDeclaredTypes(parser, sources, paths, build),
    dispatchTargets: createJavaDispatchTargets(parser, sources, paths, hold, build, libraries),
    receiverMethods: createJavaReceiverMethods(parser, sources, paths, facts, hold, build),
    implementedDeclarations: createJavaImplementedDeclarations(parser, sources, paths, hold, build),
    outsideSupertypes: createJavaOutsideSupertypes(parser, sources, paths, hold, build),
    implicitChains: createJavaImplicitChains(parser, sources, paths, hold, build),
    declaredSupertypes: createJavaDeclaredSupertypes(parser, sources, paths, hold, build),
    replacedRoots: async () => ({ paths: [], globalObjects: new Set(), packages: new Set() }),
    rootOrigins: async (sites, signal) => {
      const results: RootOrigin[] = sites.map((site) => unresolved(site));
      const asked = sites.map((site, index) => ({ site, index }));
      if (asked.length === 0 || signal?.aborted) return results;
      const java = await parser();
      return withJavaSources(java, (parse) => {
        const { files: parsed, unparsed } = parse(sources);
        const files = new Map(parsed.map((file) => [file.path, file]));
        const project = createJavaProject(parsed, build);
        const unreadable = new Set(project.unreadable);
        const variables = declaredVariablesOnce();
        let proven: boolean | undefined;
        const proves = (): boolean => (proven ??= provesBinding(parsed, project, unparsed, unreadJvm));
        for (const { site, index } of asked) {
          const file = files.get(site.file);
          if (file === undefined || unreadable.has(file)) continue;
          const root = rootOf(site, file, project, variables, proves);
          if (root !== undefined) results[index] = { status: "complete", value: root.origin, ...(root.bare ? { bare: true as const } : {}), ...(root.pastRoot ? { pastRoot: true as const } : {}), evidence: [{ path: site.file, line: site.line }] };
        }
        return results;
      });
    },
  };
}

function unresolved(site: { file: string; line: number }): Finding<ImportOrigin> {
  return { status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] };
}

/** Where a site's spelled chain is rooted; `pastRoot` counted from the root type, after its package (`readsPastRoot`). */
function rootOf(site: ResolvedNameSite, file: JavaFile, project: JavaProject, variables: (scope: Node) => DeclaredVariables, proves: () => boolean): { origin: ImportOrigin; bare: boolean; pastRoot: boolean } | undefined {
  const spelled = spelledAt(site, file.root);
  if (spelled === undefined) return undefined;
  const found = chainRootOf(spelled, file, project, variables, proves);
  if (found === undefined) return undefined;
  const segments = spelled.chain.split(".");
  const root = segments.findIndex((segment) => !PACKAGE_SEGMENT.test(segment));
  return { ...found, pastRoot: readsPastRoot(site.kind, segments.length - root) };
}

function chainRootOf(spelled: Spelled, file: JavaFile, project: JavaProject, variables: (scope: Node) => DeclaredVariables, proves: () => boolean): { origin: ImportOrigin; bare: boolean } | undefined {
  const enclosing = enclosingTypes(spelled.node, file, project);
  if (enclosing === undefined) return undefined;
  const segments = spelled.chain.split(".");
  const head = segments[0]!;
  const obscured = (scope: Node): boolean => declaresAnyVariable(variables(scope), head);
  if (!spelled.typePosition && (obscured(file.root) || enclosing.some((type) => project.hierarchy(type).types.some((member) => member.file !== file && obscured(member.node))))) return undefined;
  const bare = segments.length === 1;
  /** A qualified name whose first segment is lowercase names a package, unless a source declares a type of that name. */
  if (!bare && PACKAGE_SEGMENT.test(head) && project.lookupType(head, { file, type: enclosing[0] }) === undefined) return packageQualified(segments, spelled.typePosition, file, project);
  const scope = { file, type: enclosing[0], at: spelled.node };
  const bound = project.bindName(head, scope, "strict");
  if (typeof bound === "object") return "local" in bound ? undefined : { origin: declaredBy(bound), bare };
  if (bound !== undefined) return undefined;
  const imported = file.singleImports.get(head);
  const platform = imported !== undefined ? (project.isPlatformName(imported) ? imported : undefined) : spelled.runsType && proves() ? platformTypeName(head, scope, project) : undefined;
  return platform === undefined ? undefined : { origin: { kind: "external", module: packageOf(platform) }, bare };
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
  const spelled = site.kind === "calls" ? callAt(leaf, site.name) : site.kind === "instantiates" ? instantiationAt(leaf) : site.kind === "references" ? constructorReferenceAt(leaf) ?? typeAt(leaf) : typeAt(leaf);
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
  return name === null || name === undefined ? undefined : { chain: name.text, typePosition: true, node: creation, runsType: true };
}

/**
 * A constructor reference written at the leaf (`T::new`), by the type it constructs. A reference to a member (`T::m`,
 * `value::m`) is none: its root does not say whether the member is static, and an instance one may run an override.
 */
function constructorReferenceAt(leaf: Node): Spelled | undefined {
  for (let node: Node | null = leaf; node !== null && node.startIndex === leaf.startIndex; node = node.parent) {
    if (node.type !== "method_reference") continue;
    const qualifier = node.namedChildren[0];
    const type = qualifier?.type === "generic_type" ? qualifier.namedChildren[0] : qualifier;
    if (type === null || type === undefined || !REFERENCE_QUALIFIERS.includes(type.type) || !node.children.some((child) => child?.type === "new")) return undefined;
    return { chain: type.text, typePosition: true, node, runsType: true };
  }
  return undefined;
}

function typeAt(leaf: Node): Spelled | undefined {
  if (leaf.type !== "type_identifier") return undefined;
  let name: Node = leaf;
  while (name.parent?.type === "scoped_type_identifier" && name.parent.lastNamedChild?.id === name.id) name = name.parent;
  return { chain: name.text, typePosition: true, node: name };
}

/**
 * The declared types around a node, innermost first; `undefined` when a class around it is one the reader does not
 * place (declared inside a method), since its members are then not known. An anonymous class body is a scope the
 * resolver reads at the node's place.
 */
function enclosingTypes(node: Node, file: JavaFile, project: JavaProject): TypeDecl[] | undefined {
  const declared = project.types.filter((type) => type.file === file);
  const around: TypeDecl[] = [];
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (!isTypeDeclaration(parent)) continue;
    const type = declared.find((candidate) => candidate.node.id === parent.id);
    if (type === undefined) return undefined;
    around.push(type);
  }
  return around;
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
