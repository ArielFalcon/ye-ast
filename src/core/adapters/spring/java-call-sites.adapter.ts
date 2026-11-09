import type { LibrarySource } from "../../domain/topology/library-source.ts";
import { basename } from "node:path";
import { isJavaSource, isJvmTestFile } from "../../domain/languages/java.ts";
import { isSpringConfigFile } from "../../domain/languages/spring-config.ts";
import { compareCallSites, type CallSite, type CallSiteReader, type PlacedCallSiteReader } from "../../domain/topology/call-site.ts";
import { CALL_PLACES } from "./findings.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { withJavaSources } from "./java-project.ts";
import { configurationsOf, type Configuration } from "./application-config.ts";
import { JavaEventReader } from "./event-call-sites.adapter.ts";
import { JavaHttpReader } from "./http-call-sites.adapter.ts";
import { createJavaProject, type JavaFile, type JavaProject } from "./java-symbols.ts";
import { callSiteProofOf, type CallSiteProof } from "./java-call-site-owner.ts";

/** A reader of one kind of call site, over a project the snapshot was parsed into once. */
export interface JavaSiteReader {
  transport: CallSite["transport"];
  read(project: JavaProject, configuration: (file: JavaFile) => Configuration, owned: ReadonlySet<JavaFile>, repo: string, includeNested: boolean | undefined, proof: CallSiteProof): CallSite[];
}

const httpSites: JavaSiteReader = { transport: "http", read: (project, configuration, owned, repo, includeNested, proof) => new JavaHttpReader(project, configuration, owned, proof).sites(repo, includeNested) };
const eventSites: JavaSiteReader = { transport: "event", read: (project, configuration, owned, repo, includeNested, proof) => new JavaEventReader(project, configuration, owned, proof).sites(repo, includeNested) };

/**
 * The call sites of one repository's Java sources: each source is parsed once, and every reader walks the one project
 * and the one configuration lookup built from it. Test sources are never call sites. A source of the repository the
 * parser rejects is one site whose target is `unknown` with `source-unreadable`, at the parser's fault line and under
 * the first reader's transport: none of its calls can be read.
 */
export function javaCallSitesOf(parser: JavaParser, files: readonly SourceFile[], libraries: readonly LibrarySource[], repo: string, readers: readonly JavaSiteReader[], includeNested = false): CallSite[] {
  const readable = <T extends SourceFile>(sources: readonly T[]): T[] => sources.filter((source) => isJavaSource(source.path) && !isJvmTestFile(source.path));
  return withJavaSources(parser, (parse) => {
    const { files: owned, unparsed: unreadable } = parse(readable(files));
    const { files: foreign, unparsed: unreadableLibraries } = parse(readable(libraries));
    const project = createJavaProject([...owned, ...foreign]);
    const configuration = configurationsOf(files.filter((file) => isSpringConfigFile(file.path)));
    const held = new Set(owned);
    const transport = readers[0]?.transport;
    const unread = transport === undefined ? [] : unreadable.map((at): CallSite => ({ repo, file: at.path, line: at.line, symbol: basename(at.path, ".java"), transport, target: { status: "unknown", reason: "source-unreadable", evidence: [at] } }));
    const proof = callSiteProofOf(files, libraries, unreadable, unreadableLibraries);
    const sites = readers.flatMap((reader) => reader.read(project, configuration, held, repo, includeNested, proof));
    for (const site of sites) if (site.diagnostic?.source === "not-read" && unreadableLibraries.length > 0) {
      site.diagnostic = { ...site.diagnostic, unreadableSources: unreadableLibraries };
    }
    const ownedPaths = new Set(owned.map((file) => file.path));
    for (const site of sites) {
      const placement = CALL_PLACES.get(site);
      if (placement?.origins !== undefined) {
        const origins = placement.origins.filter((origin) => ownedPaths.has(origin.file));
        const { origins: _origins, ...place } = placement;
        CALL_PLACES.set(site, origins.length === 0 ? place : { ...place, origins });
      }
      const column = CALL_PLACES.get(site)?.column;
      if (column !== undefined) site.column = column + 1;
    }
    return [...sites, ...unread].sort(compareCallSites);
  });
}

export function createJavaHttpCallSites(parser: JavaParser): CallSiteReader {
  return { of: async (files, repo, libraries = []) => javaCallSitesOf(parser, files, libraries, repo, [httpSites]) };
}

export function createJavaEventCallSites(parser: JavaParser): CallSiteReader {
  return { of: async (files, repo, libraries = []) => javaCallSitesOf(parser, files, libraries, repo, [eventSites]) };
}

/** Every call site a Java snapshot states: the HTTP requests it makes and the messages it publishes, in one parse. */
export function createJavaCallSites(parser: JavaParser): CallSiteReader & PlacedCallSiteReader {
  return {
    of: async (files, repo, libraries = []) => javaCallSitesOf(parser, files, libraries, repo, [httpSites, eventSites]),
    placed: async (files, repo, libraries = []) => javaCallSitesOf(parser, files, libraries, repo, [httpSites, eventSites], true).map((site) => ({ site, ...CALL_PLACES.get(site) })),
  };
}
