import type { EntrypointMap } from "../../../core/domain/map/entrypoint-map.ts";
import type { Cut, Fact } from "../../../core/domain/shared/fact.ts";

const base = { schema: "0.12.0", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: ["java", "typescript"], frameworks: ["angular", "spring"], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };
const at = (path: string, line: number, endLine?: number) => ({ path, line, ...(endLine === undefined ? {} : { endLine }) });
const unknownBase = (path: string) => ({ status: "unknown", reason: "unresolved", evidence: [at(path, 5), at(path, 13)] });
const knownBase = { status: "complete", value: { default: { contextPath: "/api" }, profiles: { prod: { contextPath: "/v1" } } }, evidence: [at("src/main/resources/application.yml", 3)] };
const route = (method: string, path: string, file: string, symbol: string, line: number, basePath: unknown) => ({
  status: "complete",
  evidence: [at(file, line, line + 8)],
  value: { kind: "http-route", name: `${method} ${path}`, method, path, handler: { path: file, symbol, line, endLine: line + 8 }, basePath },
});
const uiRoute = (name: string, module: string, declared: number, component: string | undefined, guards: readonly { name: string; path?: string; external?: true }[] = []) => ({
  status: "complete",
  evidence: [at(module, declared)],
  value: { kind: "ui-route", name, path: name, component: component === undefined ? "unknown" : { path: `src/app/pages${name}/${component}.component.ts`, symbol: `${component[0]!.toUpperCase()}${component.slice(1)}Component`, line: 10, endLine: 40 }, guards },
});
const unknown = (evidence: readonly object[], subject?: object) => ({ status: "unknown", reason: "no-extractor", evidence, ...(subject === undefined ? {} : { subject }) });
const wrap = (items: readonly unknown[], section: object = {}): Fact<EntrypointMap> => ({ ...base, status: "complete", value: { entrypoints: { ...base, status: "complete", value: items, ...section } } }) as never;
const cut = (kind: string, places: readonly string[], limit?: number): Cut => ({ kind, at: places, reason: kind, ...(limit === undefined ? {} : { limit }), reach: { kind: "anything" } }) as never;

const CONTROLLERS = ["Owner", "Pet", "Visit", "Vet", "Booking", "Invoice"];
const bases = [unknownBase("gateway/src/main/resources/application.yml"), unknownBase("customers/src/main/resources/application.yml"), knownBase];
const largeRoutes = CONTROLLERS.flatMap((controller, index) =>
  ["GET", "POST", "PUT", "DELETE"].flatMap((method, verb) => {
    const file = `services/${controller.toLowerCase()}-service/src/main/java/org/example/${controller.toLowerCase()}/web/${controller}Resource.java`;
    return [route(method, `/${controller.toLowerCase()}s${verb === 0 ? "" : "/{id}"}`, file, `${controller}Resource.${method.toLowerCase()}${controller}`, 20 + verb * 12, bases[index % bases.length])];
  }),
);
const modules = ["src/app/app-routing.module.ts", "src/app/pages/catalogue/catalogue-routing.module.ts", "src/app/pages/auth/auth-routing.module.ts"];
const largeUi = Array.from({ length: 24 }, (_, index) => uiRoute(`/pages/section-${index % 6}/page-${index}`, modules[index % 3]!, 7 + index, index % 8 === 7 ? undefined : `page${index}`, index % 5 === 0 ? [{ name: "AuthGuard", path: "src/app/auth/auth.guard.ts" }, { name: "(inline)" }] : []));

export interface EntrypointFixture { name: string; fact: Fact<EntrypointMap> }

export const ENTRYPOINT_FIXTURES: readonly EntrypointFixture[] = [
  {
    name: "small mix of kinds",
    fact: wrap([
      unknown([at("src/Gateway.java", 64, 79)], { candidate: "http-route", symbol: "Gateway.routerFunction", raisedBy: "org.springframework.RouterFunction" }),
      route("GET", "/owners/{id}", "src/OwnerResource.java", "OwnerResource.get", 54, bases[0]),
      route("POST", "/owners", "src/OwnerResource.java", "OwnerResource.create", 70, bases[0]),
      route("GET", "/fallback", "src/Fallback.java", "Fallback.fallback", 12, bases[1]),
      route("POST", "/fallback", "src/Fallback.java", "Fallback.fallback", 12, bases[1]),
      uiRoute("/orders", "src/routes.ts", 12, "orders", [{ name: "AuthGuard", path: "src/auth.guard.ts" }, { name: "RoleGuard", external: true }]),
      uiRoute("/public", "src/routes.ts", 14, "public"),
      uiRoute("/lazy", "src/routes.ts", 16, undefined),
      { status: "complete", evidence: [at("src/Queue.java", 7, 20)], value: { kind: "listener", name: "kafka orders", protocol: "kafka", destination: "orders", handler: { path: "src/Queue.java", symbol: "Queue.take", line: 7, endLine: 20 } } },
      { status: "complete", evidence: [at("src/Jobs.java", 5)], value: { kind: "job", name: "scheduled cron=0 0 * * *", trigger: { attribute: "cron", value: "0 0 * * *" }, handler: { path: "src/Jobs.java", symbol: "Jobs.nightly", line: 5 } } },
      { status: "complete", evidence: [], value: { kind: "callback", name: "a.b.C.m", contract: { type: "a.b.C", member: "m" }, handler: { path: "src/A.java", line: 7, symbol: "A.run" } } },
      unknown([at("src/Shared.java", 3), at("src/Base.java", 1)], { symbol: "Queue", raisedBy: "lib.Base" }),
      unknown([at("src/Shared.java", 3), at("src/Base.java", 2)]),
      route("GET", "/known-base", "src/Known.java", "Known.get", 9, knownBase),
      { ...route("GET", "/declared", "src/Declared.java", "Declared.get", 4, bases[0]), evidence: [{ path: "src/router.ts", line: 18, via: "declared-route", confidence: 0.7 }] },
      { ...route("GET", "/declared-too", "src/Declared.java", "Declared.other", 20, bases[0]), evidence: [{ path: "src/router.ts", line: 18, via: "declared-route", confidence: 0.7 }] },
    ]),
  },
  { name: "large: services, UI routes and unknowns in one file", fact: wrap([...largeRoutes, ...largeUi, ...Array.from({ length: 12 }, (_, index) => unknown([at("src/config/very-long-shared-unresolved-location.ts", 8 + index * 3, 9 + index * 3)]))]) },
  { name: "partial with cuts that name places", fact: ({ ...wrap([route("GET", "/a", "src/A.java", "A.get", 3, bases[0])], { status: "partial", cuts: [cut("depth", ["src/anchor-1.ts"], 2), cut("unresolved-link", ["src/B.java::B.save", "src/B.java:21 port.save"])] }), status: "partial", cuts: [cut("section", ["entrypoints"])] }) as never },
  { name: "unknown section", fact: ({ ...base, status: "partial", cuts: [cut("section", ["entrypoints"])], value: { entrypoints: { ...base, status: "unknown", reason: "index-unavailable", evidence: [at("src/gone.ts", 1)] } } }) as never },
  { name: "empty and complete", fact: wrap([]) },
];
