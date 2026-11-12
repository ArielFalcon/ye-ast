import type { Evidence } from "../shared/fact.ts";
import type { SummaryCause } from "./call-site-diagnostic.ts";

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
