import { posix } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { isPackageManifest, isTypeScriptFile } from "../../domain/languages/typescript.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

export type SourceReader = (file: string) => Promise<string | undefined>;

export type ModuleResolution = { file: string } | { external: true } | { unresolved: string };

export interface ModuleResolver {
  resolve(from: string, specifier: string): Promise<ModuleResolution>;
}

const EXTENSIONS = ["cts", "mts", "ts"] as const;
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;

/**
 * The options one configuration text declares, with its `extends` chain read through `host`.
 */
export function configOptions(text: string, file: string, host: ts.ParseConfigHost): ts.CompilerOptions | undefined {
  const json = ts.parseConfigFileTextToJson(file, text);
  if (json.error !== undefined || json.config === undefined) return undefined;
  return ts.parseJsonConfigFileContent(json.config, host, posix.dirname(file), undefined, file).options;
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
export function createModuleResolver(read: SourceReader, packages: ManifestPackages, options?: { jsonModules?: boolean }): ModuleResolver {
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
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (base.startsWith("..")) return { unresolved: `${specifier} leaves the repository` };
    if (options?.jsonModules && specifier.endsWith(".json")) {
      return await present(base) ? { file: base } : { unresolved: `${specifier} names no file` };
    }
    const tried = [base, ...EXTENSIONS.map((ext) => `${base}.${ext}`), ...EXTENSIONS.map((ext) => `${base}/index.${ext}`)];
    for (const file of tried) if (isTypeScriptFile(file) && (await present(file))) return { file };
    return { unresolved: `${specifier} names no file` };
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

  const configs = new Map<string, Promise<{ file: string; options: ts.CompilerOptions } | undefined>>();
  const configOf = (dir: string): Promise<{ file: string; options: ts.CompilerOptions } | undefined> => {
    let held = configs.get(dir);
    if (held === undefined) {
      held = (async () => {
        for (const name of CONFIG_NAMES) {
          const file = dir === "." ? name : `${dir}/${name}`;
          const text = await read(file);
          if (text === undefined) continue;
          const options = await settle((host) => configOptions(text, absolute(file), host));
          if (options === undefined) return undefined;
          return { file, options };
        }
        return dir === "." ? undefined : configOf(posix.dirname(dir));
      })();
      configs.set(dir, held);
    }
    return held;
  };

  /** Keyed by the importing directory: the compiler's resolution reads nothing else of the importing file. */
  const resolutions = new Map<string, Promise<ts.ResolvedModuleFull | undefined>>();
  const aliased = async (from: string, specifier: string): Promise<ModuleResolution> => {
    const pkg = packageOf(specifier);
    /** A package the snapshot itself is never outside it: a configuration may name its file, nothing else proves one. */
    const declared = pkg !== undefined && packages.declared.has(pkg);
    const external = !declared && pkg !== undefined && packages.dependencies.has(pkg);
    const ownPackage = `${specifier} names a package this snapshot declares`;
    const config = await configOf(posix.dirname(from));
    if (config === undefined) return external ? { external: true } : { unresolved: declared ? ownPackage : `${specifier} is not relative and no module configuration governs ${from}` };
    const compilerOptions = config.options;
    if (external && compilerOptions.paths === undefined && compilerOptions.baseUrl === undefined) return { external: true };
    const explicitJson = options?.jsonModules === true && specifier.endsWith(".json");
    const key = JSON.stringify([posix.dirname(from), specifier]);
    let held = resolutions.get(key);
    if (held === undefined) {
      held = settle((host) =>
        ts.resolveModuleName(specifier, absolute(from), { ...compilerOptions, allowJs: true, resolveJsonModule: options?.jsonModules === true, moduleResolution: compilerOptions.moduleResolution ?? ts.ModuleResolutionKind.Bundler }, explicitJson ? { ...host, fileExists: (file) => file.endsWith(".json") && host.fileExists(file) } : host).resolvedModule,
      );
      resolutions.set(key, held);
    }
    const resolved = await held;
    if (resolved === undefined) return external ? { external: true } : { unresolved: declared ? ownPackage : `${specifier} matches no \`paths\` or \`baseUrl\` entry of ${config.file}` };
    if (resolved.isExternalLibraryImport === true) return declared ? { unresolved: ownPackage } : { external: true };
    const file = resolved.resolvedFileName.replace(/^\//, "");
    return (explicitJson ? file.endsWith(".json") : isTypeScriptFile(file)) ? { file } : { unresolved: `${specifier} resolves to ${file}, which is no TypeScript source` };
  };

  return {
    resolve(from, specifier) {
      if (specifier.startsWith("node:")) return Promise.resolve(isBuiltin(specifier) ? { external: true } : { unresolved: `${specifier} is not a Node builtin` });
      if (specifier.startsWith(".")) return relative(from, specifier);
      if (specifier.startsWith("/")) return Promise.resolve({ unresolved: `${specifier} is an absolute path` });
      return aliased(from, specifier);
    },
  };
}
