import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { CAPABILITY_ABSENT, type Finding } from "../../domain/shared/fact.ts";
import type { DeclaredMemberNames, DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOrigins, ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { AbsentCapability, LanguagePack, LanguageRelationsReader } from "../../ports/language-pack.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { SourceReading } from "../../domain/change/source-tokens.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";

/** The readers the families read, each sending a site, a file or a source only to the pack that owns its path (ADR-0045 decision 12). */
export interface RoutedReaders {
  memberNames: DeclaredMemberNamesReader;
  importOrigins: ImportOriginsReader;
  modules: ModuleDependenciesReader;
  relations: LanguageRelationsReader;
  sourceTokens: SourceTokens;
}

/** What a source no pack reads states: nothing. */
const NOTHING_DECLARED: DeclaredMemberNames = { names: [], functionValueCalls: [], callables: [], declarations: [], receiverBindings: [], functionValues: [] };
const UNKNOWN = { kind: "unknown" } as const;
/** What a site answers where its pack declares the stage absent: unknown, naming the absence, never "nothing there". */
const ABSENT = { kind: "unknown", reason: CAPABILITY_ABSENT } as const;
const unresolved = (site: { file: string; line: number }): Finding<ImportOrigin> => ({ status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }] });

/** One `capability-absent` answer per site where the pack declares `capability` absent; nothing where it implements it. */
function unlessAbsent(owner: LanguagePack, capability: AbsentCapability, sites: readonly unknown[]): Promise<readonly (typeof ABSENT)[]> | undefined {
  return owner.absent?.includes(capability) === true ? Promise.resolve(sites.map(() => ABSENT)) : undefined;
}

/** The stages the pack owning `path` declares absent, none where no pack reads it: the one owner of "which pack owns a path". */
export function absentCapabilitiesOf(packs: readonly Pick<LanguagePack, "profile" | "absent">[]): (path: string) => ReadonlySet<AbsentCapability> {
  const none: ReadonlySet<AbsentCapability> = new Set();
  return (path) => new Set(packs.find((pack) => pack.profile.reads(path))?.absent ?? none);
}

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

  const contextOf = (pack: LanguagePack, sources: readonly SourceFile[]): readonly SourceFile[] =>
    pack.contextFiles === undefined ? [] : sources.filter(({ path }) => ownerOf(path) === undefined && pack.contextFiles!(path));

  /** Each site answered by the pack that owns its file, in the sites' order; a site no pack owns keeps `absent`. */
  async function routed<S extends { file: string }, A>(sites: readonly S[], readers: ReadonlyMap<LanguagePack, ImportOrigins>, ask: (reader: ImportOrigins, sites: readonly S[], owner: LanguagePack) => Promise<readonly A[]>, absent: (site: S) => NoInfer<A>): Promise<A[]> {
    const results = sites.map(absent);
    const byPack = Map.groupBy(sites.flatMap((site, index) => {
      const owner = ownerOf(site.file);
      return owner === undefined ? [] : [{ owner, site, index }];
    }), ({ owner }) => owner);
    await Promise.all([...byPack].map(async ([owner, asked]) => {
      const answers = await ask(readers.get(owner)!, asked.map(({ site }) => site), owner);
      for (const [k, { index }] of asked.entries()) results[index] = answers[k]!;
    }));
    return results;
  }

  return {
    memberNames: {
      memberNames: (file, facts) => ownerOf(file.path)?.memberNames.memberNames(file, facts) ?? Promise.resolve(NOTHING_DECLARED),
    },
    sourceTokens: {
      tokensOf: (file): Promise<SourceReading> => {
        const owner = ownerOf(file.path);
        if (owner === undefined) return Promise.resolve({ status: "unread", reason: "no-language" });
        if (owner.tokens === undefined || owner.absent?.includes("tokens") === true) return Promise.resolve({ status: "unread", reason: "capability-absent" });
        return owner.tokens.tokensOf(file);
      },
    },
    relations: {
      async extract(sources, options) {
        const reads = await Promise.all(packs.filter((pack) => pack.relations !== undefined && !pack.absent?.includes("relations")).map((pack) => pack.relations!.extract(sourcesOf(pack, sources), pack.contextFiles === undefined ? options : { ...options, context: contextOf(pack, sources) })));
        return { relations: reads.flatMap((read) => read.relations), cuts: reads.flatMap((read) => read.cuts), unresolved: reads.flatMap((read) => read.unresolved) };
      },
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
    importOrigins(sources, paths, facts, hold, _context, libraries) {
      const universe = paths ?? sources.map(({ path }) => path);
      const readers = new Map(packs.map((pack) => [pack, pack.origins(sourcesOf(pack, sources), universe, facts, hold, contextOf(pack, sources), libraries)]));
      return {
        origins: (sites, signal) => routed(sites, readers, (reader, asked) => reader.origins(asked, signal), unresolved),
        rootOrigins: (sites, signal) => routed(sites, readers, (reader, asked) => reader.rootOrigins(asked, signal), unresolved),
        rootBindings: (sites, signal) => routed(sites, readers, (reader, asked) => reader.rootBindings(asked, signal), () => UNKNOWN),
        declaredTypes: (sites, signal) => routed(sites, readers, (reader, asked) => reader.declaredTypes(asked, signal), () => UNKNOWN),
        dispatchTargets: (sites, signal) => routed(sites, readers, (reader, asked, owner) => unlessAbsent(owner, "dispatchTargets", asked) ?? reader.dispatchTargets(asked, signal), () => UNKNOWN),
        receiverMethods: (sites, signal) => routed(sites, readers, (reader, asked, owner) => unlessAbsent(owner, "receiverMethods", asked) ?? reader.receiverMethods(asked, signal), () => UNKNOWN),
        implementedDeclarations: (sites, signal) => routed(sites, readers, (reader, asked) => reader.implementedDeclarations(asked, signal), () => UNKNOWN),
        replacedRoots: async (signal) => {
          const replaced = await Promise.all([...readers.values()].map((reader) => reader.replacedRoots(signal)));
          return { paths: replaced.flatMap(({ paths }) => paths).toSorted((a, b) => compareText(a.join("\u0000"), b.join("\u0000"))), globalObjects: new Set(replaced.flatMap(({ globalObjects }) => [...globalObjects])), packages: new Set(replaced.flatMap(({ packages }) => [...packages])) };
        },
      };
    },
  };
}
