import type { Evidence } from "../shared/fact.ts";

export const CALL_SITE_CAUSES = ["source-not-read", "request-not-found", "dispatch-disagreement", "recursive", "destination-undecidable"] as const;

export interface CallSiteDiagnostic {
  cause: (typeof CALL_SITE_CAUSES)[number];
  source?: "not-read" | "read";
  /** Library files rejected by the parser; none is asserted to declare the intermediary. */
  unreadableSources?: readonly Evidence[];
  /** The values a run-time choice in the destination takes on the branches the snapshot decides; never the destination itself. */
  alternatives?: readonly string[];
}

/** Causes shared by request-value and summary uncertainty. */
export type SummaryCause = Extract<CallSiteDiagnostic["cause"], "recursive" | "dispatch-disagreement" | "destination-undecidable" | "source-not-read">;

export const SUMMARY_CAUSES: readonly SummaryCause[] = ["recursive", "dispatch-disagreement", "destination-undecidable", "source-not-read"];

