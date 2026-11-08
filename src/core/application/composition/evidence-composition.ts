import type { Digest } from "../../ports/digest.port.ts";
import type { EvidenceComposition } from "../../ports/evidence-composition.port.ts";
import { materializeEvidence, mergeEvidence, validateCompositionIssues, validateCompositionReferences } from "./compose-evidence.ts";
import { compositionIdentity } from "./composition-identity.ts";
import { normalizeSource } from "./composition-normalize.ts";

export function createEvidenceComposition(digest: Digest): EvidenceComposition {
  return {
    normalize: (source, options) => normalizeSource(source, digest, options),
    merge: mergeEvidence,
    materialize: (set) => materializeEvidence(set, digest),
    checkReferences: validateCompositionReferences,
    checkIssues: validateCompositionIssues,
    identity: (sources) => compositionIdentity(digest, sources),
  };
}
