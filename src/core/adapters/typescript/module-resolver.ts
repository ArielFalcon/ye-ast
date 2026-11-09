import { posix } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { isPackageManifest, isTypeScriptFile } from "../../domain/languages/typescript.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import { compareText } from "../../domain/shared/code-node.ts";

export type SourceReader = (file: string) => Promise<string | undefined>;

/**
 * `namesNoFile` when no file of the snapshot's listing could be the target under any resolution TypeScript or a build
 * might apply: no listed path is a candidate the resolution considered, nor that candidate with any extension or under
 * it as a directory.
 */
export type ModuleResolution = { file: string } | { external: true } | { unresolved: string; namesNoFile?: true };

export interface ModuleResolver {
  resolve(from: string, specifier: string): Promise<ModuleResolution>;
}

const EXTENSIONS = ["cts", "mts", "ts"] as const;
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;
/** A module extension a candidate may carry, so its stem stands for every file of that name. */
const MODULE_EXTENSION = /(\.d)?\.[cm]?[jt]sx?$|\.json$/;

/** Whether no listed path is any of these candidates, with any extension, under it as a directory, or above it as an entry the listing does not open. */
function namesNoFile(listing: ReadonlySet<string> | undefined, candidates: readonly string[]): boolean {
  if (listing === undefined) return false;
  const stems = [...new Set(candidates.flatMap((candidate) => [candidate, candidate.replace(MODULE_EXTENSION, "")]))];
  for (const path of listing) if (stems.some((stem) => path === stem || path.startsWith(`${stem}.`) || path.startsWith(`${stem}/`) || stem.startsWith(`${path}/`))) return false;
  return true;
}

/** "No inputs were found": the host lists no directory, so every configuration reports it. */
const NO_INPUTS = 18003;

/**
 * The options one configuration text declares, with its `extends` chain read through `host`; `complete` only when the
 * parse reported nothing, such as an `extends` target it could not read.
 */
function configOptions(text: string, file: string, host: ts.ParseConfigHost): { options: ts.CompilerOptions; complete: boolean } | undefined {
  const json = ts.parseConfigFileTextToJson(file, text);
  if (json.error !== undefined || json.config === undefined) return undefined;
  const parsed = ts.parseJsonConfigFileContent(json.config, host, posix.dirname(file), undefined, file);
  return { options: parsed.options, complete: parsed.errors.every(({ code }) => code === NO_INPUTS) };
}

export function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** What the snapshot's manifests say about packages: the ones they depend on, and the ones they are (`name`). */
export interface ManifestPackages {
  dependencies: ReadonlySet<string>;
  declared: ReadonlySet<string>;
}

/** The dependencies and the names of every package manifest among the files; a manifest that is not JSON says nothing. */
export function manifestPackages(files: readonly SourceFile[]): ManifestPackages {
  const manifests = files.filter((file) => isPackageManifest(file.path)).map((file) => file.content);
  return { dependencies: new Set(manifests.flatMap((manifest) => [...manifestDependencies(manifest)])), declared: new Set(manifests.flatMap((manifest) => manifestName(manifest) ?? [])) };
}

function manifestName(manifest: string): string | undefined {
  try {
    const { name } = JSON.parse(manifest) as { name?: unknown };
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The packages a manifest declares in `dependencies`, `devDependencies` and `peerDependencies`; none when it is missing or not JSON. */
export function manifestDependencies(manifest: string | undefined): Set<string> {
  if (manifest === undefined) return new Set();
  try {
    const parsed = JSON.parse(manifest) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = parsed[key];
      if (block !== null && typeof block === "object") for (const name of Object.keys(block)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Which file a module specifier names, from the file that imports it. A relative specifier is read as written, with each
 * TypeScript extension or as a directory's index; any other goes through the nearest `tsconfig` or `jsconfig` (its
 * `paths`, `baseUrl` and `extends` chain) and the TypeScript compiler's resolver. The compiler's host is synchronous and
 * the reader is not, so a resolution runs again over the files it asked for until it asks for no more; a file the
 * reader cannot give is absent. A specifier no configuration resolves is external when a manifest depends on its package
 * and no manifest of the snapshot is that package, otherwise unresolved with the reason. No program is built and no file the resolution does not ask for is read.
 */
export function createModuleResolver(read: SourceReader, packages: ManifestPackages, options?: { jsonModules?: boolean; listing?: readonly string[] }): ModuleResolver {
  const listing = options?.listing === undefined ? undefined : new Set(options.listing);
  const exists = new Map<string, Promise<boolean>>();
  const present = (file: string): Promise<boolean> => {
    let held = exists.get(file);
    if (held === undefined) {
      held = read(file).then((source) => source !== undefined);
      exists.set(file, held);
    }
    return held;
  };
  const relative = async (from: string, specifier: string): Promise<ModuleResolution> => {
    const base = posix.join(posix.dirname(from), specifier);
    if (base.startsWith("..")) return { unresolved: `${specifier} leaves the repository`, namesNoFile: true };
    const unresolved = async (): Promise<ModuleResolution> => {
      const config = await configOf(posix.dirname(from));
      const proven = config !== "unreadable" && config?.complete !== false && config?.options.rootDirs === undefined && namesNoFile(listing, [base]);
      return proven ? { unresolved: `${specifier} names no file`, namesNoFile: true } : { unresolved: `${specifier} names no file` };
    };
    if (options?.jsonModules && specifier.endsWith(".json")) {
      return await present(base) ? { file: base } : unresolved();
    }
    const tried = [base, ...EXTENSIONS.map((ext) => `${base}.${ext}`), ...EXTENSIONS.map((ext) => `${base}/index.${ext}`)];
    for (const file of tried) if (isTypeScriptFile(file) && (await present(file))) return { file };
    return unresolved();
  };

  const known = new Map<string, string | undefined>();
  const absolute = (file: string): string => `/${file}`;
  const settle = async <T>(run: (host: ts.ModuleResolutionHost & ts.ParseConfigHost) => T): Promise<T> => {
    for (;;) {
      const asked = new Set<string>();
      const lookup = (path: string): string | undefined => {
        if (!known.has(path)) asked.add(path);
        return known.get(path);
      };
      const result = run({
        fileExists: (path) => lookup(path) !== undefined,
        readFile: (path) => lookup(path),
        readDirectory: () => [],
        getCurrentDirectory: () => "/",
        useCaseSensitiveFileNames: true,
      });
      if (asked.size === 0) return result;
      await Promise.all(
        [...asked].map(async (path) => {
          const text = path.startsWith("/..") ? undefined : await read(path.slice(1));
          known.set(path, text === undefined ? undefined : path.endsWith(".json") ? text : "");
        }),
      );
    }
  };

  type Config = { file: string; options: ts.CompilerOptions; complete: boolean } | "unreadable" | undefined;
  const configs = new Map<string, Promise<Config>>();
  const configOf = (dir: string): Promise<Config> => {
    let held = configs.get(dir);
    if (held === undefined) {
      held = (async () => {
        for (const name of CONFIG_NAMES) {
          const file = dir === "." ? name : `${dir}/${name}`;
          const text = await read(file);
          if (text === undefined) continue;
          const parsed = await settle((host) => configOptions(text, absolute(file), host));
          return parsed === undefined ? "unreadable" : { file, ...parsed };
        }
        return dir === "." ? undefined : configOf(posix.dirname(dir));
      })();
      configs.set(dir, held);
    }
    return held;
  };

  /** Keyed by the importing directory: the compiler's resolution reads nothing else of the importing file. */
  const resolutions = new Map<string, Promise<{ resolved: ts.ResolvedModuleFull | undefined; probed: readonly string[] }>>();
  const aliased = async (from: string, specifier: string): Promise<ModuleResolution> => {
    const pkg = packageOf(specifier);
    /** A package the snapshot itself is never outside it: a configuration may name its file, nothing else proves one. */
    const declared = pkg !== undefined && packages.declared.has(pkg);
    const external = !declared && pkg !== undefined && packages.dependencies.has(pkg);
    const ownPackage = `${specifier} names a package this snapshot declares`;
    const found = await configOf(posix.dirname(from));
    const config = found === "unreadable" ? undefined : found;
    if (config === undefined) return external ? { external: true } : { unresolved: declared ? ownPackage : `${specifier} is not relative and no module configuration governs ${from}` };
    const compilerOptions = config.options;
    if (external && compilerOptions.paths === undefined && compilerOptions.baseUrl === undefined) return { external: true };
    const explicitJson = options?.jsonModules === true && specifier.endsWith(".json");
    const key = JSON.stringify([posix.dirname(from), specifier]);
    let held = resolutions.get(key);
    if (held === undefined) {
      held = settle((host) => {
        const probed: string[] = [];
        const fileExists = (file: string): boolean => {
          probed.push(file);
          return (!explicitJson || file.endsWith(".json")) && host.fileExists(file);
        };
        const { resolvedModule } = ts.resolveModuleName(specifier, absolute(from), { ...compilerOptions, allowJs: true, resolveJsonModule: options?.jsonModules === true, moduleResolution: compilerOptions.moduleResolution ?? ts.ModuleResolutionKind.Bundler }, { ...host, fileExists });
        return { resolved: resolvedModule, probed };
      });
      resolutions.set(key, held);
    }
    const { resolved, probed } = await held;
    if (resolved === undefined) {
      if (external) return { external: true };
      if (declared) return { unresolved: ownPackage };
      const unmatched = `${specifier} matches no \`paths\` or \`baseUrl\` entry of ${config.file}`;
      const candidates = probed.filter((file) => !file.endsWith("/package.json")).map((file) => file.slice(1));
      return config.complete && namesNoFile(listing, candidates) ? { unresolved: unmatched, namesNoFile: true } : { unresolved: unmatched };
    }
    if (resolved.isExternalLibraryImport === true) return declared ? { unresolved: ownPackage } : { external: true };
    const file = resolved.resolvedFileName.replace(/^\//, "");
    return (explicitJson ? file.endsWith(".json") : isTypeScriptFile(file)) ? { file } : { unresolved: `${specifier} resolves to ${file}, which is no TypeScript source` };
  };

  return {
    resolve(from, specifier) {
      if (specifier.startsWith("node:")) return Promise.resolve(isBuiltin(specifier) ? { external: true } : { unresolved: `${specifier} is not a Node builtin`, namesNoFile: true });
      if (specifier.startsWith(".")) return relative(from, specifier);
      if (specifier.startsWith("/")) return Promise.resolve({ unresolved: `${specifier} is an absolute path` });
      return aliased(from, specifier);
    },
  };
}

const resolvers = new WeakMap<readonly SourceFile[], Map<boolean, ModuleResolver>>();

/** The resolver of a source list, read from that list alone: every reader of the list shares its resolutions. */
export function moduleResolverOf(sources: readonly SourceFile[], options?: { jsonModules?: boolean }): ModuleResolver {
  const jsonModules = options?.jsonModules === true;
  let byOption = resolvers.get(sources);
  if (byOption === undefined) {
    byOption = new Map();
    resolvers.set(sources, byOption);
  }
  let resolver = byOption.get(jsonModules);
  if (resolver === undefined) {
    const texts = new Map(sources.map(({ path, content }) => [path, content]));
    resolver = createModuleResolver(async (file) => texts.get(file), manifestPackages(sources), { jsonModules });
    byOption.set(jsonModules, resolver);
  }
  return resolver;
}

/**
 * The resolver of a source list whose answers are kept as derived facts (ADR-0035). A resolution reads the importing
 * file, the specifier, which paths the snapshot holds and the contents of its JSON files (configurations and manifests),
 * nothing else: an edit to any other file keeps every resolution.
 */
export function rememberedModuleResolver(sources: readonly SourceFile[], facts: DerivedFacts): ModuleResolver {
  const resolver = moduleResolverOf(sources);
  let layout: string | undefined;
  const asked = new Map<string, Promise<ModuleResolution>>();
  return {
    resolve(from, specifier) {
      const key = JSON.stringify([from, specifier]);
      let held = asked.get(key);
      if (held === undefined) {
        layout ??= facts.fingerprint({
          paths: sources.map(({ path }) => path).toSorted(compareText),
          json: sources.filter(({ path }) => path.endsWith(".json")).map(({ path, content }) => [path, content]).toSorted(([a], [b]) => compareText(a!, b!)),
        });
        held = facts.ofInputs("ts-module-resolution", { layout, from, specifier }, () => resolver.resolve(from, specifier));
        asked.set(key, held);
      }
      return held;
    },
  };
}
