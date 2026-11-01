import type { CodeGraphFault } from "../../ports/code-graph.port.ts";

/** The versions of codegraph's store this adapter's queries are written against; a codegraph upgrade changes them. */
export const SUPPORTED_STORE = { schema: { min: 11, max: 11 }, extraction: { min: 27, max: 27 } } as const;

type Sdk = typeof import("@colbymchenry/codegraph");

export interface StoredVersions {
  schema: number | null;
  extraction: number | null;
  indexState: string | null;
}

const COMPLETE_INDEX = "complete";

/**
 * The raw-SQL remainder (RFC-0003): the SDK exports neither the schema version nor the extraction stamp. The store is
 * opened read-only, so nothing migrates it.
 */
export function readStoredVersions(sdk: Sdk, root: string): StoredVersions {
  const connection = sdk.DatabaseConnection.open(sdk.getDatabasePath(root), { readOnly: true });
  try {
    const db = connection.getDb();
    const schema = db.prepare("SELECT MAX(version) AS version FROM schema_versions").get() as { version: number | null } | undefined;
    const metadata = (key: string) => (db.prepare("SELECT value FROM project_metadata WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
    const extraction = metadata("indexed_with_extraction_version");
    const parsed = extraction === null ? Number.NaN : Number.parseInt(extraction, 10);
    return { schema: schema?.version ?? null, extraction: Number.isFinite(parsed) ? parsed : null, indexState: metadata("index_state") };
  } finally {
    connection.close();
  }
}

export function unsupportedVersions(stored: StoredVersions, codegraph: string | null): CodeGraphFault | null {
  const { schema, extraction, indexState } = stored;
  const problems: string[] = [];
  if (codegraph === null) problems.push("the index carries no codegraph version stamp");
  if (indexState !== COMPLETE_INDEX) problems.push(`the index state is ${indexState ?? "unknown"}, not ${COMPLETE_INDEX}`);
  if (schema === null || schema < SUPPORTED_STORE.schema.min || schema > SUPPORTED_STORE.schema.max) {
    problems.push(`schema ${schema ?? "unknown"} is outside ${SUPPORTED_STORE.schema.min}-${SUPPORTED_STORE.schema.max}`);
  }
  if (extraction === null || extraction < SUPPORTED_STORE.extraction.min || extraction > SUPPORTED_STORE.extraction.max) {
    problems.push(`extraction ${extraction ?? "unknown"} is outside ${SUPPORTED_STORE.extraction.min}-${SUPPORTED_STORE.extraction.max}`);
  }
  return problems.length === 0 ? null : { kind: "unsupported-store", detail: problems.join("; ") };
}
