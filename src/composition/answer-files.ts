import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createAnswerFiles } from "../core/adapters/fs/answer-files.adapter.ts";
import { SUPPORTED_STORE } from "../core/adapters/codegraph/store-version.ts";
import { createPatternRedaction } from "../core/adapters/redaction/pattern-redaction.adapter.ts";
import { SCHEMA } from "../core/domain/shared/fact.ts";
import type { AnswerFiles, AnswerRetentionPolicy } from "../core/ports/answer-files.port.ts";
import { INDEX_RETENTION, LIVE_STAGING_VERSION } from "./compose.ts";
import { ownVersion } from "./installed-versions.ts";

/** What a host keeps of the answer folders unless it overrides it (ADR-0110): the index cache's bound of unused time and of logical bytes, as a budget of its own. */
export const ANSWER_RETENTION: AnswerRetentionPolicy = { ...INDEX_RETENTION };

/** The answer files of the cache directory `directory`; each diagnostic line is redacted before `report` receives it. */
export function composeAnswerFiles(options: { directory: string; report: (line: string) => void; retention?: AnswerRetentionPolicy }): AnswerFiles {
  const redaction = createPatternRedaction();
  return createAnswerFiles({
    directory: options.directory,
    digest: createSha256Digest(),
    engine: [ownVersion(), SCHEMA, LIVE_STAGING_VERSION, JSON.stringify(SUPPORTED_STORE)].join("|"),
    retention: options.retention ?? ANSWER_RETENTION,
    report: (line) => options.report(redaction.redact(line)),
  });
}
