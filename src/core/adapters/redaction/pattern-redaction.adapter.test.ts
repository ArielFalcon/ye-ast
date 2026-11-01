import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, SecretLeakError, type ByValueRedaction, type Redaction } from "../../ports/redaction.port.ts";
import { assertNoSecretLeak, createPatternRedaction, sanitizeText } from "./pattern-redaction.adapter.ts";

const port: Redaction = createPatternRedaction();

test("a mixed secret, address and email line loses every sensitive part and keeps the host key", () => {
  const input = "apiKey=sk-abc123XYZ host=10.0.3.14 email leaker@example.com token: ghs_supersecretvalue";
  assert.equal(port.redact(input), `${REDACTED} host=${REDACTED} email ${REDACTED} ${REDACTED}`);
  assert.deepEqual(port.detect(input), { redacted: true, patterns: ["api-key-assignment"], count: 2 });
});

test("redactValue redacts every string of a JSON value, object keys included, and keeps its shape", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const value = { files: [{ path: `src/${secret}.ts`, line: 3 }], [secret]: true, ok: null };
  assert.notEqual(port.redact(secret), secret);

  assert.deepEqual(port.redactValue(value), { files: [{ path: `src/${port.redact(secret)}.ts`, line: 3 }], [port.redact(secret)]: true, ok: null });
});

test("redactError redacts the message of an Error and the text of a thrown non-Error", () => {
  const secret = "ghp_" + "a".repeat(36);
  assert.equal(port.redactError(new Error(`clone failed with ${secret}`)), `clone failed with ${REDACTED}`);
  assert.equal(port.redactError(`token ${secret}`), `token ${REDACTED}`);
  assert.equal(port.redactError(undefined), "undefined");
});

test("a connection string loses its password and keeps the host", () => {
  assert.equal(port.redact("DATABASE_URL=postgres://admin:s3cr3tP4ss@db.internal:5432/app"), `DATABASE_URL=postgres://${REDACTED}@db.internal:5432/app`);
});

test("a bearer token is redacted whole", () => {
  const input = "Authorization: Bearer eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
  assert.equal(port.redact(input), REDACTED);
  assert.deepEqual(port.detect(input).patterns, ["bearer-token"]);
});

test("a base64 data URI, a clean URL, a git SHA and the empty string pass through unchanged", () => {
  for (const input of [`<img src="data:image/png;base64,${"A".repeat(60)}">`, "fetch('https://api.example.com/v1/users?page=2')", "commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 landed", ""]) {
    assert.equal(port.redact(input), input);
    assert.deepEqual(port.detect(input), { redacted: false, patterns: [], count: 0 });
  }
});

test("issue mode redacts a keyword assignment even when the value is only a type or a call", () => {
  const input = "password: string; token = getToken();";
  assert.equal(port.redact(input), `${REDACTED} ${REDACTED}`);
  assert.equal(port.redact(input, "issue"), port.redact(input));
});

test("model mode keeps a type annotation and a call expression and still redacts a quoted literal", () => {
  assert.equal(port.redact("password: string;", "model"), "password: string;");
  assert.equal(port.redact("const token = getToken();", "model"), "const token = getToken();");
  assert.equal(port.redact('const password = "hunter2";', "model"), `const ${REDACTED};`);
  assert.equal(port.detect("password: string;", "model").redacted, false);
});

test("containsSecret flags a real secret, not clean text, and model mode does not flag a type annotation", () => {
  assert.equal(port.containsSecret("token: ghs_supersecretvalue123456789012345678"), true);
  assert.equal(port.containsSecret("fetch('https://api.example.com/v1/users?page=2')"), false);
  assert.equal(port.containsSecret("password: string;", "model"), false);
});

test("an embedded quote in a bare value does not leak the tail", () => {
  assert.equal(port.redact('token=abc"def'), REDACTED);
  assert.equal(port.redact('GITHUB_TOKEN=ghp_abc"XYZ123'), REDACTED);
  assert.equal(port.redact('leaked secret: password="mySecretPass\\"WithQuote" end'), `leaked ${REDACTED} end`);
});

test("a balanced-quote name holding a keyword is redacted without corrupting the surrounding markup", () => {
  assert.equal(
    port.redact("role:name 'button' with name \"Token: refresh\" is NOT in the captured tree"),
    `role:name 'button' with name "${REDACTED}" is NOT in the captured tree`,
  );
});

test("assertNoSecretLeak throws SecretLeakError when a secret survives and stays quiet on clean text", () => {
  assert.throws(() => assertNoSecretLeak("token: ghs_supersecretvalue123456789012345678", "issue", "diff→model"), (e: unknown) => e instanceof SecretLeakError && /a secret survived redaction/.test(e.message));
  assert.doesNotThrow(() => assertNoSecretLeak("no secrets here", "issue", "diff→model"));
});

const PASSWORD = "plain-pass-9981";
const COOKIE = "c00kie-value-abcdef";

function secrets(...values: string[]): ByValueRedaction {
  return (text) => {
    let count = 0;
    let out = text;
    for (const value of values) out = out.replaceAll(value, () => (count++, REDACTED));
    return { text: out, count };
  };
}

test("the caller's own secrets are taken out by value before the patterns, in every mode", () => {
  const withSecrets = createPatternRedaction(secrets(PASSWORD, COOKIE));
  for (const mode of ["issue", "model"] as const) {
    const out = withSecrets.redact(`Expected: ${PASSWORD} cookie=${COOKIE} token=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa`, mode);
    assert.ok(!out.includes(PASSWORD) && !out.includes(COOKIE));
    assert.ok(withSecrets.detect(`<input value="${PASSWORD}">`, mode).patterns.includes("run-secret"));
  }
  assert.equal(port.redact(PASSWORD), PASSWORD);
});

test("the value pass counts what it replaced and leaves the pattern pass its own count", () => {
  const patternOnly = "token=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const patternCount = sanitizeText(patternOnly).detection.count;
  const out = sanitizeText(`${PASSWORD} ${COOKIE} ${PASSWORD} ${patternOnly}`, "issue", secrets(PASSWORD, COOKIE));
  assert.equal(out.detection.count, 3 + patternCount);
  assert.ok(out.detection.patterns.includes("run-secret") && out.detection.patterns.includes("llm-api-key"));
});
