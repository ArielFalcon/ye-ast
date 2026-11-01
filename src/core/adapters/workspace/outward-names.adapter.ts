import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { isSpringConfigFile } from "../../domain/languages/spring-config.ts";
import { gatherNames, type OutwardName } from "../../domain/topology/outward-name.ts";
import type { WorkspaceEvidence } from "../../ports/workspace-evidence.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

const ABSOLUTE_URL = /^https?:\/\/[^/\s]+/i;
const SPRING_URL_KEY = /(^|\.)url$/;
const PROPERTIES_URL = /^\s*[^#!\s][^=]*url\s*=\s*(\S+)\s*$/;
const DEPENDENCY = /<dependency>([\s\S]*?)<\/dependency>/g;
const REPOSITORY = /<repository>([\s\S]*?)<\/repository>/g;
const TAG = /<([a-zA-Z]+)\s*>([^<]*)<\/\1>/g;
const PARENT = /<parent>[\s\S]*?<\/parent>/;

export function createWorkspaceEvidence(): WorkspaceEvidence {
  return { names: (files) => gatherNames(files.flatMap(namesOf)), artifacts: (files) => [...new Set(files.flatMap(artifactsOf))].sort() };
}

function namesOf(file: SourceFile): OutwardName[] {
  return [...configurationNames(file), ...dependencyNames(file), ...registryNames(file)];
}

/** Every key whose name ends in `url` and whose value is an absolute URL, in a Spring configuration file of the commit. */
function configurationNames(file: SourceFile): OutwardName[] {
  if (isSpringConfigFile(file.path)) {
    if (/\.properties$/.test(file.path)) return propertyUrls(file);
    return yamlUrls(file);
  }
  return [];
}

function yamlUrls(file: SourceFile): OutwardName[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(file.content, { lineCounter });
  if (document.errors.length > 0) return [];
  const found: { path: string; value: string; range: readonly [number, number, number] | undefined }[] = [];
  collectScalars(document.contents, [], found);
  return found
    .filter((scalar) => SPRING_URL_KEY.test(scalar.path) && typeof scalar.value === "string" && ABSOLUTE_URL.test(scalar.value))
    .map((scalar) => ({ name: scalar.value, kind: "configuration-url", evidence: [{ path: file.path, line: linePosition(lineCounter, scalar.range) }] }));
}

function collectScalars(node: unknown, path: readonly string[], found: { path: string; value: unknown; range: readonly [number, number, number] | undefined }[]): void {
  if (isMap(node)) {
    for (const pair of node.items) collectScalars(pair.value, [...path, String(isScalar(pair.key) ? pair.key.value : "")], found);
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => collectScalars(item, [...path, String(index)], found));
  } else if (isScalar(node)) {
    found.push({ path: path.join("."), value: node.value, range: node.range ?? undefined });
  }
}

function propertyUrls(file: SourceFile): OutwardName[] {
  return file.content.split("\n").flatMap((line, index) => {
    const match = PROPERTIES_URL.exec(line);
    return match === null || !ABSOLUTE_URL.test(match[1] ?? "") ? [] : [{ name: match[1] ?? "", kind: "configuration-url" as const, evidence: [{ path: file.path, line: index + 1 }] }];
  });
}

/** The coordinates a Maven or npm manifest depends on, at the line each is declared. */
function dependencyNames(file: SourceFile): OutwardName[] {
  if (/^package\.json$/.test(baseName(file.path))) return packageDependencies(file);
  if (!/(^|\/)pom\.xml$/.test(file.path)) return [];
  return [...file.content.matchAll(DEPENDENCY)].flatMap((match) => {
    const tags = tagsOf(match[1] ?? "");
    const artifactId = tags.get("artifactId");
    if (artifactId === undefined) return [];
    const groupId = tags.get("groupId");
    return [{ name: groupId === undefined ? artifactId : `${groupId}:${artifactId}`, kind: "dependency" as const, evidence: [{ path: file.path, line: lineOfOffset(file.content, match.index) }] }];
  });
}

function packageDependencies(file: SourceFile): OutwardName[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(file.content, { lineCounter });
  if (document.errors.length > 0) return [];
  const dependencies = document.getIn(["dependencies"]);
  if (!isMap(dependencies)) return [];
  return dependencies.items.flatMap((pair) => {
    const name = isScalar(pair.key) ? String(pair.key.value) : "";
    const range = isScalar(pair.key) ? pair.key.range : undefined;
    return name === "" ? [] : [{ name, kind: "dependency" as const, evidence: [{ path: file.path, line: linePosition(lineCounter, range ?? undefined) }] }];
  });
}

/** The registries a Maven build declares, by the host each repository URL names. */
function registryNames(file: SourceFile): OutwardName[] {
  if (!/(^|\/)pom\.xml$/.test(file.path)) return [];
  return [...file.content.matchAll(REPOSITORY)].flatMap((match) => {
    const url = tagsOf(match[1] ?? "").get("url");
    const host = url === undefined ? undefined : ABSOLUTE_URL.exec(url)?.[0];
    return host === undefined ? [] : [{ name: host, kind: "registry" as const, evidence: [{ path: file.path, line: lineOfOffset(file.content, match.index) }] }];
  });
}

function artifactsOf(file: SourceFile): string[] {
  if (/^package\.json$/.test(baseName(file.path))) {
    const name = parseDocument(file.content).get("name");
    return typeof name === "string" ? [name] : [];
  }
  if (!/(^|\/)pom\.xml$/.test(file.path)) return [];
  const own = tagsOf(file.content.replace(PARENT, ""));
  const artifactId = own.get("artifactId");
  if (artifactId === undefined) return [];
  const groupId = own.get("groupId");
  return [groupId === undefined ? artifactId : `${groupId}:${artifactId}`];
}

function tagsOf(body: string): Map<string, string> {
  return new Map([...body.matchAll(TAG)].map((match) => [match[1] ?? "", (match[2] ?? "").trim()]));
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function linePosition(lineCounter: LineCounter, range: readonly [number, number, number] | undefined): number {
  return range === undefined ? 1 : lineCounter.linePos(range[0]).line;
}

function lineOfOffset(content: string, index: number | undefined): number {
  if (index === undefined) return 1;
  let line = 1;
  for (let at = content.indexOf("\n"); at !== -1 && at < index; at = content.indexOf("\n", at + 1)) line++;
  return line;
}
