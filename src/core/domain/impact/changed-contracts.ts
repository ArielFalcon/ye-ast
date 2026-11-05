import type { ContractOperation } from "../contracts/contract-operation.ts";
import type { HttpMethod } from "../entrypoints/http-route.ts";
import { compareText } from "../shared/code-node.ts";
import type { Cut, Finding } from "../shared/fact.ts";

export type ContractPart = "request" | "response";

export interface ChangedContract {
  change: "added" | "removed" | "altered";
  method: HttpMethod;
  path: string;
  operationId?: string;
  /** The document that declares the operation, as the head has it; the base's for a removed one. */
  document: string;
  line: number;
  /** For an altered operation, the sides of the exchange whose data changed. */
  parts?: readonly ContractPart[];
}

export interface ContractChanges {
  changes: ChangedContract[];
  cuts: Cut[];
}

/**
 * What the change did to the operations the contracts declare, told apart by document, verb and path: one only the head
 * has is added, one only the base has is removed, and one whose request or response data differs is altered. Only an
 * operation whose document, or a file its data reaches or names, the change `touched` is reported. Where a touched file leaves the
 * data unknown (a document the reader cannot parse, a reference it cannot follow), the answer is cut there instead of
 * reading as unchanged.
 */
export function changedContracts(base: readonly Finding<ContractOperation>[], head: readonly Finding<ContractOperation>[], touched: (path: string) => boolean): ContractChanges {
  const before = operationsByIdentity(base);
  const after = operationsByIdentity(head);
  const reached = (operation: ContractOperation): boolean => [operation.document, ...operation.data.files, ...operation.data.unresolved.flatMap((reference) => reference.file ?? [])].some(touched);
  const changes: ChangedContract[] = [];
  const cuts = new Map<string, Cut>();
  const cut = (operations: readonly ContractOperation[]): void => {
    for (const found of unresolvedCuts(operations, touched)) cuts.set(found.at.join("\0"), found);
  };
  for (const [key, operation] of after) {
    const old = before.get(key);
    if (!reached(operation) && (old === undefined || !reached(old))) continue;
    cut(old === undefined ? [operation] : [old, operation]);
    if (old === undefined) {
      changes.push(changedOf("added", operation));
      continue;
    }
    const parts = (["request", "response"] as const).filter((part) => old.data[part] !== operation.data[part]);
    if (parts.length > 0) changes.push({ ...changedOf("altered", operation), parts });
  }
  for (const [key, operation] of before) {
    if (after.has(key) || !reached(operation)) continue;
    cut([operation]);
    changes.push(changedOf("removed", operation));
  }
  for (const finding of [...base, ...head]) {
    const place = finding.status === "unknown" ? finding.evidence[0] : undefined;
    if (place !== undefined && touched(place.path)) cuts.set(place.path, { kind: "no-extractor", at: [place.path] });
  }
  return { changes: changes.sort(compareChanges), cuts: [...cuts.values()].sort((a, b) => compareText(a.at.join("\0"), b.at.join("\0"))) };
}

function operationsByIdentity(findings: readonly Finding<ContractOperation>[]): Map<string, ContractOperation> {
  return new Map(findings.flatMap((finding) => (finding.status === "complete" ? [[JSON.stringify([finding.value.document, finding.value.method, finding.value.path]), finding.value] as const] : [])));
}

function unresolvedCuts(operations: readonly ContractOperation[], touched: (path: string) => boolean): Cut[] {
  return operations.flatMap((operation) =>
    operation.data.unresolved
      .filter((reference) => touched(operation.document) || (reference.file !== undefined && touched(reference.file)))
      .map((reference): Cut => ({ kind: "unresolved-link", at: [`${operation.document}:${operation.line} ${reference.ref}`] })),
  );
}

function changedOf(change: ChangedContract["change"], operation: ContractOperation): ChangedContract {
  return { change, method: operation.method, path: operation.path, ...(operation.operationId === undefined ? {} : { operationId: operation.operationId }), document: operation.document, line: operation.line };
}

function compareChanges(a: ChangedContract, b: ChangedContract): number {
  return compareText(a.document, b.document) || compareText(a.path, b.path) || compareText(a.method, b.method) || compareText(a.change, b.change);
}
