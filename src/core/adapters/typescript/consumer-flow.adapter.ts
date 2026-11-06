import type { Carrier, FlowFrontier, FlowNext, FlowResult, FlowUse } from "../../domain/contracts/consumer-flow.ts";
import type { ConsumerFlowReader } from "../../ports/consumer-flow.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { buildProgram, resolverKey, type Program } from "./consumer-flow.index.ts";
import { hasMember, memberSite, Walker, type Held } from "./consumer-flow.walker.ts";

/**
 * Follows a value through the TypeScript sources of one repository. Reading is syntax only: every name is resolved
 * through the snapshot's own imports, fields, `inject()` calls and constructor parameters.
 */
export async function createConsumerFlowReader(files: readonly SourceFile[], repo: string): Promise<ConsumerFlowReader> {
  const program = await buildProgram(files);
  return { follow: (carrier) => follow(program, repo, carrier) };
}

function follow(program: Program, repo: string, { site, path }: Carrier): FlowResult {
  const unit = program.index.units.get(site.file);
  if (unit === undefined) {
    const at = { path: site.file, line: site.kind === "member" ? (site.line ?? 1) : site.line };
    return { uses: [], next: [], frontiers: [{ at, cause: "unmodelled-flow", reason: "source-unreadable", hops: [] }] };
  }
  const walker = new Walker(repo, program, unit);
  const walkers = [walker];
  if (site.kind === "call-site") walker.startCallSite(site, path);
  else if (site.kind === "call-result") walker.startCallResult(site, path);
  else if (site.kind === "parameter") walker.startParameter(site, path);
  else if (site.kind === "member") walker.startMember(site, path);
  else walkers.push(...resolverContinuation(program, repo, walker, site, path));
  return {
    uses: ordered(walkers.flatMap((held) => held.uses)),
    next: ordered(walkers.flatMap((held) => held.next)),
    frontiers: ordered(walkers.flatMap((held) => held.frontiers)),
  };
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
    if (hasMember(cls, registration.key)) {
      if (program.routes.inputBinding) {
        walker.next.push({ file: registration.at.path, pos: 0, value: { carrier: { site: memberSite(repo, owner, cls, component.name, registration.key), path }, hops } });
      } else {
        walker.frontiers.push({ file: registration.at.path, pos: 0, value: { at: registration.at, cause: "unsupported-binding", reason: "unresolved", detail: "component input binding is not enabled", hops } });
      }
    }
    const reads = new Walker(repo, program, owner);
    reads.startRouteData(component.name, registration.key, path, []);
    walkers.push(reads);
  }
  return walkers;
}

function ordered<T extends FlowUse | FlowNext | FlowFrontier>(items: readonly Held<T>[]): T[] {
  return [...items].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.pos - b.pos)).map(({ value }) => value);
}
