import { posix } from "node:path";
import ts from "typescript";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";

export type SourceReader = (file: string) => Promise<string | undefined>;

export type ModuleResolution = { file: string } | { external: true } | { unresolved: string };

export interface ModuleResolver {
  resolve(from: string, specifier: string): Promise<ModuleResolution>;
}

const EXTENSIONS = ["cts", "mts", "ts"] as const;
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;

export function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
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
 * reader cannot give is absent. A specifier no configuration resolves is external when the manifest names its package,
 * otherwise unresolved with the reason. No program is built and no file the resolution does not ask for is read.
 */
export function createModuleResolver(read: SourceReader, dependencies: ReadonlySet<string>): ModuleResolver {
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
    const tried = [base, ...EXTENSIONS.map((ext) => `${base}.${ext}`), ...EXTENSIONS.map((ext) => `${base}/index.${ext}`)];
    for (const file of tried) if (isTypeScriptSource(file) && (await present(file))) return { file };
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
          const json = ts.parseConfigFileTextToJson(absolute(file), text);
          if (json.error !== undefined || json.config === undefined) return undefined;
          const options = await settle((host) => ts.parseJsonConfigFileContent(json.config, host, absolute(dir === "." ? "" : dir) || "/", undefined, absolute(file)).options);
          return { file, options };
        }
        return dir === "." ? undefined : configOf(posix.dirname(dir));
      })();
      configs.set(dir, held);
    }
    return held;
  };

  const aliased = async (from: string, specifier: string): Promise<ModuleResolution> => {
    const pkg = packageOf(specifier);
    const external = pkg !== undefined && dependencies.has(pkg);
    const config = await configOf(posix.dirname(from));
    if (config === undefined) return external ? { external: true } : { unresolved: `${specifier} is not relative and no module configuration governs ${from}` };
    const { options } = config;
    if (external && options.paths === undefined && options.baseUrl === undefined) return { external: true };
    const resolved = await settle((host) =>
      ts.resolveModuleName(specifier, absolute(from), { ...options, allowJs: true, moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.Bundler }, host).resolvedModule,
    );
    if (resolved === undefined) return external ? { external: true } : { unresolved: `${specifier} matches no \`paths\` or \`baseUrl\` entry of ${config.file}` };
    if (resolved.isExternalLibraryImport === true) return { external: true };
    const file = resolved.resolvedFileName.replace(/^\//, "");
    return isTypeScriptSource(file) ? { file } : { unresolved: `${specifier} resolves to ${file}, which is no TypeScript source` };
  };

  return {
    resolve: (from, specifier) => (specifier.startsWith(".") ? relative(from, specifier) : specifier.startsWith("/") ? Promise.resolve({ unresolved: `${specifier} is an absolute path` }) : aliased(from, specifier)),
  };
}
