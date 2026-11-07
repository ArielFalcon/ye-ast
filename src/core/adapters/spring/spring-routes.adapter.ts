import type { LibrarySource } from "../../domain/topology/library-source.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { sortFindings } from "../../domain/entrypoints/finding-order.ts";
import { httpRouteName, type BasePath, type HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { isJavaSource, isJvmTestFile } from "../../domain/languages/java.ts";
import { isSpringConfigFile, resourcesOfSource } from "../../domain/languages/spring-config.ts";
import { declarationSpan } from "../../domain/shared/fact.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { ContractOperation, ContractRoutes } from "../../ports/contract-routes.port.ts";
import type { EntrypointExtractor, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { withJavaSources, type ParseJava } from "./java-project.ts";
import { delegateMethodsOf, sourceGeneratorIn } from "./api-delegates.ts";
import { basePathOf, configurationsOf } from "./application-config.ts";
import { spanOf, unknown, unknownAt, type MappedEntrypoint, type MappedRoute } from "./findings.ts";
import { foreignEndpointsOf } from "./foreign-endpoints.ts";
import { listenersOf } from "./listeners.ts";
import { natsListenersOf } from "./nats-listeners.ts";
import { basePathConfigurations, pathPrefixConfigurations } from "./path-prefix.ts";
import {
  counterpart,
  asLibrarySources,
  createJavaProject,
  isLibraryPath,
  externalNames,
  scopeOf,
  type Expr,
  type Gap,
  type GapReason,
  type Hierarchy,
  type JavaFile,
  type JavaProject,
  type MethodDecl,
  type SupertypeGap,
  type TypeDecl,
} from "./java-symbols.ts";
import {
  annotationUses,
  createSpringAnnotations,
  pathExpressions,
  SCANNED_STEREOTYPES,
  SPRING_BOOT_APPLICATION,
  type Attributes,
  type Mapping,
  type MappingLookup,
  type SpringAnnotations,
} from "./request-mapping.ts";
import { JavaValueEvaluator } from "./java-value-evaluator.ts";
import { compareText } from "../../domain/shared/code-node.ts";

const REQUEST_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]);
const ROUTER_FUNCTIONS: readonly string[] = [
  "org.springframework.web.reactive.function.server.RouterFunction",
  "org.springframework.web.servlet.function.RouterFunction",
];

type Outcome<T> = { value: T } | { gap: GapReason };

interface Resolution<T> {
  values: T[];
  gaps: { expr: Expr; reason: GapReason }[];
}

interface Controller {
  type: TypeDecl;
  hierarchy: Hierarchy;
  classMapping: MappingLookup;
  /** What keeps every mapped handler from being read: the class mapping or the controller itself is not decided. */
  blocking: Gap | undefined;
  /** The class shows no stereotype, but something the sources do not show may give it one: only its mapped handlers are reported. */
  speculative: boolean;
  project: JavaProject;
  annotations: SpringAnnotations;
  /** The contract operations of the repository, by the method name a generated interface gives them. */
  operations: ContractIndex;
}

/** The operations of every contract document in the repository, by `operationId`; two documents may declare one name. */
interface ContractIndex {
  byOperationId: ReadonlyMap<string, readonly ContractOperation[]>;
  /** A document the reader could not parse, as the item that reports it. */
  faults: readonly Finding<never>[];
  /** The routes of a contract whose servers disagree on the path: their base path is not known. */
  undecided: WeakSet<object>;
}

const NO_CONTRACTS: ContractRoutes = { operations: () => [] };

function contractIndex(operations: readonly Finding<ContractOperation>[]): ContractIndex {
  const byOperationId = new Map<string, ContractOperation[]>();
  const faults: Finding<never>[] = [];
  for (const finding of operations) {
    if (finding.status === "unknown") {
      faults.push(finding);
      continue;
    }
    const { operationId } = finding.value;
    if (operationId === undefined) continue;
    const held = byOperationId.get(operationId);
    if (held === undefined) byOperationId.set(operationId, [finding.value]);
    else held.push(finding.value);
  }
  return { byOperationId, faults, undecided: new WeakSet() };
}

export function createSpringRoutesExtractor(parser: JavaParser, contracts: ContractRoutes = NO_CONTRACTS): EntrypointExtractor {
  return { extract: async (files, libraries = []) => extractRoutes(parser, files, libraries, contracts) };
}

export function extractRoutes(parser: JavaParser, files: readonly SourceFile[], libraries: readonly LibrarySource[], contracts: ContractRoutes): readonly Finding<Entrypoint>[] {
  const index = contractIndex(contracts.operations(files));
  return withJavaSources(parser, (parse) => {
    const { files: parsed, unparsed } = parse(files.filter((source) => isJavaSource(source.path) && !isJvmTestFile(source.path)));
    const findings: Finding<MappedEntrypoint>[] = unparsed.map(({ path, line }) => unreadable(path, line));
    const project = createJavaProject(parsed);
    const annotations = createSpringAnnotations(project);
    const text = new JavaValueEvaluator(project, configurationsOf(files.filter((file) => isSpringConfigFile(file.path))));
    const generator = sourceGeneratorIn(files);
    findings.push(...index.faults, ...project.unreadable.map((file) => unreadable(file.path, 1)));
    for (const type of project.types) {
      findings.push(...guarded(() => findingsOfType(type, project, annotations, text, generator, index), () => unknown("unresolved", [spanOf(type.file.path, type.node)])));
    }
    findings.push(...natsListeners(project, text, parsed, libraries, files, parse));
    const readable = parsed.filter((file) => !project.unreadable.includes(file));
    const entrypoints = sortFindings(withPathPrefixes(findings, pathPrefixConfigurations(project, readable)));
    return withBasePaths(entrypoints, files, applicationModules(project, annotations), basePathConfigurations(project, readable, annotations), index.undecided);
  });
}

/**
 * The NATS listeners of the repository's own classes. With libraries, the classes are read over a project that also
 * holds the library sources, so a subscription a base class declares there is found; without, over the repository's own.
 */
function natsListeners(project: JavaProject, text: JavaValueEvaluator, parsed: readonly JavaFile[], libraries: readonly LibrarySource[], files: readonly SourceFile[], parse: ParseJava): Finding<MappedEntrypoint>[] {
  const javaLibraries = libraries.filter((source) => isJavaSource(source.path) && !isJvmTestFile(source.path));
  const view = javaLibraries.length === 0 ? { project, text } : withLibraries(parsed, javaLibraries, files, parse);
  return view.project.types
    .filter((type) => type.kind === "class" && !type.isAbstract && !isLibraryPath(type.file.path))
    .flatMap((type) => guarded(() => natsListenersOf(type, view.project, view.text), () => unknown("unresolved", [spanOf(type.file.path, type.node)])));
}

function withLibraries(parsed: readonly JavaFile[], libraries: readonly LibrarySource[], files: readonly SourceFile[], parse: ParseJava): { project: JavaProject; text: JavaValueEvaluator } {
  const foreign = parse(asLibrarySources(libraries)).files;
  const project = createJavaProject([...parsed, ...foreign]);
  return { project, text: new JavaValueEvaluator(project, configurationsOf(files.filter((file) => isSpringConfigFile(file.path)))) };
}

function unreadable(path: string, line: number): Finding<never> {
  return { status: "unknown", reason: "source-unreadable", evidence: [{ path, line }] };
}

/** An unexpected throw while one construct is read (a source can nest it deeper than the stack) leaves that construct unknown, never the whole extraction. */
function guarded(attempt: () => Finding<MappedEntrypoint>[], fallback: () => Finding<MappedEntrypoint>): Finding<MappedEntrypoint>[] {
  try {
    return attempt();
  } catch {
    return [fallback()];
  }
}

function findingsOfType(type: TypeDecl, project: JavaProject, annotations: SpringAnnotations, text: JavaValueEvaluator, generator: Evidence | undefined, operations: ContractIndex): Finding<MappedEntrypoint>[] {
  const found: Finding<MappedEntrypoint>[] = [...routerFunctionsOf(type), ...foreignEndpointsOf(type, annotations)];
  if (type.kind !== "class" || type.isAbstract) return found;
  const controller = controllerOf(type, project, annotations, operations);
  if (controller !== undefined) found.push(...routesOf(controller));
  found.push(...delegateMethodsOf(type, project, annotations, generator));
  found.push(...listenersOf(type, project, annotations, isScannedBean(type, annotations)));
  return found;
}

/**
 * Each route gets the base path of the configuration of its handler's module when that module holds a Spring Boot
 * application; otherwise the module that serves it, and so its configuration, is not known. Code that may set a base
 * path leaves every base path unknown.
 */
function withBasePaths(
  findings: readonly Finding<MappedEntrypoint>[],
  files: readonly SourceFile[],
  applications: ReadonlySet<string>,
  inCode: readonly Evidence[],
  undecided: WeakSet<object>,
): Finding<Entrypoint>[] {
  const configs = files.filter((file) => isSpringConfigFile(file.path)).toSorted((a, b) => compareText(a.path, b.path));
  const byModule = new Map<string, Finding<BasePath>>();
  const basePathAt = (resources: string): Finding<BasePath> => {
    const known = byModule.get(resources) ?? basePathOf(configs.filter((file) => /^(config\/)?[^/]+$/.test(file.path.slice(resources.length)) && file.path.startsWith(resources)));
    byModule.set(resources, known);
    return known;
  };
  return findings.map((finding): Finding<Entrypoint> => {
    if (finding.status === "unknown") return finding;
    const { value } = finding;
    if (value.kind !== "http-route") return { ...finding, value };
    const resources = resourcesOfSource(value.handler.path);
    const basePath: Finding<BasePath> =
      undecided.has(finding) || resources === undefined || !applications.has(resources)
        ? { status: "unknown", reason: "unresolved", evidence: finding.evidence }
        : inCode.length > 0
          ? { status: "unknown", reason: "no-extractor", evidence: inCode }
          : basePathAt(resources);
    return { ...finding, value: { ...value, basePath } };
  });
}

/** The main resources of every module that declares a `@SpringBootApplication` class; a type whose annotations cannot be read declares none. */
function applicationModules(project: JavaProject, annotations: SpringAnnotations): ReadonlySet<string> {
  return new Set(
    project.types
      .filter((type) => {
        try {
          return annotationUses(type.node, scopeOf(type)).some((use) => annotations.keyOf(use) === SPRING_BOOT_APPLICATION);
        } catch {
          return false;
        }
      })
      .flatMap((type) => resourcesOfSource(type.file.path) ?? []),
  );
}

/** Where a path prefix may be configured, no route is known: which routes it reaches depends on a predicate that is not evaluated. */
function withPathPrefixes(findings: readonly Finding<MappedEntrypoint>[], configurations: readonly Evidence[]): Finding<MappedEntrypoint>[] {
  if (configurations.length === 0) return [...findings];
  return findings.map((finding) => (finding.status === "complete" && finding.value.kind === "http-route" ? unknown("no-extractor", [...finding.evidence, ...configurations]) : finding));
}

/**
 * Spring serves a class when its type hierarchy carries a controller stereotype (`isHandler` expects a type-level
 * `@Controller`; a class mapping alone does not make a handler). A class that shows none is still reported when
 * something the sources do not give may supply one.
 */
function controllerOf(type: TypeDecl, project: JavaProject, annotations: SpringAnnotations, operations: ContractIndex): Controller | undefined {
  const hierarchy = project.hierarchy(type);
  const uses = hierarchy.types.map((member) => annotationUses(member.node, scopeOf(member)));
  const lookups = uses.map((own) => annotations.mappingIn(own));
  const classMapping = firstLookup(lookups);
  const stereotypes = uses.map((own) => annotations.stereotypeIn(own));
  const stereotype = stereotypes.find((candidate) => candidate === "controller") ?? stereotypes.find((candidate) => candidate !== "none") ?? "none";
  const controller = { type, hierarchy, classMapping, project, annotations, operations };
  const ambiguousSupertype = gapOf(hierarchy.gaps.find((gap) => gap.kind === "ambiguous"), "unresolved");
  if (stereotype === "controller") {
    const mappedAt = lookups.findIndex((lookup) => lookup !== undefined);
    const absentBeforeMapping = hierarchy.gaps.find((gap) => gap.kind === "missing" && (mappedAt === -1 || gap.before <= mappedAt));
    const blocking =
      ambiguousSupertype ??
      (classMapping !== undefined && "gap" in classMapping ? classMapping.gap : undefined) ??
      gapOf(absentBeforeMapping, "no-extractor") ??
      (isScannedBean(type, annotations) ? undefined : { reason: "no-extractor" as const, file: type.file, node: type.node });
    return { ...controller, blocking, speculative: false };
  }
  if (stereotype !== "none") {
    const [reason, use] = "ambiguous" in stereotype ? (["unresolved", stereotype.ambiguous] as const) : (["no-extractor", stereotype.unmodelled] as const);
    return { ...controller, blocking: { reason, file: use.scope.file, node: use.node }, speculative: false };
  }
  const library = uses.map((own) => annotations.libraryAnnotationIn(own)).find((use) => use !== undefined);
  const blocking =
    ambiguousSupertype ??
    (library && { reason: "no-extractor" as const, file: library.scope.file, node: library.node }) ??
    gapOf(hierarchy.gaps.find((gap) => gap.kind === "missing"), "no-extractor");
  return blocking === undefined ? undefined : { ...controller, blocking, speculative: true };
}

/**
 * Component scanning reads only the class's own annotations (`@Component` is not `@Inherited`), so a class that
 * inherits its stereotype is a bean only if something the sources may not show registers it.
 */
function isScannedBean(type: TypeDecl, annotations: SpringAnnotations): boolean {
  const own = annotationUses(type.node, scopeOf(type));
  return annotations.stereotypeIn(own) === "controller" || own.some((use) => SCANNED_STEREOTYPES.has(annotations.keyOf(use) ?? ""));
}

function gapOf(gap: SupertypeGap | undefined, reason: GapReason): Gap | undefined {
  return gap && { reason, file: gap.file, node: gap.node };
}

function firstLookup(lookups: readonly MappingLookup[]): MappingLookup {
  return lookups.find((lookup) => lookup !== undefined);
}

function routesOf(controller: Controller): Finding<MappedRoute>[] {
  const { type, project, annotations } = controller;
  const { handlers, undecided } = handlerCandidates(project.classChain(type), controller.hierarchy);
  const served = handlers.flatMap((method) => findingsOfHandler(controller, method));
  if (controller.speculative) return served;
  const classLibrary = controller.classMapping === undefined ? annotations.libraryAnnotationIn(annotationUses(type.node, scopeOf(type))) : undefined;
  const missing = controller.hierarchy.gaps.filter((gap) => gap.kind === "missing");
  return [
    ...(classLibrary === undefined ? [] : [unknown("no-extractor", [spanOf(type.file.path, classLibrary.node)])]),
    ...(contractCoversOverrides(controller, handlers, missing) ? [] : missing.map((gap) => unknown("no-extractor", [spanOf(gap.file.path, gap.node)]))),
    ...undecided.map((method) => unknownAt(method, { reason: "unresolved", file: method.owner.file, node: method.node })),
    ...served,
  ];
}

/**
 * A single interface the sources do not give, on a class with no mapping of its own, is fully read by a contract document
 * when that contract names every method the class overrides: the contract is the interface's source, so nothing of it is
 * left unknown. Two absent supertypes, a class mapping or an override no operation names leave the item in place.
 */
function contractCoversOverrides(controller: Controller, handlers: readonly MethodDecl[], missing: readonly SupertypeGap[]): boolean {
  if (controller.classMapping !== undefined || missing.length !== 1 || missing[0]?.isInterface !== true) return false;
  const overriding = handlers.filter((method) => method.overrides);
  return (
    overriding.length > 0 &&
    overriding.every((method) => {
      const join = contractJoin(controller, method);
      return join !== undefined && "finding" in join && mappingOfMethod(method, controller.project, controller.annotations) === undefined;
    })
  );
}

/** The methods that serve a request: those of the class chain that no nearer class overrides, and the default methods of its interfaces that nothing overrides. */
function handlerCandidates(chain: readonly TypeDecl[], hierarchy: Hierarchy): { handlers: MethodDecl[]; undecided: MethodDecl[] } {
  const handlers: MethodDecl[] = [];
  const undecided: MethodDecl[] = [];
  const classify = (method: MethodDecl, nearer: readonly TypeDecl[]): void => {
    for (const type of nearer) {
      const match = counterpart(type, method);
      if (match === "ambiguous") return void undecided.push(method);
      if (match !== undefined) return;
    }
    handlers.push(method);
  };
  chain.forEach((owner, index) => owner.methods.filter((method) => method.hasBody).forEach((method) => classify(method, chain.slice(0, index))));
  hierarchy.types.forEach((owner, index) => {
    const nearer = [...chain, ...hierarchy.types.slice(0, index).filter((type) => !chain.includes(type))];
    owner.methods.filter((method) => method.hasBody && method.modifiers.includes("default")).forEach((method) => classify(method, nearer));
  });
  return { handlers, undecided };
}

function findingsOfHandler(controller: Controller, method: MethodDecl): Finding<MappedRoute>[] {
  try {
    return readHandler(controller, method);
  } catch {
    return [unknownAt(method, { reason: "unresolved", file: method.owner.file, node: method.node })];
  }
}

function readHandler(controller: Controller, method: MethodDecl): Finding<MappedRoute>[] {
  const lookup = mappingOfMethod(method, controller.project, controller.annotations);
  if (lookup === undefined) {
    const joined = controller.speculative ? undefined : contractJoin(controller, method);
    if (joined !== undefined) return ["finding" in joined ? joined.finding : joined.ambiguous];
    const gap = controller.speculative ? undefined : unmappedGap(controller, method);
    return gap === undefined ? [] : [unknownAt(method, gap)];
  }
  if ("gap" in lookup) return [unknownAt(method, lookup.gap)];
  if (controller.blocking !== undefined) return [unknownAt(method, controller.blocking)];
  const classMapping = controller.classMapping !== undefined && "mapping" in controller.classMapping ? controller.classMapping.mapping : undefined;
  return routesOfHandler(method, lookup.mapping, classMapping, controller.project);
}

/**
 * A handler a contract document names: an `@Override` method of a controller that implements an interface the sources do
 * not give, joined to the contract's operation by `operationId` (RFC-0007 row S5). A name two operations of the repository
 * declare picks neither.
 */
function contractJoin(controller: Controller, method: MethodDecl): { operation: ContractOperation; finding: Finding<MappedRoute> } | { ambiguous: Finding<never> } | undefined {
  if (!method.overrides || !controller.hierarchy.gaps.some((gap) => gap.kind === "missing" && gap.isInterface)) return undefined;
  const candidates = controller.operations.byOperationId.get(method.name);
  if (candidates === undefined) return undefined;
  const span = spanOf(method.owner.file.path, method.node);
  if (candidates.length > 1) return { ambiguous: unknown("unresolved", [span, ...candidates.map((operation) => ({ path: operation.document, line: operation.line }))]) };
  const [operation] = candidates;
  if (operation === undefined) return undefined;
  const path = operation.basePath === undefined || operation.basePath === "" ? operation.path : joinPath(operation.basePath, operation.path);
  const finding: Finding<MappedRoute> = {
    status: "complete",
    value: {
      kind: "http-route",
      name: httpRouteName({ method: operation.method, path }),
      method: operation.method,
      path,
      handler: { path: span.path, symbol: `${method.owner.qualifiedName}.${method.name}`, line: span.line, ...declarationSpan(span.line, span.endLine) },
    },
    evidence: [span, { path: operation.document, line: operation.line }],
  };
  if (operation.basePath === undefined) controller.operations.undecided.add(finding);
  return { operation, finding };
}

/** A method with no mapping of its own that may still be one: it carries a library annotation, or overrides a method of a supertype the sources do not give. */
function unmappedGap(controller: Controller, method: MethodDecl): Gap | undefined {
  const library = controller.annotations.libraryAnnotationIn(annotationUses(method.node, scopeOf(method.owner)));
  if (library !== undefined) return { reason: "no-extractor", file: library.scope.file, node: library.node };
  if (!method.overrides) return undefined;
  const ambiguous = controller.hierarchy.gaps.find((gap) => gap.kind === "ambiguous");
  const missing = controller.hierarchy.gaps.find((gap) => gap.kind === "missing");
  return gapOf(ambiguous, "unresolved") ?? gapOf(missing, "no-extractor");
}

function mappingOfMethod(method: MethodDecl, project: JavaProject, annotations: SpringAnnotations): MappingLookup {
  for (const type of project.hierarchy(method.owner).types) {
    const declaration = type === method.owner ? method : counterpart(type, method);
    if (declaration === "ambiguous") return { gap: { reason: "unresolved", file: method.owner.file, node: method.node } };
    const found = declaration && annotations.mappingIn(annotationUses(declaration.node, scopeOf(declaration.owner)));
    if (found !== undefined) return found;
  }
  return undefined;
}

function routerFunctionsOf(type: TypeDecl): Finding<MappedRoute>[] {
  return type.methods
    .filter(returnsRouterFunction)
    .map((method) => unknown("no-extractor", [spanOf(type.file.path, method.node)]));
}

function returnsRouterFunction(method: MethodDecl): boolean {
  const returnType = method.node.childForFieldName("type");
  const name = (returnType?.type === "generic_type" ? returnType.namedChildren[0] : returnType)?.text;
  return name !== undefined && externalNames(name, method.owner.file, false).some((candidate) => ROUTER_FUNCTIONS.includes(candidate));
}

function routesOfHandler(handler: MethodDecl, mapping: Mapping, classMapping: Mapping | undefined, project: JavaProject): Finding<MappedRoute>[] {
  const span = spanOf(handler.owner.file.path, handler.node);
  const classAttributes: Attributes = classMapping?.attributes ?? new Map();
  const prefixes = resolveStrings(pathExpressions(classAttributes), project);
  const paths = resolveStrings(pathExpressions(mapping.attributes), project);
  const methods = resolveMethods([classMapping, mapping]);
  const versions = resolveVersion(mapping.attributes.get("version") ?? classAttributes.get("version"), project);

  const routes: Finding<MappedRoute>[] = [];
  for (const prefix of prefixes.values) {
    for (const path of paths.values) {
      for (const method of methods.values) {
        for (const version of versions.values) {
          const routePath = joinPath(prefix, path);
          routes.push({
            status: "complete",
            value: {
              kind: "http-route",
              name: httpRouteName({ method, path: routePath, ...(version === undefined ? {} : { version }) }),
              method,
              path: routePath,
              ...(version === undefined ? {} : { version }),
              handler: { path: span.path, symbol: `${handler.owner.qualifiedName}.${handler.name}`, line: span.line, ...declarationSpan(span.line, span.endLine) },
            },
            evidence: [span],
          });
        }
      }
    }
  }
  const unresolved = [...prefixes.gaps, ...paths.gaps, ...methods.gaps, ...versions.gaps];
  return [...routes, ...unresolved.map(({ expr, reason }) => unknown(reason, [span, spanOf(expr.scope.file.path, expr.node)]))];
}

function resolveStrings(exprs: readonly Expr[] | undefined, project: JavaProject): Resolution<string> {
  if (exprs === undefined || exprs.length === 0) return { values: [""], gaps: [] };
  return partition(exprs, (expr) => project.evaluate(expr));
}

function resolveVersion(exprs: readonly Expr[] | undefined, project: JavaProject): Resolution<string | undefined> {
  return exprs === undefined || exprs.length === 0 ? { values: [undefined], gaps: [] } : partition(exprs, (expr) => project.evaluate(expr));
}

/** The methods of the class mapping and of the handler are combined; none named at all serves any method. */
function resolveMethods(mappings: readonly (Mapping | undefined)[]): Resolution<HttpMethod> {
  const values = new Set<HttpMethod>();
  const gaps: Resolution<HttpMethod>["gaps"] = [];
  for (const mapping of mappings) {
    if (mapping === undefined) continue;
    if (mapping.verb !== undefined) values.add(mapping.verb);
    const resolution = partition(mapping.attributes.get("method") ?? [], requestMethodOf);
    resolution.values.forEach((value) => values.add(value));
    gaps.push(...resolution.gaps);
  }
  if (values.size === 0 && gaps.length === 0) values.add("ANY");
  return { values: [...values], gaps };
}

function requestMethodOf(expr: Expr): Outcome<HttpMethod> {
  const name = expr.node.type === "identifier" || expr.node.type === "field_access" ? (expr.node.text.split(".").pop() ?? "") : "";
  return REQUEST_METHODS.has(name) ? { value: name as HttpMethod } : { gap: "unresolved" };
}

function partition<T>(exprs: readonly Expr[], resolve: (expr: Expr) => Outcome<T>): Resolution<T> {
  const resolution: Resolution<T> = { values: [], gaps: [] };
  for (const expr of exprs) {
    const outcome = resolve(expr);
    if ("gap" in outcome) resolution.gaps.push({ expr, reason: outcome.gap });
    else resolution.values.push(outcome.value);
  }
  return resolution;
}

function joinPath(prefix: string, path: string): string {
  const joined = prefix === "" || path === "" ? prefix + path : `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}
