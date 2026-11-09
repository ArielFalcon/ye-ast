import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { DeclaredMemberNames, DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { LanguagePack } from "../../ports/language-pack.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";

/** The readers the families read, each sending a site, a file or a source only to the pack that owns its path (ADR-0045 decision 12). */
export interface RoutedReaders {
  memberNames: DeclaredMemberNamesReader;
  importOrigins: ImportOriginsReader;
  modules: ModuleDependenciesReader;
  sourceTrivia: SourceTrivia;
}

/** What a source no pack reads states: nothing. */
const NOTHING_DECLARED: DeclaredMemberNames = { names: [], functionValueCalls: [], callables: [], receiverBindings: [], functionValues: [] };
const UNKNOWN = { kind: "unknown" } as const;
const unresolved = (site: { file: string; line: number }): Finding<ImportOrigin> => ({ status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] });

export function routedReaders(packs: readonly LanguagePack[]): RoutedReaders {
  const ownerOf = (path: string): LanguagePack | undefined => packs.find((pack) => pack.profile.reads(path));
  const routedLists = new WeakMap<readonly SourceFile[], ReadonlyMap<LanguagePack, readonly SourceFile[]>>();
  /**
   * A pack's sources: those it owns, and those no pack owns where it reads the project's files. One list of sources gives
   * each pack one list, so a reader that keeps what it read of a list by its identity reads it once.
   */
  const sourcesOf = (pack: LanguagePack, sources: readonly SourceFile[]): readonly SourceFile[] => {
    let lists = routedLists.get(sources);
    if (lists === undefined) {
      const owners = sources.map(({ path }) => ownerOf(path));
      lists = new Map(packs.map((candidate) => [candidate, sources.filter((_, index) => owners[index] === candidate || (owners[index] === undefined && candidate.readsProjectFiles === true))]));
      routedLists.set(sources, lists);
    }
    return lists.get(pack)!;
  };

  /** Each site answered by the pack that owns its file, in the sites' order; a site no pack owns keeps `absent`. */
  async function routed<S extends { file: string }, A>(sites: readonly S[], readers: ReadonlyMap<LanguagePack, ImportOrigins>, ask: (reader: ImportOrigins, sites: readonly S[]) => Promise<readonly A[]>, absent: (site: S) => NoInfer<A>): Promise<A[]> {
    const results = sites.map(absent);
    const byPack = Map.groupBy(sites.flatMap((site, index) => {
      const owner = ownerOf(site.file);
      return owner === undefined ? [] : [{ owner, site, index }];
    }), ({ owner }) => owner);
    await Promise.all([...byPack].map(async ([owner, asked]) => {
      const answers = await ask(readers.get(owner)!, asked.map(({ site }) => site));
      for (const [k, { index }] of asked.entries()) results[index] = answers[k]!;
    }));
    return results;
  }

  return {
    memberNames: {
      memberNames: (file, facts) => ownerOf(file.path)?.memberNames.memberNames(file, facts) ?? Promise.resolve(NOTHING_DECLARED),
    },
    sourceTrivia: {
      triviaLines: (file) => ownerOf(file.path)?.trivia.triviaLines(file) ?? Promise.resolve(new Set()),
    },
    modules: {
      async extract(sources, options): Promise<ModuleDependencies> {
        const reads = await Promise.all(packs.map((pack) => pack.modules.extract(sourcesOf(pack, sources), options)));
        return {
          files: reads.flatMap((read) => read.files),
          dependencies: reads.flatMap((read) => read.dependencies),
          unread: reads.flatMap((read) => read.unread),
          untraversed: reads.flatMap((read) => read.untraversed ?? []),
        };
      },
    },
    importOrigins(sources, paths, facts) {
      const universe = paths ?? sources.map(({ path }) => path);
      const readers = new Map(packs.map((pack) => [pack, pack.origins(sourcesOf(pack, sources), universe, facts)]));
      return {
        origins: (sites, signal) => routed(sites, readers, (reader, asked) => reader.origins(asked, signal), unresolved),
        rootOrigins: (sites, signal) => routed(sites, readers, (reader, asked) => reader.rootOrigins(asked, signal), unresolved),
        rootBindings: (sites, signal) => routed(sites, readers, (reader, asked) => reader.rootBindings(asked, signal), () => UNKNOWN),
        declaredTypes: (sites, signal) => routed(sites, readers, (reader, asked) => reader.declaredTypes(asked, signal), () => UNKNOWN),
        dispatchTargets: (sites, signal) => routed(sites, readers, (reader, asked) => reader.dispatchTargets(asked, signal), () => UNKNOWN),
        receiverMethods: (sites, signal) => routed(sites, readers, (reader, asked) => reader.receiverMethods(asked, signal), () => UNKNOWN),
        replacedRoots: async (signal) => {
          const replaced = await Promise.all([...readers.values()].map((reader) => reader.replacedRoots(signal)));
          return { paths: replaced.flatMap(({ paths }) => paths).toSorted((a, b) => compareText(a.join("\u0000"), b.join("\u0000"))), globalObjects: new Set(replaced.flatMap(({ globalObjects }) => [...globalObjects])), packages: new Set(replaced.flatMap(({ packages }) => [...packages])) };
        },
      };
    },
  };
}
