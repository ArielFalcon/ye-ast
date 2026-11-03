import type { ResolvedTarget, ReferenceSite } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { TypeResolution } from "../../ports/type-resolution.port.ts";

/** The identity of a site, so the same place asked twice is answered once. */
function keyOf(site: ReferenceSite): string {
  return `${site.file}\u0000${site.line}\u0000${site.column}\u0000${site.symbol ?? ""}`;
}

function unanswered(site: ReferenceSite): Finding<ResolvedTarget> {
  return { status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] };
}

/**
 * A resolution that pays for each site once. The frontier of a snapshot does not change between queries and settling it
 * costs tens of microseconds a site, so a second query over the same bytes reaches the same answers without asking
 * again (RFC-0016, question 4). The wrapper belongs to one snapshot: a different content digest is a different
 * instance, so a cached answer can never outlive the bytes it was derived from.
 */
export function memoizeTypeResolution(inner: TypeResolution): TypeResolution {
  const cache = new Map<string, Finding<ResolvedTarget>>();
  return {
    resolve(sites) {
      const asked = new Map<string, ReferenceSite>();
      for (const site of sites) {
        const key = keyOf(site);
        if (!cache.has(key) && !asked.has(key)) asked.set(key, site);
      }
      if (asked.size > 0) {
        const pending = [...asked];
        const findings = inner.resolve(pending.map(([, site]) => site));
        pending.forEach(([key], index) => {
          const finding = findings[index];
          if (finding !== undefined) cache.set(key, finding);
        });
      }
      return sites.map((site) => cache.get(keyOf(site)) ?? unanswered(site));
    },
  };
}
