import type { EntrypointExtractor } from "../../../ports/entrypoint-extractor.port.ts";
import type { FrameworkPlugin } from "../../../ports/framework-plugin.port.ts";
import type { ImportedName, RouterVocabulary } from "../../../ports/router-vocabulary.port.ts";
import type { AngularConsumerSyntaxFactory, InputSyntax } from "../../../ports/angular-consumer-syntax.port.ts";
import type { FrameworkValueFactory } from "../../../ports/framework-values.port.ts";

const ROUTER_PACKAGE = "@angular/router";
const ROUTER_MODULE = "RouterModule";
const KNOWN_ROUTER_FEATURES = new Set(["withComponentInputBinding", "withDebugTracing", "withDisabledInitialNavigation", "withEnabledBlockingInitialNavigation", "withHashLocation", "withInMemoryScrolling", "withNavigationErrorHandler", "withPreloading", "withRouterConfig", "withViewTransitions"]);
const CONFIGURATIONS: ReadonlyMap<string, "root" | "child"> = new Map([
  ["provideRouter", "root"],
  ["RouterModule.forRoot", "root"],
  ["RouterModule.forChild", "child"],
]);

/** The export of the router a name reaches, then the members written after it; none for a name the router does not bind. */
function routerPathOf({ binding, members }: ImportedName): readonly string[] | undefined {
  if (binding?.module !== ROUTER_PACKAGE) return undefined;
  return binding.imported === "*" ? members : [binding.imported, ...members];
}

const ANGULAR_ROUTER: RouterVocabulary = {
  signal: { dependency: ROUTER_PACKAGE, module: ROUTER_PACKAGE },
  configurationOf: (callee) => CONFIGURATIONS.get(routerPathOf(callee)?.join(".") ?? ""),
  isRouterModule: (name) => routerPathOf(name)?.[0] === ROUTER_MODULE,
};

function isAngularInput({ name, kind, required }: InputSyntax["declarations"][number]): boolean {
  if (name.binding?.module !== "@angular/core") return false;
  const path = name.binding.imported === "*" ? name.members : [name.binding.imported, ...name.members];
  return path.length === 1 && (kind === "decorator" ? path[0] === "Input" && !required : path[0] === "input" || path[0] === "model");
}

function inputsNamed(inputs: readonly InputSyntax[], publicName: string): InputSyntax[] {
  return inputs.filter((candidate) => candidate.declarations.some((declaration) => isAngularInput(declaration) && declaration.aliasUnreadable !== true && (declaration.alias ?? candidate.member.member) === publicName));
}

function unreadableInput(inputs: readonly InputSyntax[]): boolean {
  return inputs.some((candidate) => candidate.declarations.some((declaration) => isAngularInput(declaration) && declaration.aliasUnreadable === true));
}

/** The readers of the TypeScript pack the plugin wraps, each built over the vocabulary the plugin hands it. */
export interface AngularReaders {
  routes(router: RouterVocabulary): EntrypointExtractor;
  consumer?: AngularConsumerSyntaxFactory;
  values?: FrameworkValueFactory;
}

/** Angular over the TypeScript pack: its route tables are its entrypoints, read in the projects that depend on its router. */
export function createAngularPlugin(readers: AngularReaders): FrameworkPlugin {
  return { languages: ["typescript"], signal: ANGULAR_ROUTER.signal, entrypoints: readers.routes(ANGULAR_ROUTER), ...(readers.values === undefined ? {} : { values: readers.values }), ...(readers.consumer === undefined ? {} : { consumer: {
    signals: [{ dependency: "@angular/core", module: "@angular/core" }],
    async prepare(reading, repo) {
      const syntax = await readers.consumer!(reading, repo, ANGULAR_ROUTER);
      if (syntax === undefined) return undefined;
      return {
        associations: syntax.routes.filter(({ target, at }) => syntax.sameProject(target.file, at.path)).map(({ target }) => ({ site: target, dependency: ROUTER_PACKAGE })),
        uncertainFiles: syntax.uncertainFiles.map((file) => ({ file, dependency: ROUTER_PACKAGE })),
        follow(carrier) {
        const empty = { uses: [], next: [], frontiers: [] };
        const site = carrier.site;
        if (site.kind === "return") {
          const registrations = syntax.routes.filter(({ target, at }) => target.file === site.file && target.symbol === site.symbol && target.line === site.line && syntax.sameProject(target.file, at.path));
          const issues = syntax.issues(site.file);
          if (registrations.length === 0 && issues.length === 0) return undefined;
          const claims: import("../../../ports/consumer-contribution.port.ts").ContinuationClaim[] = [];
          const frontiers: import("../../../domain/contracts/consumer-flow.ts").FlowFrontier[] = [];
          for (const issue of issues) frontiers.push({ at: issue.at, cause: "unmodelled-flow", reason: issue.reason, hops: [] });
          const uses: import("../../../domain/contracts/consumer-flow.ts").FlowUse[] = [];
          const next: import("../../../domain/contracts/consumer-flow.ts").FlowNext[] = [];
          for (const registration of registrations) {
            const { root, component, at } = registration;
            const hops = [{ step: "resolver-input" as const, evidence: at }];
            if (root?.bootstrap === undefined || !syntax.sameProject(at.path, root.bootstrap.path) || component === undefined || registration.conditional === true) {
              frontiers.push({ at, cause: "unmodelled-flow", reason: "unresolved", hops });
              continue;
            }
            const reads = syntax.routeData(component.file, component.owner);
            const inputs = syntax.inputs(component.file, component.owner);
            if (reads === undefined || inputs === undefined) {
              frontiers.push({ at: { path: component.file, line: 1 }, cause: "unmodelled-flow", reason: "source-unreadable", hops });
              continue;
            }
            const exportOf = (name: ImportedName | undefined, module: string): string | undefined => name?.binding?.module === module ? (name.binding.imported === "*" ? name.members : [name.binding.imported, ...name.members]).join(".") : undefined;
            for (const read of reads) {
              const typed = exportOf(read.type, ROUTER_PACKAGE) === "ActivatedRoute";
              const injected = exportOf(read.injection?.callee, "@angular/core") === "inject" && exportOf(read.injection?.token, ROUTER_PACKAGE) === "ActivatedRoute";
              if (!typed && !injected) continue;
              const result = syntax.followExpression(read.expression, [registration.key, ...carrier.path], [...hops, { step: "route-data", evidence: read.at }]);
              uses.push(...result.uses); next.push(...result.next); frontiers.push(...result.frontiers);
            }
            const kind = routerPathOf(root.configuration)?.join(".");
            let option: boolean | "unreadable" = root.options === "unreadable" ? "unreadable" : false;
            if (Array.isArray(root.options)) for (const property of root.options) {
              if (property.name === undefined || property.name === "bindToComponentInputs") option = property.value;
            }
            const enabled = kind === "provideRouter" ? root.features.some((feature) => feature !== "unreadable" && routerPathOf(feature)?.join(".") === "withComponentInputBinding") : option === true;
            const unknown = kind === "provideRouter" ? !enabled && root.features.some((feature) => feature === "unreadable" || !KNOWN_ROUTER_FEATURES.has(routerPathOf(feature)?.join(".") ?? "")) : option === "unreadable";
            if (unknown) { frontiers.push({ at, cause: "unsupported-binding", reason: "unresolved", hops }); continue; }
            if (!enabled) {
              if (inputsNamed(inputs, registration.key).length > 0 || unreadableInput(inputs)) frontiers.push({ at, cause: "unsupported-binding", reason: "unresolved", hops });
              continue;
            }
            claims.push({ site: at, offset: registration.offset, context: JSON.stringify([root.bootstrap.path, root.bootstrapOffset, root.at.path, root.offset]), evidence: [at, root.at, root.bootstrap], next: [{ carrier: { site: { kind: "input", repo, file: component.file, owner: component.owner, name: registration.key }, path: carrier.path }, hops }] });
          }
          return { flow: { uses, next, frontiers }, claims };
        }
        if (site.kind !== "input") return undefined;
        const inputs = syntax.inputs(site.file, site.owner);
        if (inputs === undefined) return { flow: { ...empty, frontiers: [{ at: { path: site.file, line: 1 }, cause: "unmodelled-flow" as const, reason: "source-unreadable" as const, hops: [] }] }, claims: [] };
        if (unreadableInput(inputs)) return { flow: { ...empty, frontiers: [{ at: { path: site.file, line: 1 }, cause: "unsupported-binding" as const, reason: "unresolved" as const, hops: [] }] }, claims: [] };
        const matched = inputsNamed(inputs, site.name);
        if (matched.length === 0) return { flow: { ...empty, frontiers: [{ at: { path: site.file, line: 1 }, cause: "unsupported-binding" as const, reason: "unresolved" as const, hops: [] }] }, claims: [] };
        return { flow: empty, claims: matched.map((input) => ({ site: input.at, offset: input.offset, context: `input:${site.owner}:${site.name}`, evidence: [input.at], next: [{ carrier: { site: input.member, path: carrier.path }, hops: [{ step: "input" as const, evidence: input.at }] }] })) };
      } };
    },
  } }) };
}
