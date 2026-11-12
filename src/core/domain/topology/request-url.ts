import type { Evidence } from "../shared/fact.ts";
import type { SummaryCause } from "./call-site-diagnostic.ts";
import { callUrl, RUN_TIME_HOLE } from "./path-template.ts";

/** Ordered URL-expression knowledge; text after an unknown value is not necessarily a route path. */
export type RequestUrlPart =
  | { kind: "text"; text: string }
  | { kind: "runtime"; encoded?: true }
  | { kind: "unknown"; cause: SummaryCause; evidence: readonly Evidence[] };

export function compactRequestUrl(parts: readonly RequestUrlPart[]): RequestUrlPart[] {
  const found: RequestUrlPart[] = [];
  for (const part of parts) {
    if (part.kind === "text" && part.text === "") continue;
    const previous = found.at(-1);
    if (part.kind === "text" && previous?.kind === "text") found[found.length - 1] = { kind: "text", text: previous.text + part.text };
    else found.push(part);
  }
  return found;
}

/**
 * The path a URL states after a base it does not decide: the base is its only undecided value, and the text after it
 * starts a path segment, read as every call URL is (without its query or fragment). Run-time values are holes; any
 * other shape states no route.
 */
export function routeAfterUndecidedBase(parts: readonly RequestUrlPart[]): string | undefined {
  const [base, first, ...rest] = compactRequestUrl(parts);
  if (base?.kind !== "unknown" || first?.kind !== "text" || !first.text.startsWith("/") || first.text.startsWith("//")) return undefined;
  if (rest.some((part) => part.kind === "unknown")) return undefined;
  return callUrl([first, ...rest].map((part) => (part.kind === "text" ? part.text : RUN_TIME_HOLE)).join("")).path;
}
