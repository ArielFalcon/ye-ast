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

/* A keyword inside a lowercase word of a dotted group followed by `:artifact:version` is a dependency coordinate (`io.jsonwebtoken:jjwt-api:0.11.5`), not an assignment. The exemption sits in the pattern, not in a skip, so a keyword later in the same token is still found. A name that starts at the keyword (`db.password=`), a camelCase word (`app.clientSecret:`), any other separator, a value that is not a lowercase artifact followed by `:` (`app.authtoken:S3cret`), and a quoted or spaced value keep the rule. */
const CREDENTIAL_KEYWORD = "(?:api[_-]?key|token|secret|password|passwd|pwd)";
const DOTTED_COORDINATE = `(?=(?-i:(?=[a-z]))${CREDENTIAL_KEYWORD}(?-i::[a-z0-9][a-z0-9._-]*:[\\w.-]))(?<=\\.[\\w-]*[a-z0-9])`;
const API_KEY_ASSIGNMENT = new RegExp(`(?!${DOTTED_COORDINATE})${CREDENTIAL_KEYWORD}[\\"']?\\s*[:=]\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\S+)`, "gi");

const PRIVATE_KEY_END = /-----END [A-Z ]+PRIVATE KEY-----/y;
const PRIVATE_KEY_END_PREFIX = "-----END ";

/** The length of the text up to the last private key end: a header after it has no end to reach, and its lazy body would reread the rest of the text from every such header. The end is searched backwards because two ends may share their dashes. */
function lengthToLastPrivateKeyEnd(text: string): number {
  for (let at = text.lastIndexOf(PRIVATE_KEY_END_PREFIX); at !== -1; at = at === 0 ? -1 : text.lastIndexOf(PRIVATE_KEY_END_PREFIX, at - 1)) {
    PRIVATE_KEY_END.lastIndex = at;
    const end = PRIVATE_KEY_END.exec(text);
    if (end) return at + end[0].length;
  }
  return 0;
}

/* Each pattern reads a run once: a start that cannot match fails at once (a gate before the keyword, a lookbehind that leaves a run to its first start), never after rereading the run from every start. `readsPrefix` is the length of the text a pattern can match in. */
const NAMED_SECRET_PATTERNS: Array<{ name: string; p: RegExp; readsPrefix?: (text: string) => number; skipIn?: (text: string) => (m: string, offset: number) => boolean; modelSkip?: (m: string) => boolean }> = [
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
  { name: "jwt", p: /(?<!eyJ[A-Za-z0-9_-]*?)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "private-key-pem", p: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, readsPrefix: lengthToLastPrivateKeyEnd },
  { name: "api-key-query", p: /\b[?&](?:token|key|api_key|api-key|apiKey|secret)=[^&\s]+/gi },
  { name: "generic-credential", p: /(?:credential|auth_token|access_key)[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi },
  { name: "env-credential", p: /\b(?=[A-Z][A-Z0-9_]*[\"']?\s*[:=])[A-Z][A-Z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|PWD|CRED|CREDENTIAL)[A-Z0-9_]*[\"']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/g },
  { name: "api-key-assignment", p: API_KEY_ASSIGNMENT, modelSkip: (m) => !isModelModeSecretValue(m) },
  /* base64-encoded secrets (>40 chars), with data-URI filter. skipIn: a run of pure hex is a git SHA / digest, not a secret. */
  {
    /* Negative lookbehinds exclude lockfile integrity hashes (`sha512-<base64>`): their body is not a secret. skipIn still drops pure-hex runs (git SHAs). */
    name: "base64-secret",
    p: /(?<![A-Za-z0-9+/=])(?<!sha1-)(?<!sha256-)(?<!sha384-)(?<!sha512-)[A-Za-z0-9+/=]{40,}(?![A-Za-z0-9+/=])/g,
    skipIn: (text) => {
      const isPathLike = pathLikeRunReader(text);
      return (m, offset) => /^[0-9a-f]+$/i.test(m) || isPathLike(m, offset);
    },
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

/** A segment long enough to be an encoded secret and shaped like one: both cases and a digit. */
function isBase64Segment(segment: string): boolean {
  return segment.length >= 20 && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /[0-9]/.test(segment) && !isSourceFilename(segment) && !isLabelSegment(segment);
}

/* A word, a number, a word with a short number (`r2`, `Run2`, `16Z`) or a timestamp (`20261116T235316Z`): the parts a run directory or file name is named by. A part holding two cases inside a word is not one. */
const LABEL_PART_RE = /^(?:[a-z]+|[A-Z][a-z]*|[A-Z]+|\d+|(?:[a-z]+|[A-Z][a-z]*|[A-Z]+)\d{1,3}|\d{1,3}(?:[a-z]+|[A-Z][a-z]*|[A-Z]+)|\d+(?:[A-Z]\d+)+[A-Z]?)$/;

/** A segment joined by `-`, `_` or `.` whose every part is a label part: a name, never an encoded value. */
function isLabelSegment(segment: string): boolean {
  const parts = segment.split(/[-_.]/).filter((part) => part !== "");
  return parts.length > 1 && parts.every((part) => LABEL_PART_RE.test(part));
}

/* A file name is identifier words plus digits (`ProductFacadeV2Impl`, `OAuth2Client`) and a lowercase extension. A run of digits that ends the stem needs a `V`/`Version` marker, so a numeric tail does not disguise an encoded segment. */
function isSourceFilename(segment: string): boolean {
  const dot = segment.lastIndexOf(".");
  if (dot === -1 || !/^[a-z]+$/.test(segment.slice(dot + 1))) return false;
  const stem = segment.slice(0, dot);
  if (/[0-9]$/.test(stem) && !/[Vv](?:ersion)?\d+$/.test(stem)) return false;
  return isIdentifierShape(stem.replace(/[Vv]?\d+/g, ""));
}

/** Whether a token holding a `/` is a path of at least three segments (absolute or relative) with no encoded segment. */
function isPathToken(token: string): boolean {
  if (token.length < 40) return false;
  const segments = token.split("/").filter((segment) => segment !== "");
  return segments.length >= 3 && segments.every((segment) => segment.length <= 80) && !segments.some(isBase64Segment);
}

/** Whether a match of `text` is code: a path token (it continues through the `-`, `.` and `_` the pattern stops at) or a camelCase identifier. A token is read and judged once for all the matches inside it. */
function pathLikeRunReader(text: string): (match: string, offset: number) => boolean {
  let start = 0;
  let end = 0;
  let hasSlash = false;
  let isPath = false;
  return (match, offset) => {
    if (match.includes("+") || match.includes("=")) return false;
    if (offset < start || offset + match.length > end) {
      start = offset;
      while (start > 0 && PATH_CHARACTER.test(text[start - 1] ?? "")) start--;
      end = offset + match.length;
      while (end < text.length && PATH_CHARACTER.test(text[end] ?? "")) end++;
      const token = text.slice(start, end);
      hasSlash = token.includes("/");
      isPath = hasSlash && isPathToken(token);
    }
    return hasSlash ? isPath : isIdentifierShape(match);
  };
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
const EMAIL_LOCAL_CHARACTER = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/y;
const WORD_CHARACTER = /\w/;

function startsWord(text: string, index: number): boolean {
  return WORD_CHARACTER.test(text[index - 1] ?? "") !== WORD_CHARACTER.test(text[index] ?? "");
}

/** Redacts `local@domain`, reading each run of local-part characters once. */
function redactEmails(text: string): string {
  let redacted = "";
  let copied = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", Math.max(at + 1, copied))) {
    let start = at;
    while (start > copied && EMAIL_LOCAL_CHARACTER.test(text[start - 1] ?? "")) start--;
    while (start < at && !startsWord(text, start)) start++;
    if (start === at) continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    const domain = EMAIL_DOMAIN.exec(text);
    if (!domain) continue;
    redacted += text.slice(copied, start) + REDACTED;
    copied = at + 1 + domain[0].length;
  }
  return redacted + text.slice(copied);
}

const NO_SECRETS: ByValueRedaction = (text) => ({ text, count: 0 });

/** The name the by-value pass reports under in a detection. */
const BY_VALUE_PATTERN = "run-secret";

const DATA_PREFIX = /data:/gi;
const DATA_PREFIX_LENGTH = "data:".length;
const BASE64_PAYLOAD = /;base64,[A-Za-z0-9+/=]+/iy;

/** Replaces each `data:<type>;base64,<payload>`; a prefix without a payload after its first `;` fails every prefix before that `;`. */
function replaceDataUris(text: string, replace: (uri: string) => string): string {
  let replaced = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    DATA_PREFIX.lastIndex = from;
    const prefix = DATA_PREFIX.exec(text);
    if (!prefix) break;
    const semicolon = text.indexOf(";", prefix.index + DATA_PREFIX_LENGTH);
    if (semicolon === -1) break;
    BASE64_PAYLOAD.lastIndex = semicolon;
    const payload = semicolon > prefix.index + DATA_PREFIX_LENGTH ? BASE64_PAYLOAD.exec(text) : null;
    if (!payload) {
      from = semicolon;
      continue;
    }
    from = semicolon + payload[0].length;
    replaced += text.slice(copied, prefix.index) + replace(text.slice(prefix.index, from));
    copied = from;
  }
  return replaced + text.slice(copied);
}

/** The caller's secrets by value first, then the named patterns, internal hosts and email. Data URIs are kept. */
export function sanitizeText(input: string, mode: RedactionMode = "issue", byValue: ByValueRedaction = NO_SECRETS): { text: string; detection: SecretDetection } {
  if (!input) return { text: input, detection: { redacted: false, patterns: [], count: 0 } };

  const valued = byValue(input);
  let out = valued.text;
  const matchedPatterns: string[] = valued.count > 0 ? [BY_VALUE_PATTERN] : [];
  let totalRedactions = valued.count;

  const dataUris: string[] = [];
  out = replaceDataUris(out, (uri) => {
    dataUris.push(uri);
    return `__SANITIZER_DATAURI_${dataUris.length - 1}__`;
  });

  for (const { name, p, readsPrefix, skipIn, modelSkip } of NAMED_SECRET_PATTERNS) {
    let redactions = 0;
    const skip = skipIn?.(out);
    const read = readsPrefix?.(out) ?? out.length;
    out = out.slice(0, read).replace(p, (m, offset: number) => {
      if (skip?.(m, offset)) return m;
      if (mode === "model" && modelSkip?.(m)) return m;
      redactions++;
      return redactPreservingTrailingQuote(m);
    }) + out.slice(read);
    if (redactions > 0) {
      matchedPatterns.push(name);
      totalRedactions += redactions;
    }
  }

  out = out.replace(/__SANITIZER_DATAURI_(\d+)__/g, (_, i) => dataUris[Number(i)] ?? "");

  for (const p of INTERNAL_HOST_PATTERNS) out = out.replace(p, REDACTED);
  out = redactEmails(out);

  return { text: out, detection: { redacted: totalRedactions > 0, patterns: matchedPatterns, count: totalRedactions } };
}

/** True when a named pattern still finds a secret, with the same skip decisions as `sanitizeText`. */
export function containsSecrets(text: string, mode: RedactionMode = "issue"): boolean {
  if (!text) return false;
  const masked = replaceDataUris(text, () => "");
  for (const { p, readsPrefix, skipIn, modelSkip } of NAMED_SECRET_PATTERNS) {
    p.lastIndex = 0;
    const read = masked.slice(0, readsPrefix?.(masked) ?? masked.length);
    const conditional = skipIn !== undefined || (mode === "model" && modelSkip !== undefined);
    if (!conditional) {
      if (p.test(read)) return true;
      continue;
    }
    const skip = skipIn?.(masked);
    for (const found of read.matchAll(p)) {
      const m = found[0];
      if (skip?.(m, found.index ?? 0)) continue;
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
