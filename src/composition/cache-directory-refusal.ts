import { lstat } from "node:fs/promises";
import { createPatternRedaction } from "../core/adapters/redaction/pattern-redaction.adapter.ts";
import { privateToOwner } from "../core/domain/shared/private-to-owner.ts";

/**
 * The line that refuses a `--cache` directory another account could have written (a symbolic link, another owner's, or
 * open to the group or others: the rule of the index cache), or `null` when it is private to the account or does not
 * exist yet. Skipped where the platform has no account ids.
 */
export async function cacheDirectoryRefusal(directory: string): Promise<string | null> {
  const ownerUid = process.getuid?.();
  const status = ownerUid === undefined ? undefined : await lstat(directory).catch(() => undefined);
  if (ownerUid === undefined || status === undefined) return null;
  const refusal = privateToOwner({ symbolicLink: status.isSymbolicLink(), uid: status.uid, mode: status.mode }, ownerUid);
  return refusal === null ? null : createPatternRedaction().redact(`ye-ast: --cache refused: ${directory} ${refusal}`);
}
