import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { ImportOrigins, ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { LanguagePack } from "../../ports/language-pack.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";

/** The readers the families read, each the merge of every pack's in the packs' order (ADR-0045 decision 12). */
export interface MergedReaders {
  memberNames: DeclaredMemberNamesReader;
  importOrigins: ImportOriginsReader;
  /** Every pack's reader of module statements, in the packs' order, for `combinedModuleReader`. */
  moduleReaders: readonly ModuleDependenciesReader[];
  sourceTrivia: SourceTrivia;
}

export function mergedReaders(packs: readonly LanguagePack[]): MergedReaders {
  return {
    memberNames: mergedMemberNames(packs.map((pack) => pack.memberNames)),
    importOrigins: (sources, paths, facts) => importOriginsByLanguage(packs.map((pack) => pack.origins(sources, paths, facts))),
    moduleReaders: packs.map((pack) => pack.modules),
    sourceTrivia: mergedTrivia(packs.map((pack) => pack.trivia)),
  };
}

/** What a source states over every reader: each list concatenated in the readers' order, the names their sorted union. */
export function mergedMemberNames(readers: readonly DeclaredMemberNamesReader[]): DeclaredMemberNamesReader {
  return {
    async memberNames(file, facts) {
      const reads = [];
      for (const reader of readers) reads.push(await reader.memberNames(file, facts));
      const calls = reads.every((read) => read.calls === undefined) ? undefined : reads.flatMap((read) => read.calls ?? []);
      return {
        names: [...new Set(reads.flatMap((read) => read.names))].sort(compareText),
        functionValueCalls: reads.flatMap((read) => read.functionValueCalls),
        callables: reads.flatMap((read) => read.callables),
        initializedFields: reads.flatMap((read) => read.initializedFields ?? []),
        receiverBindings: reads.flatMap((read) => read.receiverBindings),
        functionValues: reads.flatMap((read) => read.functionValues),
        ...(calls === undefined ? {} : { calls }),
      };
    },
  };
}

/** The trivia lines of a source: the union of every reader's, in the readers' order. */
export function mergedTrivia(readers: readonly SourceTrivia[]): SourceTrivia {
  return {
    async triviaLines(file) {
      const lines = [];
      for (const reader of readers) lines.push(...(await reader.triviaLines(file)));
      return new Set(lines);
    },
  };
}

/** One reader of module statements over readers of one language each: what every reader reads, in the readers' order. */
export function combinedModuleReader(readers: readonly ModuleDependenciesReader[]): ModuleDependenciesReader {
  return {
    async extract(sources, options): Promise<ModuleDependencies> {
      const reads = await Promise.all(readers.map((reader) => reader.extract(sources, options)));
      return {
        files: reads.flatMap((read) => read.files),
        dependencies: reads.flatMap((read) => read.dependencies),
        unread: reads.flatMap((read) => read.unread),
        untraversed: reads.flatMap((read) => read.untraversed ?? []),
      };
    },
  };
}

/**
 * One reader of the origins of names over readers that each answer only the files of their language: per site, the
 * first complete answer (the first binding that is not `unknown`) in the order given, otherwise the first reader's
 * answer; the roots a repository replaces are every reader's.
 */
export function importOriginsByLanguage(readers: readonly ImportOrigins[]): ImportOrigins {
  return {
    origins: async (sites, signal) => firstComplete(await Promise.all(readers.map((reader) => reader.origins(sites, signal)))),
    rootOrigins: async (sites, signal) => firstComplete(await Promise.all(readers.map((reader) => reader.rootOrigins(sites, signal)))),
    rootBindings: async (sites, signal) => {
      const answers = await Promise.all(readers.map((reader) => reader.rootBindings(sites, signal)));
      return sites.map((_, index) => answers.find((answer) => answer[index]?.kind !== "unknown")?.[index] ?? { kind: "unknown" });
    },
    declaredTypes: async (sites, signal) => {
      const answers = await Promise.all(readers.map((reader) => reader.declaredTypes(sites, signal)));
      return sites.map((_, index) => answers.find((answer) => answer[index]?.kind !== "unknown")?.[index] ?? { kind: "unknown" });
    },
    dispatchTargets: async (sites, signal) => {
      const answers = await Promise.all(readers.map((reader) => reader.dispatchTargets(sites, signal)));
      return sites.map((_, index) => answers.find((answer) => answer[index]?.kind !== "unknown")?.[index] ?? answers.find((answer) => { const target = answer[index]; return target?.kind === "unknown" && target.reason !== undefined; })?.[index] ?? { kind: "unknown" });
    },
    receiverMethods: async (sites, signal) => {
      const answers = await Promise.all(readers.map((reader) => reader.receiverMethods(sites, signal)));
      return sites.map((_, index) => answers.find((answer) => answer[index]?.kind !== "unknown")?.[index] ?? { kind: "unknown" });
    },
    replacedRoots: async (signal) => {
      const replaced = await Promise.all(readers.map((reader) => reader.replacedRoots(signal)));
      return { paths: replaced.flatMap(({ paths }) => paths).toSorted((a, b) => compareText(a.join("\u0000"), b.join("\u0000"))), globalObjects: new Set(replaced.flatMap(({ globalObjects }) => [...globalObjects])), packages: new Set(replaced.flatMap(({ packages }) => [...packages])) };
    },
  };
}

function firstComplete<F extends Finding<unknown>>(answers: readonly (readonly F[])[]): F[] {
  return (answers[0] ?? []).map((first, index) => answers.find((answer) => answer[index]?.status === "complete")?.[index] ?? first);
}
