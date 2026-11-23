# ADR-0153: A whole-listing framework stage is kept by the contents it read

- Status: Accepted, 2026-11-23, lead under the owner's delegation
- Decision source: Owner, 2026-11-17 (translated): "I approve the decisions", over RFC-0040, whose §2 row M9 names the
  whole-listing stages after any edit ("Angular metadata and relations, TypeScript entrypoints") and whose phase 3 plans
  "per-file TypeScript and Angular splits" (unit L22); and (translated) "when the project is installed, the heavy
  indexing of everything runs in the background, so that afterwards only what changes is re-indexed and nothing is done
  on the fly", "caches with robust stale policies", "without sacrificing functionality and quality".
- Related: [RFC-0040](../rfc/0040-resident-generations-and-answer-latency.md) §2 M9, §3.2, L22;
  [RFC-0039](../rfc/0039-recorded-reads-for-the-java-project.md) (recorded reads);
  [ADR-0035](0035-derived-facts-are-retained-by-content.md), [ADR-0045](0045-one-assembly-line-for-the-snapshot-reading.md),
  [ADR-0126](0126-the-snapshot-cache-keeps-decoded-frozen-values-and-names-a-file-by-its-blob-id.md),
  [ADR-0128](0128-a-kept-derivation-verified-against-a-declaration-index-is-not-asked-again-of-an-equal-one.md),
  [ADR-0147](0147-the-snapshot-cache-floor-is-what-each-repositorys-recent-contents-used-charged-as-decoded-heap.md)

**In short:** the Angular relations (metadata, injections, template uses) and the TypeScript framework entrypoints
(route tables and the other TypeScript plugins) are kept in the derived facts of the snapshot read under the paths of
the listing, the stage's inputs and the contents the stage actually read, each recorded as a question answered by the
file's blob id. An edit of a file the stage never read (a Java source, a template no component names) reuses the kept
output; an edit of a file it read, or an added, deleted or renamed path, derives the whole stage again.

## Context

The stage outputs of the assembled reading are kept by the whole written listing (ADR-0045, `snapshotRetention`), so
any edit re-runs both stages over every source. Measured on `main` `0261d1f5e` after an edit (bench `edit-now`, Apple
M1 Max): jhipster-monolith/application `relations` ~160 ms and `entrypoints` ~48 ms per query, most of it the Angular
part (direct run: Angular relations ~180 ms, framework entrypoints ~50 ms; shopizer/admin ~310 and ~95 ms;
realworld-nx/frontend ~50 and ~22 ms).

The Angular reader is not a sum of per-file parts: a class's relations come from resolving its imports through
barrels, `tsconfig` paths and manifests into other files, and the member proofs build one checker program over the
project (`receiver-types.ts`). A CPU profile of one jhipster run splits the stage into per-file syntax walks (~45 %),
template parsing (~15 %) and resolution and merging (~40 %).

| Option | Verdict |
|---|---|
| Per-file contributions inside the Angular reader (its parsed shape per file, its template effects per text) plus the merge | Not now: the parsed shape holds maps and depends on the resolver's view of the manifests; it saves at most the per-file share, about half of the stage, and needs a serialization of the reader's raw types. Tracked below |
| Pass each stage only the files its language reads | Rejected: the readers also observe paths they do not open (the resolver's `namesNoFile` looks at every listed stem) and a `templateUrl` may name any file; the answer could change |
| Keep the stage output by the contents it read, recorded as RFC-0039 questions | Chosen: exact by construction (the stage sees the same list; every content it reads is a question), and an edit outside what it read costs nothing |

## Decision

1. **What is kept.** The output of the framework relations reader (`createRelationExtractor`'s framework half, slot
   `framework-relations`) and of the framework entrypoint plugins (`frameworkEntrypoints`, slot
   `framework-entrypoints`), through `DerivedFacts.ofReads` of the snapshot read's derived facts.
2. **The subject.** The paths of the source list in its order, and the stage's inputs: for the relations, the reader's
   language, the member-proof context, `completeSource` and the listed paths; for the entrypoints, none.
3. **The questions.** The stage reads copies of the sources whose `content` records the path the first time it is
   read; the answer is the file's blob id, or the fingerprint of its content when no listing named it (ADR-0126). A
   kept output is reused when every recorded question answers the same; answers with the same fingerprint (every
   path's identity, in order) are reused without asking (ADR-0128).
4. **Readers read lazily.** A reader of the stage reads a content only when it needs it; the Angular relations read a
   template's text only when a component names its file.
5. **Charge and tier.** Memory only (no disk version), keyed by content (the listing and the read contents), so it is
   counted in the working-set floor (ADR-0147) like any snapshot-read entry, as decoded heap after its one
   serialization round trip, deep-frozen. No size constant.
6. **Admission.** Neither stage observes the request's signal or a deadline: what it derives is complete or the
   derivation throws, and a derivation that throws is kept for nobody.

## Consequences

- After an edit of a Java source in a mixed repository, both stages answer their kept outputs; the Java half of
  `relations` and the Spring entrypoints keep their own per-file recorded reads (RFC-0039).
- Measured with the quick bench (`callers` and `outline`, `edit-now`, five calls, `main` `0261d1f5e` against this
  decision, Apple M1 Max) on jhipster-monolith/application with the edit on a Java source: `relations` 188 → 21 ms and
  `entrypoints` 86 → 36 ms per query, `callers` p50/p75 790/794 → 585/622 ms; `outline` and the unchanged cells moved
  within noise.
- An edit of a TypeScript source or a named template still derives the stage in full: no gain on a frontend-only edit.
  With the bench's default edit (a TypeScript file) the stage lines stayed within noise: jhipster `relations` 169 → 172
  ms, realworld-nx/frontend 51 → 52 ms, petclinic/frontend-angular 64 → 67 ms (the recorded reads and the serialization
  of the kept output cost 1-3 ms on a miss).
- The kept outputs are proven equal to a whole-listing run on petclinic/frontend-angular, realworld-nx/frontend,
  jhipster-monolith/application and shopizer/admin: cold, kept, and after modifying, adding, deleting and renaming
  TypeScript and Java files and editing a template (digest of the JSON output, all steps equal).
- The Angular output is held twice while the whole-listing `relations` slot of the same listing is retained.

## Not decided here

- Per-file contributions inside the Angular reader and the route reader (parsed shapes, template effects) with a
  merge, which would cut a frontend edit to its share of the stage (RFC-0040 L22 follow-up).
