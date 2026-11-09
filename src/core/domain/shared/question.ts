import { sharesRuntime } from "../languages/call-targets.ts";
import { factOfCuts, type CompleteFact, type Cut, type FactBase, type PartialFact } from "./fact.ts";

/** What an answer asserts, built by its family from the request (ADR-0042 decision 3). */
export type Asserted =
  /** What the asked files themselves hold: their declarations and imports. */
  | { kind: "local"; files: readonly string[] }
  /** What could import or use the asked files. */
  | { kind: "dependents"; files: readonly string[] }
  /** The whole snapshot: every cut is in question. */
  | { kind: "everything" };

export const EVERYTHING: Asserted = { kind: "everything" };

/** What it left out is unknown, so these are in question whatever the answer asserts. */
const BOUNDS: ReadonlySet<Cut["kind"]> = new Set(["depth", "hub", "caller-budget", "node-cap", "deadline", "section"]);

/** The file a `Cut.at` entry is in: a `file::declaration` anchor, a `file:line spelling` place, or a file. */
function fileOf(entry: string): string {
  const declared = entry.indexOf("::");
  if (declared !== -1) return entry.slice(0, declared);
  return /^(.*?):\d+(?: |$)/s.exec(entry)?.[1] ?? entry;
}

/**
 * Whether a cut's reach can hide something of what the answer asserts (ADR-0042 decision 4). It is out of question only
 * by positive proof: a bound, a section, a reach of anything without a runtime, a call site, or a datum the reach does not
 * state keeps it in question.
 */
export function inQuestion(cut: Cut, asserted: Asserted): boolean {
  if (asserted.kind === "everything" || BOUNDS.has(cut.kind)) return true;
  const { reach } = cut;
  if ((reach.kind === "anything" && reach.runtime === undefined) || reach.kind === "call-site") return true;
  const places = reach.kind === "module" ? [reach.importer] : cut.at.map(fileOf);
  if (asserted.kind === "local") return places.some((place) => asserted.files.includes(place));
  if (!places.some((place) => asserted.files.some((file) => sharesRuntime(place, file)))) return false;
  return reach.kind !== "module" || !reach.specifiers.every((specifier) => specifier.namesNoFile === true);
}

/** The fact of an answer: complete when no cut in its question is left, otherwise partial with those cuts alone (ADR-0042 decision 5). */
export function withCuts<T>(base: FactBase, value: T, cuts: readonly Cut[], asserted: Asserted): CompleteFact<T> | PartialFact<T> {
  return factOfCuts(base, value, cuts.filter((cut) => inQuestion(cut, asserted)));
}
