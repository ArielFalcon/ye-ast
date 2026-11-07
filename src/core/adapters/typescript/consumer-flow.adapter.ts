import ts from "typescript";
import { lineOf } from "./syntax.ts";
import { siteFile, sourceUnreadable, type Carrier, type CarrierSite, type FlowFrontier, type FlowNext, type FlowResult, type FlowUse } from "../../domain/contracts/consumer-flow.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { ConsumerFlowReader } from "../../ports/consumer-flow.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { buildProgram, resolverKey, type Program, type Unit } from "./consumer-flow.index.ts";
import { lineage, memberDeclaration, methodDeclared } from "./consumer-flow.classes.ts";
import { declaredInput, memberSite, Walker, type Held } from "./consumer-flow.walker.ts";

/**
 * Follows a value through the TypeScript sources of one repository. Reading is syntax only: every name is resolved
 * through the snapshot's own imports, fields, `inject()` calls and constructor parameters.
 */
export async function createConsumerFlowReader(files: readonly SourceFile[], repo: string): Promise<ConsumerFlowReader> {
  const program = await buildProgram(files);
  return { follow: (carrier) => follow(program, repo, carrier) };
}

function follow(program: Program, repo: string, { site, path }: Carrier): FlowResult {
  const unit = program.index.units.get(siteFile(site));
  if (unit === undefined) return sourceUnreadable(site);
  const walker = new Walker(repo, program, unit);
  const walkers = [walker];
  if (site.kind === "call-site") walker.startCallSite(site, path);
  else if (site.kind === "call-result") walker.startCallResult(site, path);
  else if (site.kind === "parameter") walker.startParameter(site, path);
  else if (site.kind === "member") walker.startMember(site, path);
  else if (site.kind === "member-read") walker.startMemberRead(site, path);
  else if (site.kind === "method-parameter") return followMethodParameter(repo, program, unit, site, path);
  else if (site.kind === "input") return followInput(repo, unit, site, path);
  else if (site.kind === "return") walkers.push(...resolverContinuation(program, repo, walker, site, path));
  else return sourceUnreadable(site);
  return {
    uses: ordered(walkers.flatMap((held) => held.uses)),
    next: ordered(walkers.flatMap((held) => held.next)),
    frontiers: ordered(walkers.flatMap((held) => held.frontiers)),
  };
}

/** An input carrier continues as the member that declares the input of that public name, or is lost at the class. */
function followInput(repo: string, unit: Unit, site: Extract<CarrierSite, { kind: "input" }>, path: Carrier["path"]): FlowResult {
  const cls = unit.classes.get(site.owner);
  const member = cls === undefined ? undefined : declaredInput(unit, cls, site.name);
  if (cls === undefined || member === undefined || member.name === undefined || !ts.isIdentifier(member.name)) {
    const at = { path: unit.file, line: cls === undefined ? 1 : lineOf(unit.tree, cls) };
    return { uses: [], next: [], frontiers: [{ at, cause: "unsupported-binding", reason: "unresolved", detail: `not-an-input:${site.name}`, hops: [] }] };
  }
  const hops = [{ step: "input" as const, evidence: { path: unit.file, line: lineOf(unit.tree, member) } }];
  return { uses: [], next: [{ carrier: { site: memberSite(repo, unit, cls, site.owner, member.name.text), path }, hops }], frontiers: [] };
}

/** A component method a template calls: the nearest declaration of its name along the class lineage, read when it is a method and a frontier when it is anything else. */
function followMethodParameter(repo: string, program: Program, unit: Unit, site: Extract<CarrierSite, { kind: "method-parameter" }>, path: Carrier["path"]): FlowResult {
  const cls = unit.classes.get(site.owner);
  for (const held of cls === undefined ? [] : lineage(program, { unit, cls })) {
    const declaration = memberDeclaration(held.cls, site.method, false);
    if (declaration === undefined) continue;
    const method = methodDeclared(held.cls, site.method);
    if (method === undefined) {
      const at = { path: held.unit.file, line: lineOf(held.unit.tree, declaration) };
      return { uses: [], next: [], frontiers: [{ at, cause: "unmodelled-flow", reason: "unresolved", detail: "component method is not a function", hops: [] }] };
    }
    const walker = new Walker(repo, program, held.unit);
    walker.startFunctionParameter(method, site.index, path);
    return { uses: ordered(walker.uses), next: ordered(walker.next), frontiers: ordered(walker.frontiers) };
  }
  const at = { path: unit.file, line: cls === undefined ? 1 : lineOf(unit.tree, cls) };
  return { uses: [], next: [], frontiers: [{ at, cause: "unmodelled-flow", reason: "unresolved", detail: "component method not found", hops: [] }] };
}

/** A route resolver continues to the component input it feeds and to the component's reads of the route data. */
function resolverContinuation(program: Program, repo: string, walker: Walker, site: { file: string; symbol: string; line: number }, path: Carrier["path"]): Walker[] {
  const walkers: Walker[] = [];
  for (const registration of program.routes.resolvers.get(resolverKey(site.file, site.symbol, site.line)) ?? []) {
    const { component } = registration;
    const owner = component === undefined ? undefined : program.index.units.get(component.file);
    const cls = component === undefined ? undefined : owner?.classes.get(component.name);
    if (component === undefined || owner === undefined || cls === undefined) {
      walker.frontiers.push({ file: registration.at.path, pos: 0, value: { at: registration.at, cause: "unmodelled-flow", reason: "unresolved", detail: "route component not resolved", hops: [] } });
      continue;
    }
    const hops = [{ step: "resolver-input" as const, evidence: registration.at }];
    if (registration.inputBinding) {
      walker.next.push({ file: registration.at.path, pos: 0, value: { carrier: { site: { kind: "input", repo, file: owner.file, owner: component.name, name: registration.key }, path }, hops } });
    } else if (declaredInput(owner, cls, registration.key) !== undefined) {
      walker.frontiers.push({ file: registration.at.path, pos: 0, value: { at: registration.at, cause: "unsupported-binding", reason: "unresolved", detail: "component input binding is not enabled", hops } });
    }
    const reads = new Walker(repo, program, owner);
    reads.startRouteData(component.name, registration.key, path, hops);
    walkers.push(reads);
  }
  return walkers;
}

function ordered<T extends FlowUse | FlowNext | FlowFrontier>(items: readonly Held<T>[]): T[] {
  return [...items].sort((a, b) => compareText(a.file, b.file) || a.pos - b.pos).map(({ value }) => value);
}
