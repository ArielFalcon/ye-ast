import { declaredJavaReleases, isJvmBuildFile } from "../../domain/languages/jvm-build.ts";
import type { BuildOutputEvidence, DeclaredBuildOutput, UnreadOutputReason } from "../../domain/shared/build-outputs.ts";
import type { BuildOutputInput } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { LibraryOutcome, LibraryReading, LibrarySignatures, LibrarySignatureSource } from "../../ports/library-signatures.port.ts";

export type { LibraryReading };

export interface LibrariesRead {
  libraries: LibraryReading;
  /** One input per declared JDK that was used, unverified: a JDK has no lockfile analogue (ADR-0063 decision 7). */
  outputs: readonly BuildOutputInput[];
  /** Why each declared JDK that was not used was not, one entry per reason. */
  evidence: readonly BuildOutputEvidence[];
}

const NONE: LibraryReading = { of: () => undefined };

function isUnder(at: string, path: string): boolean {
  return at === "" || path === at || path.startsWith(`${at}/`);
}

/**
 * Opens each declared JDK against the snapshot's build files: a JDK older than a release a build file under its `at`
 * states as a literal is unusable (ADR-0063 decision 4), since the table would lack real candidates.
 */
export function readLibraries(declared: readonly DeclaredBuildOutput[], files: readonly SourceFile[], source: LibrarySignatureSource): LibrariesRead {
  const jdks = declared.filter(({ kind }) => kind === "jdk");
  if (jdks.length === 0) return { libraries: NONE, outputs: [], evidence: [] };
  const used: { at: string; signatures: LibrarySignatures }[] = [];
  const outputs: BuildOutputInput[] = [];
  const unused = new Map<UnreadOutputReason, DeclaredBuildOutput[]>();
  for (const output of jdks) {
    const verdict = verdictOf(source.open(output), output.at, files);
    if ("reason" in verdict) {
      unused.set(verdict.reason, [...(unused.get(verdict.reason) ?? []), output]);
      continue;
    }
    const { digest, vendor, version, feature, basis } = verdict.signatures.basis;
    used.push({ at: output.at, signatures: verdict.signatures });
    outputs.push({ kind: "jdk", at: output.at, verified: false, digest, jdk: { ...(vendor === undefined ? {} : { vendor }), version, feature, basis } });
  }
  const libraries: LibraryReading = {
    of: (path) => used.filter(({ at }) => isUnder(at, path)).sort((a, b) => b.at.length - a.at.length)[0]?.signatures,
  };
  return { libraries, outputs, evidence: [...unused].map(([reason, outputs]) => ({ used: false, outputs, reason })) };
}

function verdictOf(outcome: LibraryOutcome, at: string, files: readonly SourceFile[]): { signatures: LibrarySignatures } | { reason: UnreadOutputReason } {
  if (outcome.kind === "unused") return { reason: outcome.reason };
  return statesNewerRelease(at, outcome.signatures.basis.feature, files) ? { reason: "jdk-older-than-build" } : { signatures: outcome.signatures };
}

function statesNewerRelease(at: string, feature: number, files: readonly SourceFile[]): boolean {
  return files.some((file) => isJvmBuildFile(file.path) && isUnder(at, file.path) && declaredJavaReleases(file.path, file.content).some((release) => release > feature));
}
