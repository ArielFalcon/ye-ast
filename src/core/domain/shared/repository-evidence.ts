import type { Evidence } from "./fact.ts";

/** Evidence in a composite, relative to the repository that owns it. */
export type RepositoryEvidence = Evidence & { repo: string };
