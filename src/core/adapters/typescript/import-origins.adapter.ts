import ts from "typescript";
import { matchesReferenceKind, syntaxName } from "./reference-occurrence.ts";
import { declarationCounts, declaredNames, scriptGlobalNames } from "./syntax-names.ts";
import { moduleStatement } from "./import-bindings.ts";
import { sourceTree } from "./source-tree.ts";
import { bindFile, type BoundFile, type LexicalBinding } from "./lexical-bindings.ts";
import { addWrittenRoots, GLOBAL_OBJECTS, type WrittenRoots } from "./written-roots.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import { readsPastRoot, type RootOrigin } from "../../domain/impact/edge-policy.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { DeclaredType, ImportOriginSite, ImportOrigins, ReplacedRoots, ResolvedNameSite, RootBinding, UseSite } from "../../ports/import-origins.port.ts";
import { moduleResolverOf, packageOf, rememberedModuleResolver } from "./module-resolver.ts";
import { TYPESCRIPT_LIB_GLOBALS } from "./typescript-lib-globals.ts";
import { moduleShape } from "./module-shape.ts";
import { hasModifier, isStatic, unwrapped } from "./syntax.ts";
import { createExportLookup, type ModuleShape } from "./declaration-lookup.ts";

/** The names the pinned `typescript` declares, held once for the process rather than rebuilt per query. */
const LIB_GLOBALS = new Set(TYPESCRIPT_LIB_GLOBALS);

/** What one file's imports bind, and the names the file declares for itself. */
interface FileShape {
  bindings: ReadonlyMap<string, string>;
  declared: ReadonlySet<string>;
}

/** One parsed file: its shape, and every node by the offset it starts at, so a site is found without walking the tree. */
interface FileIndex {
  source: ts.SourceFile;
  shape: FileShape;
  starting: ReadonlyMap<number, readonly ts.Node[]>;
}

export type ParseSource = (file: SourceFile) => ts.SourceFile;

const parseShared: ParseSource = (file) => sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);

/**
 * Reads, per file, the name each import binds to the specifier it came from, and resolves that specifier through the
 * snapshot's own module configuration (`module-resolver.ts`): a relative or aliased specifier names a file of the
 * repository, a package the manifest declares is outside it.
 *
 * Nothing is built and no dependency is opened: the import clause is syntax, and the resolver reads the configuration
 * files the snapshot already holds. A file that declares a name it also imports is `unknown` for that name, because the
 * declaration may shadow the import at the place the reference sits.
 */
export function createImportOrigins(sources: readonly SourceFile[], { parse = parseShared, facts }: { parse?: ParseSource; facts?: DerivedFacts } = {}): ImportOrigins {
  const texts = new Map(sources.map((file) => [file.path, file.content]));
  const files = new Map(sources.map((file) => [file.path, file]));
  const modules = facts === undefined ? moduleResolverOf(sources) : rememberedModuleResolver(sources, facts);
  /** What `derive` reads from one file alone, kept between readers when facts are given (ADR-0035). */
  const derivedOf = <T>(slot: string, path: string, derive: () => T): T => (facts === undefined ? derive() : facts.ofFile(slot, files.get(path)!, derive));
  const trees = new Map<string, ts.SourceFile>();
  /** Every syntax tree the reader reads, parsed once for its life through `parse`. */
  const treeOf = (path: string): ts.SourceFile => {
    let tree = trees.get(path);
    if (tree === undefined) {
      tree = parse(files.get(path)!);
      trees.set(path, tree);
    }
    return tree;
  };
  /** What each file exports, read once and only when a namespace member asks. */
  const moduleShapes = new Map<string, ModuleShape | undefined>();
  function moduleShapeOf(file: string): ModuleShape | undefined {
    if (!moduleShapes.has(file)) moduleShapes.set(file, texts.has(file) && isTypeScriptSource(file) ? moduleShape(treeOf(file)) : undefined);
    return moduleShapes.get(file);
  }
  const resolvedFile = async (from: string, specifier: string): Promise<string | undefined> => {
    const resolved = await modules.resolve(from, specifier);
    return "file" in resolved ? resolved.file : undefined;
  };
  const exportedDeclaration = createExportLookup(async (file) => moduleShapeOf(file), resolvedFile);
  /** What a file exports with its top-level types beside its values: what a heritage name may name. */
  const typeShapes = new Map<string, ModuleShape | undefined>();
  const exportedType = createExportLookup(async (file) => {
    if (!typeShapes.has(file)) typeShapes.set(file, withTypes(moduleShapeOf(file), indexOf(file)?.index.source));
    return typeShapes.get(file);
  }, resolvedFile);
  const shapes = new Map<string, FileShape>();
  const starts = new Map<string, ReadonlySet<number>>();
  /** The name starts one binding of a file proves, read once per file for the life of the reader (ADR-0029). */
  const startsOf = (slot: string, path: string, read: () => Iterable<number>): ReadonlySet<number> => {
    const key = `${slot}\u0000${path}`;
    let held = starts.get(key);
    if (held === undefined) {
      held = new Set(derivedOf(slot, path, () => [...read()]));
      starts.set(key, held);
    }
    return held;
  };
  const isParameterUse: ParameterUse = (source, text, identifier) => startsOf("ts-parameter-uses", source.fileName, () => parameterUses(source.fileName, text)).has(identifier.getStart(source));
  /** A name a `with` body or a direct `eval` may rebind proves no origin; only a file that has either is bound for it. */
  const isDynamicUse: ParameterUse = (source, text, identifier) => startsOf("ts-dynamic-uses", source.fileName, () => (DYNAMIC_SCOPE.test(text) ? dynamicUses(source.fileName, text) : [])).has(identifier.getStart(source));
  const bindsOncePerFile = (): ((path: string) => BoundFile) => {
    const bound = new Map<string, BoundFile>();
    return (path) => {
      if (!bound.has(path)) bound.set(path, bindFile(path, texts.get(path)!));
      return bound.get(path)!;
    };
  };
  const indexes = new Map<string, FileIndex | undefined>();
  /** A file is parsed once for the life of the reader; one that does not parse has no index. */
  const indexOf = (file: string): { index: FileIndex; text: string } | undefined => {
    const text = texts.get(file);
    if (text === undefined || !isTypeScriptSource(file)) return undefined;
    if (!indexes.has(file)) indexes.set(file, indexed(treeOf(file)));
    const index = indexes.get(file);
    return index === undefined ? undefined : { index, text };
  };

  /**
   * A file is read when a site asks about it; its imports and declarations are held as a shape.
   */
  const shapeOf = (file: string): FileShape => {
    let held = shapes.get(file);
    if (held === undefined) {
      const text = texts.get(file);
      held = text === undefined || !isTypeScriptSource(file) ? { bindings: new Map<string, string>(), declared: new Set<string>() } : (indexOf(file)?.index.shape ?? describeTree(treeOf(file)));
      shapes.set(file, held);
    }
    return held;
  };

  /**
   * The names the snapshot declares globally: a `.d.ts` anywhere, a file that augments the global scope, and the top
   * level of a script (a source with no import or export, whose declarations are global). A lib name among them is never
   * `ambient`.
   */
  let globals: ReadonlySet<string> | undefined;
  const repositoryGlobals = (): ReadonlySet<string> => {
    if (globals !== undefined) return globals;
    const names = new Set<string>();
    for (const [path, text] of texts) {
      const augments = path.endsWith(".d.ts") || text.includes("declare global");
      if (!augments && !isTypeScriptSource(path)) continue;
      const declared = derivedOf("ts-script-globals", path, () => {
        const tree = treeOf(path);
        return [...(augments ? declaredNames(tree) : ts.isExternalModule(tree) ? [] : scriptGlobalNames(tree))];
      });
      for (const name of declared) names.add(name);
    }
    globals = names;
    return names;
  };
  let replaced: ReplacedRoots | undefined;
  let subtyped: ReadonlySet<string> | typeof UNPROVEN | undefined;
  /** The globals the snapshot declares, the member paths it writes and the packages it writes through; read when first asked. */
  const replacedRoots = (): ReplacedRoots => {
    if (replaced !== undefined) return replaced;
    const written: WrittenRoots = { paths: new Map([...repositoryGlobals()].map((name) => [name, [name]])), packages: new Set() };
    for (const [path, text] of texts) {
      if (!isTypeScriptSource(path)) continue;
      const own = derivedOf("ts-written-roots", path, () => {
        const into: WrittenRoots = { paths: new Map(), packages: new Set() };
        addWrittenRoots(path, text, treeOf(path), into, (name) => LIB_GLOBALS.has(name));
        return { paths: [...into.paths], packages: [...into.packages] };
      });
      for (const [key, segments] of own.paths) written.paths.set(key, segments);
      for (const name of own.packages) written.packages.add(name);
    }
    const paths = [...written.paths].sort(([a], [b]) => compareText(a, b)).map(([, segments]) => segments);
    replaced = { paths, globalObjects: GLOBAL_OBJECTS, packages: written.packages };
    return replaced;
  };

  const originOf = async (site: ImportOriginSite, syntax: SiteSyntax | "unknown"): Promise<Finding<ImportOrigin>> => {
    const evidence: Evidence[] = [{ path: site.file, line: site.line }];
    if (syntax === "unknown") return { status: "unknown", reason: "unresolved", evidence };
    if (syntax === "local") return { status: "complete", value: { kind: "local-parameter", name: site.name }, evidence };
    if (syntax === "this-member") return { status: "complete", value: { kind: "this-member", name: site.name }, evidence };
    const { bindings, declared: names } = shapeOf(site.file);
    /** A declaration of the file may shadow an import or a global at the place the reference sits, so it wins. */
    if (names.has(site.name)) return { status: "unknown", reason: "unresolved", evidence };
    const specifier = bindings.get(site.name);
    if (specifier === undefined) {
      /** Nothing binds the name here: it is in scope only if the language's own libraries declare it. */
      if (LIB_GLOBALS.has(site.name) && !repositoryGlobals().has(site.name)) return { status: "complete", value: { kind: "ambient", name: site.name }, evidence };
      return { status: "unknown", reason: "unresolved", evidence };
    }
    const resolved = await modules.resolve(site.file, specifier);
    if ("file" in resolved) return { status: "complete", value: { kind: "repository", file: resolved.file }, evidence };
    const module = packageOf(specifier);
    if ("external" in resolved && module !== undefined) return { status: "complete", value: { kind: "external", module }, evidence };
    return { status: "unknown", reason: "unresolved", evidence };
  };

  return { replacedRoots: async () => replacedRoots(), origins: async (sites, signal) => {
    const results: (Finding<ImportOrigin> & { occurrence?: true })[] = sites.map((site) => ({ status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] }));
    const grouped = Map.groupBy(sites.map((site, index) => ({ site, index })), ({ site }) => site.file);
    for (const [file, group] of grouped) {
      if (signal?.aborted) break;
      const parsed = indexOf(file);
      const checked = parsed === undefined ? undefined : checkSites(parsed.index, parsed.text, group, isParameterUse, isDynamicUse);
      if (checked !== undefined) shapes.set(file, checked.shape);
      const checks = checked?.matches ?? new Map<number, SiteSyntax>();
      for (const { site, index } of group) {
        const syntax = checks.get(index) ?? "unknown";
        const finding = await originOf(site, syntax);
        results[index] = syntax === "unknown" ? finding : { ...finding, occurrence: true };
      }
    }
    return results;
  }, rootOrigins: async (sites, signal) => {
    const results: RootOrigin[] = sites.map((site) => ({ status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] }));
    for (const [file, group] of Map.groupBy(sites.map((site, index) => ({ site, index })), ({ site }) => site.file)) {
      if (signal?.aborted) break;
      const parsed = indexOf(file);
      const read = parsed === undefined ? undefined : rootsAt(parsed.index, parsed.text, group, isParameterUse, isDynamicUse);
      if (read === undefined) continue;
      shapes.set(file, read.shape);
      for (const [index, { root, bare, local, pastRoot }] of read.roots) {
        const origin = await originOf({ ...sites[index]!, name: root }, local ? "local" : "valid");
        results[index] = { ...origin, ...(bare ? { bare: true as const } : {}), ...(pastRoot ? { pastRoot: true as const } : {}) };
      }
    }
    return results;
  }, rootBindings: async (sites, signal) => {
    const results: RootBinding[] = sites.map(() => UNKNOWN_BINDING);
    for (const [file, group] of Map.groupBy(sites.map((site, index) => ({ site, index })), ({ site }) => site.file)) {
      if (signal?.aborted) break;
      const parsed = indexOf(file);
      if (parsed === undefined) continue;
      const { index: tree, text } = parsed;
      const chains = group.flatMap(({ site, index }) => {
        const chain = chainAt(tree, text, site);
        return chain === undefined ? [] : [{ chain, index, owner: site.owner }];
      });
      /** The file is bound only when a value name asks, and its program is dropped once they are answered (ADR-0029). */
      const bound = chains.some(({ chain }) => ts.isIdentifier(chain.root) && !isTypeName(chain.root)) ? bindFile(file, text) : undefined;
      for (const { chain, index, owner } of chains) results[index] = await bindingOf(file, tree, chain, bound, owner);
    }
    return results;
  },
  /** TypeScript types structurally: any object with the members of a type may stand where it is declared, so no hierarchy names every body a call runs. */
  dispatchTargets: async (sites) => sites.map(() => ({ kind: "unknown" })),
  /** For the same reason a declared type does not name the class whose method a call runs. */
  receiverMethods: async (sites) => sites.map(() => ({ kind: "unknown" })),
  declaredTypes: async (sites, signal) => {
    const results: DeclaredType[] = sites.map(() => UNKNOWN_TYPE);
    for (const [file, group] of Map.groupBy(sites.map((site, index) => ({ site, index })), ({ site }) => site.file)) {
      if (signal?.aborted) break;
      const parsed = indexOf(file);
      if (parsed === undefined) continue;
      for (const { site, index } of group) {
        const type = await annotatedTypeAt(file, parsed.index, parsed.text, site);
        const subtypes = await subtypedTypes();
        if (subtypes === undefined) continue;
        results[index] = type.kind === "unknown" ? await nominalAt(file, parsed.index, parsed.text, site) : subtypes.has(typeKey(type)) ? UNKNOWN_TYPE : type;
      }
    }
    return results;
  } };

  /**
   * The repository class an annotation names alone, when it is nominal: its one declaration itself declares a `private`,
   * `protected` or `#` instance member, so only an instance of it or of a subclass fits. An inherited one proves nothing:
   * every class below the one that declares it fits, siblings of the annotated class included.
   */
  async function nominalAt(file: string, tree: FileIndex, text: string, site: UseSite): Promise<DeclaredType> {
    const head = nodesAt(tree, text, site).find((node): node is ts.Identifier => ts.isIdentifier(node) && node.text === site.spelled && isTypeName(node));
    if (head === undefined || ts.isQualifiedName(head.parent)) return UNKNOWN_TYPE;
    const boundOf = bindsOncePerFile();
    const named = classOf(await heritageOf(file, head, boundOf, 0));
    if (named === undefined || !ts.isClassDeclaration(named.declaration) || named.declaration.name === undefined || !declaresRestricted(named.declaration)) return UNKNOWN_TYPE;
    return { kind: "nominal", file: named.file, name: named.declaration.name.text, line: lineOf(named.declaration.getSourceFile(), named.declaration.name) };
  }

  /** The library or package type an annotation's first name, keyword or array syntax names at the site. */
  async function annotatedTypeAt(file: string, tree: FileIndex, text: string, site: UseSite): Promise<ExternalType> {
    const nodes = nodesAt(tree, text, site);
    const keyword = nodes.find((node) => KEYWORD_TYPES.has(node.kind) && node.getText(tree.source) === site.spelled);
    if (keyword !== undefined) return { kind: "global", name: KEYWORD_TYPES.get(keyword.kind)! };
    if (site.spelled === "Array" && nodes.some(ts.isArrayTypeNode)) return { kind: "global", name: "Array" };
    const head = nodes.find((node): node is ts.Identifier => ts.isIdentifier(node) && node.text === site.spelled && isTypeName(node));
    if (head === undefined) return UNKNOWN_TYPE;
    const member = ts.isQualifiedName(head.parent) && head.parent.left === head ? head.parent.right.text : undefined;
    return typeOf(file, await bindingOf(file, tree, { root: head, ...(member === undefined ? {} : { member }) }, undefined, site.owner));
  }

  /** A root binding as a type from outside the repository: a library global named alone, or a package's export by its exported name. */
  function typeOf(file: string, binding: RootBinding): ExternalType {
    if (binding.kind === "ambient") return { kind: "global", name: binding.root };
    if (binding.kind !== "import" || binding.origin.kind !== "external") return UNKNOWN_TYPE;
    const imported = moduleShapeOf(file)?.imports.get(binding.root)?.imported;
    const name = imported === "*" ? binding.member : binding.member === undefined ? imported : undefined;
    return name === undefined ? UNKNOWN_TYPE : { kind: "package", module: binding.origin.module, name };
  }

  /**
   * The library and package types an in-scope repository class or interface extends or implements, read when first asked;
   * `undefined` when some heritage names neither a repository class or interface nor a library or package type, so a
   * value of any type may run repository code.
   */
  async function subtypedTypes(): Promise<ReadonlySet<string> | undefined> {
    if (subtyped !== undefined) return subtyped === UNPROVEN ? undefined : subtyped;
    const keys = new Set<string>();
    const boundOf = bindsOncePerFile();
    for (const [path, text] of texts) {
      if (!isTypeScriptSource(path) || !HERITAGE.test(text)) continue;
      const parsed = indexOf(path);
      if (parsed === undefined) {
        subtyped = UNPROVEN;
        return undefined;
      }
      const heritage: ts.ExpressionWithTypeArguments[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isHeritageClause(node)) heritage.push(...node.types);
        node.forEachChild(visit);
      };
      visit(parsed.index.source);
      for (const type of heritage) {
        const proven = await heritageOf(path, type.expression, boundOf, 0);
        if (proven === undefined) {
          subtyped = UNPROVEN;
          return undefined;
        }
        if (typeof proven === "string") keys.add(proven);
      }
    }
    subtyped = keys;
    return keys;
  }

  /**
   * What a heritage name stands for, following constants, type aliases and imports of the repository: the key of a library
   * or package type, a repository class or interface (whose own heritage is read where it is declared), or `undefined`
   * when nothing proves either.
   */
  async function heritageOf(file: string, node: ts.Node, boundOf: (path: string) => BoundFile, depth: number): Promise<Heritage | undefined> {
    const parsed = indexOf(file);
    const written = ts.isTypeReferenceNode(node) ? node.typeName : node;
    if (ts.isClassExpression(written)) return { file, declarations: [written] };
    const [root, member, ...rest] = chainNames(written);
    const head = headOf(written);
    if (parsed === undefined || depth >= ALIAS_DEPTH || root === undefined || rest.length > 0 || !ts.isIdentifier(head) || !isPlainChain(written)) return undefined;
    let declarations: readonly ts.Node[] | undefined;
    if (isTypeName(head)) declarations = typeScopeOf(head);
    else {
      const binding = boundOf(file).bindingOf(boundOf(file).identifierAt(head.getStart(), root)!);
      if (binding.kind === "dynamic") return undefined;
      if (binding.kind === "declared" && !binding.declarations.every(isImportDeclaration)) declarations = binding.declarations;
    }
    if (declarations !== undefined) return member === undefined ? declarationsOf(file, declarations, boundOf, depth) : undefined;
    const type = typeOf(file, await bindingOf(file, parsed.index, { root: head, ...(member === undefined ? {} : { member }) }, boundOf(file), NO_OWNER));
    if (type.kind !== "unknown") return type.kind === "global" && member !== undefined ? undefined : typeKey(type);
    const imported = moduleShapeOf(file)?.imports.get(root);
    const resolved = imported === undefined ? undefined : await modules.resolve(file, imported.module);
    if (imported === undefined || resolved === undefined || !("file" in resolved)) return undefined;
    const name = imported.imported === "*" ? member : member === undefined ? imported.imported : undefined;
    const declaration = name === undefined ? undefined : await exportedType(resolved.file, name);
    return declaration === undefined || declaration === "ambiguous" ? undefined : exportedOf(declaration.file, declaration.name, boundOf, depth);
  }

  /** What a top-level declaration of a repository file stands for as heritage. */
  function exportedOf(file: string, name: string, boundOf: (path: string) => BoundFile, depth: number): Promise<Heritage | undefined> | undefined {
    const parsed = indexOf(file);
    if (parsed === undefined) return undefined;
    const declarations = parsed.index.source.statements.flatMap((statement): ts.Node[] =>
      ts.isVariableStatement(statement) ? statement.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name) : declaredName(statement) === name ? [statement] : []);
    return declarationsOf(file, declarations, boundOf, depth);
  }

  /** Classes, interfaces and type literals are the repository's own; a constant or a type alias stands for the name it holds. */
  async function declarationsOf(file: string, declarations: readonly ts.Node[], boundOf: (path: string) => BoundFile, depth: number): Promise<Heritage | undefined> {
    if (declarations.length > 0 && declarations.every((declaration) => ts.isClassLike(declaration) || ts.isInterfaceDeclaration(declaration))) return { file, declarations };
    const [only, ...others] = declarations;
    if (only === undefined || others.length > 0) return undefined;
    if (ts.isVariableDeclaration(only) && only.initializer !== undefined && (ts.getCombinedNodeFlags(only) & ts.NodeFlags.Const) !== 0) return heritageOf(file, unwrapped(only.initializer), boundOf, depth + 1);
    if (ts.isTypeAliasDeclaration(only) && ts.isTypeLiteralNode(only.type)) return { file, declarations };
    if (ts.isTypeAliasDeclaration(only) && ts.isTypeReferenceNode(only.type)) return heritageOf(file, only.type, boundOf, depth + 1);
    return undefined;
  }

  async function importBinding(file: string, specifier: string, root: string, member: string | undefined): Promise<RootBinding> {
    const resolved = await modules.resolve(file, specifier);
    /** A member of a namespace import is the declaration the module exports under its name, followed through re-exports. */
    if ("file" in resolved && moduleShapeOf(file)?.imports.get(root)?.imported === "*") {
      const declaration = member === undefined ? undefined : await exportedDeclaration(resolved.file, member);
      if (declaration === "ambiguous") return { kind: "ambiguous", root };
      return declaration === undefined ? UNKNOWN_BINDING : { kind: "located", root, file: declaration.file, path: declaration.name };
    }
    const named = { root, ...(member === undefined ? {} : { member }) };
    if ("file" in resolved) return { kind: "import", ...named, origin: { kind: "repository", file: resolved.file } };
    const module = packageOf(specifier);
    return "external" in resolved && module !== undefined ? { kind: "import", ...named, origin: { kind: "external", module } } : UNKNOWN_BINDING;
  }

  /** Nothing in the file binds the name: the language's own libraries may, unless the snapshot declares it globally. */
  function unbound(name: string): RootBinding {
    return LIB_GLOBALS.has(name) && !repositoryGlobals().has(name) ? { kind: "ambient", root: name } : UNKNOWN_BINDING;
  }

  async function bindingOf(file: string, { source, shape }: FileIndex, { root, member }: Chain, bound: BoundFile | undefined, owner: UseSite["owner"]): Promise<RootBinding> {
    if (!ts.isIdentifier(root)) return { kind: "this", ...(member === undefined ? {} : { member }) };
    const name = root.text;
    const specifier = shape.bindings.get(name);
    if (isTypeName(root)) {
      const scope = typeScopeOf(root);
      if (scope !== undefined) return declaredBinding(source, root, scope, owner);
      return specifier === undefined ? unbound(name) : importBinding(file, specifier, name, member);
    }
    const binding = bound!.bindingOf(bound!.identifierAt(root.getStart(source), name)!);
    if (binding.kind === "dynamic") return UNKNOWN_BINDING;
    if (binding.kind === "none") return unbound(name);
    if (binding.declarations.every(isImportDeclaration)) return specifier === undefined ? UNKNOWN_BINDING : importBinding(file, specifier, name, member);
    if (binding.declarations.some(isImportDeclaration)) return UNKNOWN_BINDING;
    return declaredBinding(source, root, binding.declarations, owner);
  }
}

const UNKNOWN_BINDING: RootBinding = { kind: "unknown" };
const UNKNOWN_TYPE = { kind: "unknown" } as const;

/** A type from outside the repository, or none proven. */
type ExternalType = Extract<DeclaredType, { kind: "global" | "package" | "unknown" }>;

/** No declaration owns a heritage clause's name: it is bound at the file's level. */
const NO_OWNER: UseSite["owner"] = { name: "", line: 0, endLine: 0 };

const HERITAGE = /\b(extends|implements)\b/;

/**
 * What a heritage name stands for: the key of a library or package type, or the repository class, interface or type
 * literal declarations of one file it names.
 */
type Heritage = string | { file: string; declarations: readonly ts.Node[] };

/** Some heritage names nothing the sources prove. */
const UNPROVEN = Symbol("unproven");

/** How many constants and type aliases a heritage name is followed through. */
const ALIAS_DEPTH = 8;

/** A name or a chain of plain names: no call, element access or other expression. */
function isPlainChain(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return isPlainChain(node.expression);
  if (ts.isQualifiedName(node)) return isPlainChain(node.left);
  return false;
}

/** A module shape whose declarations and exports also hold the file's top-level interfaces, type aliases and enums. */
function withTypes(shape: ModuleShape | undefined, source: ts.SourceFile | undefined): ModuleShape | undefined {
  if (shape === undefined || source === undefined) return undefined;
  const declared = new Map(shape.declared);
  const exports = new Map(shape.exports);
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEnumDeclaration(statement)) continue;
    declared.set(statement.name.text, NO_SPAN);
    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) exports.set(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : statement.name.text, { local: statement.name.text });
  }
  return { ...shape, declared, exports };
}

const NO_SPAN = { line: 0, endLine: 0 };

/** The library type a primitive keyword annotation names. */
const KEYWORD_TYPES: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.StringKeyword, "String"],
  [ts.SyntaxKind.NumberKeyword, "Number"],
  [ts.SyntaxKind.BooleanKeyword, "Boolean"],
  [ts.SyntaxKind.BigIntKeyword, "BigInt"],
  [ts.SyntaxKind.SymbolKeyword, "Symbol"],
]);

function typeKey(type: Exclude<ExternalType, { kind: "unknown" }>): string {
  return type.kind === "global" ? type.name : `${type.module}#${type.name}`;
}

/** The nodes that start at a site's 1-based place; none when the place lies outside its line. */
function nodesAt({ source, starting }: FileIndex, text: string, site: UseSite): readonly ts.Node[] {
  const starts = source.getLineStarts();
  if (!Number.isInteger(site.line) || !Number.isInteger(site.column) || site.line < 1 || site.column < 1 || site.line > starts.length) return [];
  const point = starts[site.line - 1]! + site.column - 1;
  return point >= (site.line < starts.length ? starts[site.line]! : text.length) ? [] : (starting.get(point) ?? []);
}

/** The first name of a chain written at a site (`this` stands for itself), and the name after it when the chain has one. */
interface Chain {
  root: ts.Node;
  member?: string;
}

/**
 * The chain of calls, member accesses and qualified names written around the name, `this` or `super` the site spells,
 * up to its whole, or around an instantiation placed at its `new` keyword when the chain names the site's spelling.
 * `super` stands for the head of its class's `extends` expression.
 */
function chainAt(index: FileIndex, text: string, site: UseSite): Chain | undefined {
  const { source } = index;
  for (const node of nodesAt(index, text, site)) {
    const spelled = ts.isIdentifier(node) ? node.text : node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword ? node.getText(source) : undefined;
    const whole = ts.isNewExpression(node) || spelled !== undefined ? wholeChain(node) : undefined;
    if (whole === undefined) continue;
    if (spelled !== site.spelled && !chainNames(throughCalls(whole)).includes(site.spelled)) continue;
    const head = headOf(whole);
    if (head.kind !== ts.SyntaxKind.SuperKeyword) return chainOf(whole);
    const base = superclassOf(head);
    return base === undefined ? undefined : chainOf(base);
  }
  return undefined;
}

function chainOf(whole: ts.Node): Chain {
  const member = chainNames(whole)[1];
  return { root: headOf(whole), ...(member === undefined ? {} : { member }) };
}

/** The chain `whole` begins, through the calls and assertions written on it: `a.b(x).c` from `a.b`. */
function throughCalls(whole: ts.Node): ts.Node {
  let chain = whole;
  while ((ts.isCallExpression(chain.parent) || ts.isNonNullExpression(chain.parent) || ts.isPropertyAccessExpression(chain.parent)) && chain.parent.expression === chain) chain = chain.parent;
  return chain;
}

function wholeChain(node: ts.Node): ts.Node {
  let whole = node;
  while (ts.isQualifiedName(whole.parent) || (ts.isPropertyAccessExpression(whole.parent) && (whole.parent.expression === whole || whole.parent.name === whole))) whole = whole.parent;
  return whole;
}

/** The names of a chain from its root: `a.b.c` and `a.b(x).c` are `a`, `b`, `c`; the chain stops at anything else. */
function chainNames(node: ts.Node): string[] {
  if (ts.isIdentifier(node)) return [node.text];
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) return [node.kind === ts.SyntaxKind.ThisKeyword ? "this" : "super"];
  if (ts.isQualifiedName(node)) return [...chainNames(node.left), node.right.text];
  if (ts.isPropertyAccessExpression(node)) return [...chainNames(node.expression), node.name.text];
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isNonNullExpression(node) || ts.isElementAccessExpression(node)) return chainNames(node.expression);
  return [];
}

/** The one repository class a heritage proof names, with its file. */
function classOf(heritage: Heritage | undefined): { file: string; declaration: ts.ClassLikeDeclaration } | undefined {
  const only = heritage === undefined || typeof heritage === "string" || heritage.declarations.length !== 1 ? undefined : heritage.declarations[0]!;
  return only !== undefined && ts.isClassLike(only) ? { file: (heritage as Exclude<Heritage, string>).file, declaration: only } : undefined;
}

/**
 * Whether a class declares an instance member only it and its subclasses can hold: a `#` name, or a `private` or
 * `protected` one, a constructor's parameter properties included. Such a member makes TypeScript compare its type by
 * declaration, so no other value fits it without an `any` or a cast.
 */
function declaresRestricted(declaration: ts.ClassLikeDeclaration): boolean {
  const restricted = (member: ts.Declaration): boolean => {
    const flags = ts.getCombinedModifierFlags(member);
    return (flags & ts.ModifierFlags.Static) === 0 && ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0 || ts.isPrivateIdentifier(ts.getNameOfDeclaration(member) ?? member));
  };
  return declaration.members.some((member) => (ts.isConstructorDeclaration(member) ? member.parameters.some(restricted) : restricted(member)));
}

/** The `extends` expression of the class whose code holds `keyword`. */
function superclassOf(keyword: ts.Node): ts.Expression | undefined {
  let node: ts.Node = keyword;
  while (!ts.isSourceFile(node) && !ts.isClassLike(node)) node = node.parent;
  if (!ts.isClassLike(node)) return undefined;
  return node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
}

function headOf(node: ts.Node): ts.Node {
  let head = node;
  for (;;) {
    if (ts.isCallExpression(head) || ts.isNewExpression(head) || ts.isPropertyAccessExpression(head) || ts.isElementAccessExpression(head) || ts.isNonNullExpression(head) || ts.isExpressionWithTypeArguments(head) || ts.isDecorator(head)) head = head.expression;
    else if (ts.isTaggedTemplateExpression(head)) head = head.tag;
    else if (ts.isTypeReferenceNode(head)) head = head.typeName;
    else if (ts.isQualifiedName(head)) head = head.left;
    else if (ts.isTypeQueryNode(head)) head = head.exprName;
    else return head;
  }
}

/** Whether a name is read as a type: alone or as the first name of a qualified one, inside a type. */
function isTypeName(name: ts.Identifier): boolean {
  let whole: ts.Node = name;
  while (ts.isQualifiedName(whole.parent) && whole.parent.left === whole) whole = whole.parent;
  return ts.isPartOfTypeNode(whole) || ts.isTypeParameterDeclaration(whole.parent);
}

function isImportDeclaration(declaration: ts.Declaration): boolean {
  return ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration) || ts.isImportEqualsDeclaration(declaration);
}

/**
 * A root `declarations` bind: `local` when every one lies inside the syntax of the declaration whose body writes the use,
 * otherwise declared, by the 1-based lines their names are written on.
 */
function declaredBinding(source: ts.SourceFile, root: ts.Identifier, declarations: readonly ts.Node[], owner: UseSite["owner"]): RootBinding {
  const around = ownerAround(source, root, owner);
  if (around !== undefined && declarations.every((declaration) => isInside(declaration, around))) return { kind: "local", root: root.text };
  const lines = declarations.map((declaration) => lineOf(source, nameOf(declaration) ?? declaration));
  const captured = declarations.length > 0 && declarations.every((declaration) => isValueBinding(declaration) && inFunction(declaration));
  return { kind: "declared", root: root.text, lines: [...new Set(lines)].sort((a, b) => a - b), captured };
}

/** A parameter, a variable or a catch binding, destructured or not: a value, never a function, class or type declaration. */
function isValueBinding(declaration: ts.Node): boolean {
  return ts.isParameter(declaration) || ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration);
}

function inFunction(node: ts.Node): boolean {
  for (let around = node.parent; around !== undefined && !ts.isSourceFile(around); around = around.parent) if (ts.isFunctionLike(around)) return true;
  return false;
}

/** The innermost declaration around `node` that is `owner`: its name is the owner's, written on a line the owner spans. */
function ownerAround(source: ts.SourceFile, node: ts.Node, owner: UseSite["owner"]): ts.Node | undefined {
  for (let around = node.parent; around !== undefined && !ts.isSourceFile(around); around = around.parent) {
    const name = nameOf(around);
    if (name === undefined || name.getText(source) !== owner.name) continue;
    const line = lineOf(source, name);
    if (owner.line <= line && line <= owner.endLine) return around;
  }
  return undefined;
}

function nameOf(declaration: ts.Node): ts.Node | undefined {
  if (ts.isConstructorDeclaration(declaration)) return declaration.getChildren().find((child) => child.kind === ts.SyntaxKind.ConstructorKeyword);
  return ts.getNameOfDeclaration(declaration as ts.Declaration);
}

/** By offsets in the file's text, since the binder reads its own tree of the same text: inside, and not `around` itself. */
function isInside(node: ts.Node, around: ts.Node): boolean {
  const [start, aroundStart] = [node.getStart(), around.getStart()];
  return aroundStart <= start && node.end <= around.end && (start !== aroundStart || node.end !== around.end);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/**
 * The declarations of the innermost type scope around a type name that declares it: a type parameter, an `infer` of the
 * conditional whose true branch holds the name, a mapped type's key, or a declaration among the statements of an
 * enclosing block, namespace or the file. None when no scope declares it, so the file's imports and the globals answer.
 */
function typeScopeOf(name: ts.Identifier): ts.Node[] | undefined {
  let inner: ts.Node = name;
  for (let scope = name.parent; scope !== undefined; inner = scope, scope = scope.parent) {
    const declared: ts.Node[] = [];
    if ("typeParameters" in scope) for (const parameter of (scope.typeParameters as ts.NodeArray<ts.TypeParameterDeclaration> | undefined) ?? []) if (parameter.name.text === name.text) declared.push(parameter);
    if (ts.isMappedTypeNode(scope) && scope.typeParameter.name.text === name.text) declared.push(scope.typeParameter);
    if (ts.isConditionalTypeNode(scope) && inner === scope.trueType) declared.push(...inferredIn(scope.extendsType, name.text));
    if (ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isSourceFile(scope)) declared.push(...scope.statements.filter((statement) => declaredName(statement) === name.text));
    if (declared.length > 0) return declared;
  }
  return undefined;
}

function inferredIn(node: ts.Node, name: string): ts.TypeParameterDeclaration[] {
  if (ts.isInferTypeNode(node)) return node.typeParameter.name.text === name ? [node.typeParameter] : [];
  return node.getChildren().flatMap((child) => inferredIn(child, name));
}

function declaredName(statement: ts.Statement): string | undefined {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) return statement.name.text;
  if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name !== undefined) return statement.name.text;
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) return statement.name.text;
  return undefined;
}

type SiteSyntax = "valid" | "local" | "this-member";

/** Whether a name of `source` binds a parameter whose value is only what the caller passes (`bindsParameter`). */
type ParameterUse = (source: ts.SourceFile, text: string, identifier: ts.Identifier) => boolean;

/** The root of the plain chain of names each site spells and ends in its name, read in the file's tree. */
function rootsAt({ source, shape, starting }: FileIndex, text: string, group: readonly { site: ResolvedNameSite; index: number }[], isParameterUse: ParameterUse, isDynamicUse: ParameterUse): { roots: Map<number, { root: string; bare: boolean; local: boolean; pastRoot: boolean }>; shape: FileShape } {
  const starts = source.getLineStarts();
  const wanted = new Map<number, { site: ResolvedNameSite; index: number }[]>();
  for (const item of group) {
    const { line, column } = item.site;
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1 || line > starts.length) continue;
    const point = starts[line - 1]! + column - 1;
    if (point >= (line < starts.length ? starts[line]! : text.length)) continue;
    wanted.set(point, [...(wanted.get(point) ?? []), item]);
  }
  const isDynamicRoot = (spelled: ts.Node): boolean => {
    const root = headOf(spelled);
    return ts.isIdentifier(root) && isDynamicUse(source, text, root);
  };
  /** Chains that start at one point share their root, so the first that ends in the name settles it. */
  const roots = new Map<number, { root: string; bare: boolean; local: boolean; pastRoot: boolean }>();
  for (const [point, sites] of wanted) for (const node of starting.get(point) ?? []) for (const { site, index } of sites) {
    const spelled = spelledAt(node, site.kind);
    const names = spelled === undefined ? undefined : plainChain(spelled);
    if (names === undefined || names.at(-1) !== site.name || roots.has(index) || isDynamicRoot(spelled!)) continue;
    const bare = names.length === 1;
    roots.set(index, { root: names[0]!, bare, local: bare && ts.isIdentifier(spelled!) && !ts.isTypeNode(spelled.parent) && isParameterUse(source, text, spelled), pastRoot: readsPastRoot(site.kind, names.length) });
  }
  return { roots, shape };
}

/** What a node starting at an edge's column spells for the edge's kind: a call's callee, an instantiation's class, or a name up to the whole qualified name it ends. */
function spelledAt(node: ts.Node, kind: string): ts.Node | undefined {
  if (kind === "calls") return ts.isCallExpression(node) ? node.expression : undefined;
  if (kind === "instantiates") return ts.isNewExpression(node) ? node.expression : undefined;
  if (!ts.isIdentifier(node)) return undefined;
  let spelled: ts.Node = node;
  while ((ts.isQualifiedName(spelled.parent) && spelled.parent.right === spelled) || (ts.isPropertyAccessExpression(spelled.parent) && spelled.parent.name === spelled)) spelled = spelled.parent;
  return spelled;
}

/** The names of `a.b.c` from its root, or none when any link is not a plain name. */
function plainChain(node: ts.Node): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isQualifiedName(node)) return plainChain(node.left)?.concat(node.right.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return plainChain(node.expression)?.concat(node.name.text);
  return undefined;
}

function indexed(source: ts.SourceFile): FileIndex | undefined {
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return undefined;
  const starting = new Map<number, ts.Node[]>();
  const visit = (node: ts.Node): void => {
    const start = node.getStart(source);
    const list = starting.get(start);
    if (list === undefined) starting.set(start, [node]);
    else list.push(node);
    node.forEachChild(visit);
  };
  visit(source);
  return { source, shape: describeTree(source), starting };
}

/** Check each graph spelling at its exact 1-based UTF-16 position in the file's tree. */
function checkSites({ source, shape, starting }: FileIndex, text: string, group: readonly { site: ImportOriginSite; index: number }[], isParameterUse: ParameterUse, isDynamicUse: ParameterUse): { matches: Map<number, SiteSyntax>; shape: FileShape } {
  const result = new Map<number, SiteSyntax>();
  const starts = source.getLineStarts();
  const wanted = new Map<number, { site: ImportOriginSite; index: number }[]>();
  for (const item of group) {
    const { site } = item;
    if (!Number.isInteger(site.line) || site.line < 1 || !Number.isInteger(site.column) || site.column! < 1 || site.line > starts.length || !site.fullName || !site.kind) continue;
    const start = starts[site.line - 1]!;
    const point = start + site.column! - 1;
    const end = site.line < starts.length ? starts[site.line]! : text.length;
    if (point >= end || point >= text.length) continue;
    const list = wanted.get(point) ?? [];
    list.push(item); wanted.set(point, list);
  }
  const matches = new Map<number, ts.Node[]>();
  const ownCalls = new Map<number, number>();
  for (const [point, candidates] of wanted) for (const node of starting.get(point) ?? []) for (const { site, index } of candidates) {
    const expr = site.kind === "calls" && ts.isCallExpression(node) ? node.expression : site.kind === "instantiates" && ts.isNewExpression(node) ? node.expression : undefined;
    if (expr !== undefined && syntaxName(expr, source) === site.fullName) {
      const found = matches.get(index) ?? []; found.push(expr); matches.set(index, found);
    } else if (matchesReferenceKind(node, site.kind) && syntaxName(node, source) === site.fullName) {
      const found = matches.get(index) ?? []; found.push(node); matches.set(index, found);
    } else if (site.kind === "calls" && ts.isCallExpression(node) && callsOwnMember(node.expression, site.fullName!)) {
      ownCalls.set(index, (ownCalls.get(index) ?? 0) + 1);
    }
  }
  for (const { site, index } of group) {
    const found = matches.get(index);
    if (found === undefined && ownCalls.get(index) === 1) result.set(index, "this-member");
    if (found?.length !== 1) continue;
    const node = found[0]!;
    const root = headOf(node);
    if (ts.isIdentifier(root) && isDynamicUse(source, text, root)) continue;
    result.set(index, site.kind === "calls" && ts.isIdentifier(node) && node.text === site.name && isParameterUse(source, text, node) ? "local" : "valid");
  }
  return { matches: result, shape };
}

/** `this.name` whose `this` is an instance of a class declared outside any function or class, inside one of its instance members. */
function callsOwnMember(callee: ts.Expression, name: string): boolean {
  if (!ts.isPropertyAccessExpression(callee) || callee.expression.kind !== ts.SyntaxKind.ThisKeyword || callee.name.text !== name) return false;
  for (let node: ts.Node = callee.parent; !ts.isSourceFile(node); node = node.parent) {
    if (ts.isArrowFunction(node)) continue;
    if (ts.isClassStaticBlockDeclaration(node)) return false;
    if (ts.isFunctionLike(node) || ts.isPropertyDeclaration(node)) return ts.isClassLike(node.parent) && !isStatic(node) && !isNested(node.parent);
  }
  return false;
}

function isNested(declaration: ts.ClassLikeDeclaration): boolean {
  for (let node = declaration.parent; !ts.isSourceFile(node); node = node.parent) if (ts.isFunctionLike(node) || ts.isClassLike(node)) return true;
  return false;
}

/**
 * Whether `identifier` binds, by the file's own scoping, a parameter of a function around it whose value is only what the
 * caller passes: no default, no rest, no destructuring, declared once. The compiler keeps the parameter when the
 * function's body declares its name again at its top level; a function declared there replaces it when the code runs.
 */
function bindsParameter(binding: LexicalBinding, name: string): boolean {
  if (binding.kind !== "declared" || binding.declarations.length !== 1) return false;
  const declaration = binding.declarations[0]!;
  if (!ts.isParameter(declaration) || declaration.initializer !== undefined || declaration.dotDotDotToken !== undefined) return false;
  const owner = declaration.parent;
  const body = "body" in owner ? owner.body : undefined;
  return body === undefined || !ts.isBlock(body) || !body.statements.some((statement) => topLevelNames(statement).includes(name));
}

/**
 * The start of every name of the file that `bindsParameter` proves. Only names spelled like a parameter are asked.
 */
function parameterUses(path: string, text: string): ReadonlySet<number> {
  const { tree, bindingOf } = bindFile(path, text);
  const names = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) names.add(node.name.text);
    node.forEachChild(collect);
  };
  collect(tree);
  const starts = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text) && bindsParameter(bindingOf(node), node.text)) starts.add(node.getStart(tree));
    node.forEachChild(visit);
  };
  if (names.size > 0) visit(tree);
  return starts;
}

/** Text that may hold a `with` statement or a direct `eval`, the only scopes the binder calls dynamic. */
const DYNAMIC_SCOPE = /\bwith\b|\beval\b/;

/** The start of every name of the file whose binding a dynamic scope decides (ADR-0029 decision 3). */
function dynamicUses(path: string, text: string): ReadonlySet<number> {
  const { tree, bindingOf } = bindFile(path, text);
  const starts = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindingOf(node).kind === "dynamic") starts.add(node.getStart(tree));
    node.forEachChild(visit);
  };
  visit(tree);
  return starts;
}

function topLevelNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []));
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) return [statement.name.text];
  return [];
}

/**
 * The local names the file's imports bind, read by the one module-statement reader. A name an `import x = require`
 * binds is a declaration only when the file declares it again.
 */
function describeTree(tree: ts.SourceFile): FileShape {
  const bindings = new Map<string, string>();
  const declared = declarationCounts(tree);
  for (const statement of tree.statements) {
    const read = moduleStatement(statement, tree);
    if (read?.kind !== "import" || read.specifier === undefined) continue;
    for (const { local } of read.bindings) {
      bindings.set(local!, read.specifier);
      if (read.form === "import-equals") declared.set(local!, declared.get(local!)! - 1);
    }
  }
  return { bindings, declared: new Set([...declared].filter(([, count]) => count > 0).map(([name]) => name)) };
}
