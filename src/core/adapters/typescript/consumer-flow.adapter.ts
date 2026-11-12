import ts from "typescript";
import { lineOf, unwrapped } from "./syntax.ts";
import { isModified } from "./consumer-flow.syntax.ts";
import { siteFile, sourceUnreadable, type Carrier, type CarrierSite, type FlowFrontier, type FlowNext, type FlowResult, type FlowUse } from "../../domain/contracts/consumer-flow.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { ConsumerFlowReader } from "../../ports/consumer-flow.port.ts";
import type { Program, Unit } from "./consumer-flow.index.ts";
import { lineage, memberDeclaration, memberReceiver, methodDeclared } from "./consumer-flow.classes.ts";
import { Walker, type Held } from "./consumer-flow.walker.ts";
import type { RequestCallLookup } from "./http-call-sites.adapter.ts";

/** Builds a flow reader over a program held by the repository reading. */
export function consumerFlowReader(program: Program, repo: string, requests: RequestCallLookup): ConsumerFlowReader {
  let memberReads: ReadonlyMap<string, readonly MemberRead[]> | undefined;
  return { follow: (carrier) => follow(program, repo, requests, carrier, () => (memberReads ??= plainMemberReads(program))) };
}

interface MemberRead { unit: Unit; access: ts.PropertyAccessExpression }

function plainMemberReads(program: Program): ReadonlyMap<string, readonly MemberRead[]> {
  const members = new Map<string, MemberRead[]>();
  for (const unit of program.index.units.values()) {
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isPropertyAccessExpression(node) && !(ts.isCallExpression(node.parent) && node.parent.expression === node) && !isModified(node)) {
        const reads = members.get(node.name.text) ?? [];
        reads.push({ unit, access: node });
        members.set(node.name.text, reads);
      }
      node.forEachChild(visit);
    };
    visit(unit.tree);
  }
  return members;
}

function follow(program: Program, repo: string, requests: RequestCallLookup, { site, path }: Carrier, memberReads: () => ReadonlyMap<string, readonly MemberRead[]>): FlowResult {
  const unit = program.index.units.get(siteFile(site));
  if (unit === undefined) return sourceUnreadable(site);
  const walker = new Walker(repo, program, unit, requests);
  if (site.kind === "call-site") walker.startCallSite(site, path);
  else if (site.kind === "call-result") walker.startCallResult(site, path);
  else if (site.kind === "parameter") walker.startParameter(site, path);
  else if (site.kind === "member") walker.startMember(site, path);
  else if (site.kind === "member-read") walker.startMemberRead(site, path);
  else if (site.kind === "method-parameter") return followMethodParameter(repo, program, unit, site, path);
  else if (site.kind === "input" || site.kind === "return") return { uses: [], next: [], frontiers: [] };
  else return sourceUnreadable(site);
  const readers = new Map<Unit, Walker>();
  if (site.kind === "member") {
    for (const { unit: reader, access } of memberReads().get(site.member) ?? []) {
      const receiver = memberReceiver(program, reader, access);
      if (receiver === undefined || !lineage(program, receiver).some((held) => held.unit.file === site.file && held.cls.name?.text === site.owner)) continue;
      if (unwrapped(access.expression).kind === ts.SyntaxKind.ThisKeyword && receiver.unit.file === site.file && receiver.cls.name?.text === site.owner) continue;
      let one = readers.get(reader);
      if (one === undefined) { one = new Walker(repo, program, reader, requests); readers.set(reader, one); }
      one.startMemberAccess(access, site.owner, site.member, path);
    }
  }
  const held = [walker, ...readers.values()];
  return {
    uses: ordered(held.flatMap((reader) => reader.uses)),
    next: ordered(held.flatMap((reader) => reader.next)),
    frontiers: ordered(held.flatMap((reader) => reader.frontiers)),
  };
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

function ordered<T extends FlowUse | FlowNext | FlowFrontier>(items: readonly Held<T>[]): T[] {
  return [...items].sort((a, b) => compareText(a.file, b.file) || a.pos - b.pos).map(({ value }) => value);
}
