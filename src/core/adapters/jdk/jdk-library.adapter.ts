import { join } from "node:path";
import type { LibraryOutcome, LibrarySignatures, LibrarySignatureSource, LibraryType } from "../../ports/library-signatures.port.ts";
import { openJdkArchive, defaultJdkArchiveDeps, type JdkArchive, type JdkArchiveDeps } from "./jdk-archive.adapter.ts";
import { readClassFile } from "./class-file.ts";

/**
 * The library signatures of a JDK the host declares (ADR-0063): `<home>/lib/ct.sym` read as data at the JDK's own
 * feature release, named by `<home>/release`. The name index comes from the central directory alone and a type is
 * decoded when it is asked for, once per (archive digest, release), so nothing is generated, serialized or shipped.
 */
export function createJdkLibrarySource(deps: JdkArchiveDeps = defaultJdkArchiveDeps): LibrarySignatureSource {
  const tables = new Map<string, Table>();
  return {
    open({ path }) {
      const archive = openJdkArchive(join(path, "lib", "ct.sym"), deps);
      const release = readRelease(join(path, "release"), deps);
      if (archive.digest === "" || release === undefined) return UNREADABLE;
      const key = `${archive.digest}\0${release.feature}`;
      let table = tables.get(key);
      if (table === undefined) {
        table = tableOf(archive, release.feature);
        tables.set(key, table);
      }
      return table.outcome(release);
    },
  };
}

const UNREADABLE: LibraryOutcome = { kind: "unused", reason: "jdk-unreadable" };
const NOT_HELD: LibraryOutcome = { kind: "unused", reason: "release-not-held" };

/** A release set directory: `8`, `9`, then `A` for 10 and so on, concatenated where a declaration is shared. */
const RELEASE_SET = /^[0-9A-Z]+$/;
const LIBRARY_PACKAGE = "java.";
const OBJECT = "java.lang.Object";

interface JdkRelease {
  vendor?: string;
  version: string;
  feature: number;
}

interface Table {
  outcome(release: JdkRelease): LibraryOutcome;
}

function readRelease(path: string, deps: JdkArchiveDeps): JdkRelease | undefined {
  let text: string;
  try {
    const entry = deps.stat(path);
    if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) return undefined;
    text = deps.readFile(path).toString("utf8");
  } catch (error) {
    if (error instanceof Error && typeof (error as { code?: unknown }).code === "string") return undefined;
    throw error;
  }
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(?:"(.*)"|(.*))$/.exec(line);
    if (match !== null) values.set(match[1]!, match[2] ?? match[3] ?? "");
  }
  const version = values.get("JAVA_VERSION");
  const feature = version === undefined ? undefined : featureOf(version);
  if (version === undefined || feature === undefined) return undefined;
  const vendor = values.get("IMPLEMENTOR");
  return { version, feature, ...(vendor === undefined || vendor === "" ? {} : { vendor }) };
}

/** The feature release a `JAVA_VERSION` states: `1.8.0_392` is 8, `23.0.1` and `26-ea` are 23 and 26. */
function featureOf(version: string): number | undefined {
  const match = /^(\d+)(?:\.(\d+))?/.exec(version);
  if (match === null) return undefined;
  const feature = Number(match[1] === "1" && match[2] !== undefined ? match[2] : match[1]);
  return Number.isSafeInteger(feature) && feature > 0 ? feature : undefined;
}

/** The releases a set directory name covers: each character is one release. */
function releasesOf(set: string): readonly number[] {
  return [...set].map((letter) => (letter >= "A" ? 10 + letter.charCodeAt(0) - "A".charCodeAt(0) : Number(letter)));
}

/** `java.util.Map.Entry` for `<set>[/<module>]/java/util/Map$Entry.sig`; `undefined` for anything that is not a `java.*` type. */
function typeNameOf(name: string): { set: string; fqn: string } | undefined {
  if (!name.endsWith(".sig") || name.endsWith("module-info.sig")) return undefined;
  const parts = name.slice(0, -".sig".length).split("/");
  const [set, ...rest] = parts;
  if (set === undefined || !RELEASE_SET.test(set)) return undefined;
  const path = rest[0]?.includes(".") === true ? rest.slice(1) : rest;
  const fqn = path.join(".").replaceAll("$", ".");
  return fqn.startsWith(LIBRARY_PACKAGE) ? { set, fqn } : undefined;
}

interface Held {
  /** The release sets of every entry declaring one type, by the entry's name. */
  entries: { name: string; releases: ReadonlySet<number> }[];
}

function tableOf(archive: JdkArchive, feature: number): Table {
  const index = new Map<string, Held>();
  let listed = 0;
  for (const name of archive.names("")) {
    const place = typeNameOf(name);
    if (place === undefined) continue;
    listed += 1;
    const held = index.get(place.fqn) ?? { entries: [] };
    held.entries.push({ name, releases: new Set(releasesOf(place.set)) });
    index.set(place.fqn, held);
  }
  const decoded = new Map<string, LibraryType | undefined>();
  const entryOf = (fqn: string): string | undefined => {
    const covering = (index.get(fqn)?.entries ?? []).filter(({ releases }) => releases.has(feature));
    return covering.length === 1 ? covering[0]!.name : undefined;
  };
  const decode = (fqn: string): LibraryType | undefined => {
    const name = entryOf(fqn);
    if (name === undefined) return undefined;
    const entry = archive.entry(name);
    if (entry.kind !== "entry") return undefined;
    const declaration = readClassFile(entry.bytes);
    if (declaration === undefined || declaration.fqn !== fqn) return undefined;
    const { fqn: _fqn, ...type } = declaration;
    return type;
  };
  const typeOf = (fqn: string): LibraryType | undefined => {
    if (!decoded.has(fqn)) decoded.set(fqn, decode(fqn));
    return decoded.get(fqn);
  };
  return {
    outcome(release) {
      if (listed === 0) return UNREADABLE;
      if (entryOf(OBJECT) === undefined) return NOT_HELD;
      const signatures: LibrarySignatures = {
        basis: { ...(release.vendor === undefined ? {} : { vendor: release.vendor }), version: release.version, feature: release.feature, release: feature, basis: "declared-jdk", digest: archive.digest },
        typeOf,
      };
      return { kind: "used", signatures };
    },
  };
}
