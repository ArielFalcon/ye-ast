import { isJavaSource, isJvmTestFile } from "../../domain/languages/java.ts";
import { isSpringConfigFile } from "../../domain/languages/spring-config.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CallSite, CallSiteReader } from "../../domain/topology/call-site.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { configurationsOf, type Configuration } from "./application-config.ts";
import { JavaEventReader } from "./event-call-sites.adapter.ts";
import { JavaHttpReader } from "./http-call-sites.adapter.ts";
import { createJavaProject, describeFile, type JavaFile, type JavaProject } from "./java-symbols.ts";

/** A reader of one kind of call site, over a project the snapshot was parsed into once. */
export type JavaSiteReader = (project: JavaProject, configuration: (file: JavaFile) => Configuration, owned: ReadonlySet<JavaFile>, repo: string) => CallSite[];

const LIBRARY_ROOT = "(library)";

const httpSites: JavaSiteReader = (project, configuration, owned, repo) => new JavaHttpReader(project, configuration, owned).sites(repo);
const eventSites: JavaSiteReader = (project, configuration, owned, repo) => new JavaEventReader(project, configuration, owned).sites(repo);

/**
 * The call sites of one repository's Java sources: each source is parsed once, and every reader walks the one project
 * and the one configuration lookup built from it. Test sources are never call sites.
 */
export function javaCallSitesOf(parser: JavaParser, files: readonly SourceFile[], libraries: readonly SourceFile[], repo: string, readers: readonly JavaSiteReader[]): CallSite[] {
  const trees: JavaSyntaxTree[] = [];
  const parse = (sources: readonly SourceFile[]): JavaFile[] =>
    sources
      .filter((source) => isJavaSource(source.path) && !isJvmTestFile(source.path))
      .flatMap((source) => {
        try {
          const result = parser.parse(source.content);
          if (!result.ok) return [];
          trees.push(result.value);
          return [describeFile(source.path, result.value.root)];
        } catch {
          return [];
        }
      });
  try {
    const owned = parse(files);
    const foreign = parse(libraries.map((source, index) => ({ ...source, path: `${LIBRARY_ROOT}/${index}/${source.path}` })));
    const project = createJavaProject([...owned, ...foreign]);
    const configuration = configurationsOf(files.filter((file) => isSpringConfigFile(file.path)));
    const held = new Set(owned);
    return readers.flatMap((read) => read(project, configuration, held, repo)).sort(compareSite);
  } finally {
    for (const tree of trees) tree.dispose();
  }
}

export function createJavaHttpCallSites(parser: JavaParser): CallSiteReader {
  return { of: async (files, repo, libraries = []) => javaCallSitesOf(parser, files, libraries, repo, [httpSites]) };
}

export function createJavaEventCallSites(parser: JavaParser): CallSiteReader {
  return { of: async (files, repo, libraries = []) => javaCallSitesOf(parser, files, libraries, repo, [eventSites]) };
}

/** Every call site a Java snapshot states: the HTTP requests it makes and the messages it publishes, in one parse. */
export function createJavaCallSites(parser: JavaParser): CallSiteReader {
  return { of: async (files, repo, libraries = []) => javaCallSitesOf(parser, files, libraries, repo, [httpSites, eventSites]) };
}

function compareSite(a: CallSite, b: CallSite): number {
  return compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol) || compareText(a.target.status, b.target.status);
}
