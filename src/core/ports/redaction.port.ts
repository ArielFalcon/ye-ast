export const REDACTED = "[REDACTED]";

/**
 * `issue` is the aggressive policy and the default. `model` narrows the keyword assignment to a quoted literal or a
 * high-entropy bare token, so code shapes such as `password: string` survive.
 */
export type RedactionMode = "issue" | "model";

export interface SecretDetection {
  redacted: boolean;
  /** The names of the patterns that redacted something, in the order they ran. */
  patterns: string[];
  /** Redactions across all patterns. */
  count: number;
}

/**
 * Secrets the caller holds, replaced by value before the patterns run: no pattern finds a plain password. It is passed
 * by the process that holds the secrets and is never stored.
 */
export type ByValueRedaction = (text: string) => { text: string; count: number };

/** The seam every text leaving the process goes through. */
export interface Redaction {
  /** Every detected secret replaced with `REDACTED`. Deterministic. */
  redact(text: string, mode?: RedactionMode): string;
  /** Every string of a JSON value redacted, object keys included; the shape is kept. */
  redactValue(value: unknown): unknown;
  /** What `redact` finds in the text. */
  detect(text: string, mode?: RedactionMode): SecretDetection;
  /** The message of a caught value (an Error's message, otherwise its string form), redacted. */
  redactError(error: unknown): string;
  /** True when the text still holds a detectable secret. */
  containsSecret(text: string, mode?: RedactionMode): boolean;
}

/** A secret survived redaction, so the text is refused instead of sent. */
export class SecretLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretLeakError";
  }
}
