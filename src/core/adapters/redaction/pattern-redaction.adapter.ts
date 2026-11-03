import { REDACTED, SecretLeakError, type ByValueRedaction, type Redaction, type RedactionMode, type SecretDetection } from "../../ports/redaction.port.ts";

const CODE_KEYWORDS = new Set([
  "string", "number", "boolean", "undefined", "null", "any", "unknown", "never", "void", "object",
  "true", "false",
]);
function looksLikeCallExpression(value: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\(.*\)$/.test(value);
}
function isHighEntropyBareToken(value: string): boolean {
  const trimmed = value.replace(/[;,)]+$/, "");
  if (trimmed.length < 12) return false;
  if (CODE_KEYWORDS.has(trimmed.toLowerCase())) return false;
  if (looksLikeCallExpression(trimmed)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;
  const hasDigit = /[0-9]/.test(trimmed);
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasLower = /[a-z]/.test(trimmed);
  return hasDigit && hasUpper && hasLower;
}
/* The value is everything after the first separator: a quoted literal holds spaces, so a value read as one word would never see its quote's end. */
const ASSIGNMENT_VALUE_RE = /[\"']?\s*[:=]\s*([\s\S]+)$/;
function isModelModeSecretValue(match: string): boolean {
  const m = ASSIGNMENT_VALUE_RE.exec(match);
  const value = m?.[1] ?? "";
  if (!value) return false;
  if (/^["'`]/.test(value)) return true; /* quoted literal is the deliberate secret shape */
  return isHighEntropyBareToken(value);
}

const NAMED_SECRET_PATTERNS: Array<{ name: string; p: RegExp; skip?: (m: string, offset: number, text: string) => boolean; modelSkip?: (m: string) => boolean }> = [
  { name: "slack-webhook", p: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { name: "stripe-key", p: /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g },
  { name: "aws-access-key", p: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", p: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-token-fg", p: /\bgithub_pat_[A-Za-z0-9_]{36,}\b/g },
  { name: "llm-api-key", p: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", p: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "url-credentials", p: /(?<=:\/\/)[^\s:/@]+:[^\s:/@]+(?=@)/g },
  /* Bearer tokens in command output. Bare-value capture is greedy `\S+` so an embedded quote inside the secret is not leaked; redactPreservingTrailingQuote re-emits a trailing quote only when it is unbalanced (belongs to enclosing prose). Quoted branches are escape-aware. */
  { name: "bearer-token", p: /(?:Authorization|auth)\s*[:=]\s*Bearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi },
  { name: "jwt", p: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "private-key-pem", p: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g },
  { name: "api-key-query", p: /\b[?&](?:token|key|api_key|api-key|apiKey|secret)=[^&\s]+/gi },
  { name: "generic-credential", p: /(?:credential|auth_token|access_key)[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi },
  { name: "env-credential", p: /\b[A-Z][A-Z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|PWD|CRED|CREDENTIAL)[A-Z0-9_]*[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/g },
  { name: "api-key-assignment", p: /(?:api[_-]?key|token|secret|password|passwd|pwd)[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, modelSkip: (m) => !isModelModeSecretValue(m) },
  /* base64-encoded secrets (>40 chars), with data-URI filter. skip: a run of pure hex is a git SHA / digest, not a secret. */
  {
    /* Negative lookbehinds exclude lockfile integrity hashes (`sha512-<base64>`): their body is not a secret. skip still drops pure-hex runs (git SHAs). */
    name: "base64-secret",
    p: /(?<![A-Za-z0-9+/=])(?<!sha1-)(?<!sha256-)(?<!sha384-)(?<!sha512-)[A-Za-z0-9+/=]{40,}(?![A-Za-z0-9+/=])/g,
    skip: (m, offset, text) => /^[0-9a-f]+$/i.test(m) || isPathLikeRun(m, pathTokenAt(text, offset, m.length)),
  },
];

/* A ≥40-char [A-Za-z0-9+/=] run also matches real code: a path with `/`, a long camelCase identifier. The run stops
   at `-`, `.` or `_`, so a path is judged by the whole token around it, never by the run alone. */
const MAX_IDENTIFIER_LEN = 64;
const CASE_TRANSITION_RE = /[a-z][A-Z]/;
const WORD_SEGMENT_RE = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g;
const PATH_CHARACTER = /[A-Za-z0-9+/=._~%\\-]/;
function isIdentifierShape(m: string): boolean {
  if (m.length > MAX_IDENTIFIER_LEN) return false;
  if (/[0-9]/.test(m)) return false;
  if (!CASE_TRANSITION_RE.test(m)) return false;
  const segments = m.match(WORD_SEGMENT_RE) ?? [];
  return segments.length > 0 && segments.every((s) => s.length >= 2) && segments.some((s) => s.length >= 3);
}

/** The run of path characters a match sits in: a path continues through the `-`, `.` and `_` the pattern stops at. */
function pathTokenAt(text: string, offset: number, length: number): string {
  let start = offset;
  while (start > 0 && PATH_CHARACTER.test(text[start - 1] ?? "")) start--;
  let end = offset + length;
  while (end < text.length && PATH_CHARACTER.test(text[end] ?? "")) end++;
  return text.slice(start, end);
}

/** A segment long enough to be an encoded secret and shaped like one: both cases and a digit. */
function isBase64Segment(segment: string): boolean {
  return segment.length >= 20 && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /[0-9]/.test(segment);
}

/** Whether the match is code: a path of at least three segments (absolute or relative), or a camelCase identifier. */
function isPathLikeRun(match: string, token: string): boolean {
  if (match.includes("+") || match.includes("=")) return false;
  if (!token.includes("/")) return isIdentifierShape(match);
  if (token.length < 40) return false;
  const segments = token.split("/").filter((segment) => segment !== "");
  return segments.length >= 3 && segments.every((segment) => segment.length <= 80) && !segments.some(isBase64Segment);
}

/* Greedy `\S+` may swallow a trailing quote that is the secret's own character or that belongs to enclosing prose. If that quote already appears in the body, it is part of the secret; if not, re-emit it so surrounding markup is not corrupted. */
function redactPreservingTrailingQuote(m: string): string {
  const last = m[m.length - 1];
  if (last === '"' || last === "'") {
    const body = m.slice(0, -1);
    if (!body.includes(last)) return REDACTED + last;
  }
  return REDACTED;
}

const INTERNAL_HOST_PATTERNS: RegExp[] = [
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
];

/* PII: email only. Broader patterns (phone numbers) would wreck diffs/code with false positives; an email is distinctive enough to redact safely. */
const PII_PATTERNS: RegExp[] = [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g];

const NO_SECRETS: ByValueRedaction = (text) => ({ text, count: 0 });

/** The name the by-value pass reports under in a detection. */
const BY_VALUE_PATTERN = "run-secret";

const DATA_URI_RE = /data:[^;]+;base64,[A-Za-z0-9+/=]+/gi;

/** The caller's secrets by value first, then the named patterns, internal hosts and email. Data URIs are kept. */
export function sanitizeText(input: string, mode: RedactionMode = "issue", byValue: ByValueRedaction = NO_SECRETS): { text: string; detection: SecretDetection } {
  if (!input) return { text: input, detection: { redacted: false, patterns: [], count: 0 } };

  const valued = byValue(input);
  let out = valued.text;
  const matchedPatterns: string[] = valued.count > 0 ? [BY_VALUE_PATTERN] : [];
  let totalRedactions = valued.count;

  const dataUris: string[] = [];
  out = out.replace(DATA_URI_RE, (m) => {
    dataUris.push(m);
    return `__SANITIZER_DATAURI_${dataUris.length - 1}__`;
  });

  for (const { name, p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    let redactions = 0;
    out = out.replace(p, (m, offset: number) => {
      if (skip?.(m, offset, out)) return m;
      if (mode === "model" && modelSkip?.(m)) return m;
      redactions++;
      return redactPreservingTrailingQuote(m);
    });
    if (redactions > 0) {
      matchedPatterns.push(name);
      totalRedactions += redactions;
    }
  }

  out = out.replace(/__SANITIZER_DATAURI_(\d+)__/g, (_, i) => dataUris[Number(i)] ?? "");

  for (const p of INTERNAL_HOST_PATTERNS) out = out.replace(p, REDACTED);
  for (const p of PII_PATTERNS) out = out.replace(p, REDACTED);

  return { text: out, detection: { redacted: totalRedactions > 0, patterns: matchedPatterns, count: totalRedactions } };
}

/** True when a named pattern still finds a secret, with the same skip decisions as `sanitizeText`. */
export function containsSecrets(text: string, mode: RedactionMode = "issue"): boolean {
  if (!text) return false;
  const masked = text.replace(DATA_URI_RE, "");
  for (const { p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    p.lastIndex = 0;
    const conditional = skip !== undefined || (mode === "model" && modelSkip !== undefined);
    if (!conditional) {
      if (p.test(masked)) return true;
      continue;
    }
    for (const found of masked.matchAll(p)) {
      const m = found[0];
      if (skip?.(m, found.index ?? 0, masked)) continue;
      if (mode === "model" && modelSkip?.(m)) continue;
      return true;
    }
  }
  return false;
}

/** Throws `SecretLeakError` when a secret is still detectable in text already redacted. */
export function assertNoSecretLeak(redactedText: string, mode: RedactionMode, boundary: string): void {
  if (containsSecrets(redactedText, mode)) throw new SecretLeakError(`${boundary}: a secret survived redaction`);
}

/** The pattern policy behind the redaction port; `byValue` holds the caller's own secrets, none by default. */
export function createPatternRedaction(byValue: ByValueRedaction = NO_SECRETS): Redaction {
  const redact = (text: string, mode: RedactionMode = "issue"): string => sanitizeText(text, mode, byValue).text;
  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactValue(item)]));
  };
  return {
    redact,
    redactValue,
    detect: (text, mode = "issue") => sanitizeText(text, mode, byValue).detection,
    redactError: (error) => redact(error instanceof Error ? error.message : String(error)),
    containsSecret: (text, mode = "issue") => containsSecrets(text, mode),
  };
}
