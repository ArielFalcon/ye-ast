import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { encodeCursor, decodeCursor, selectionDigest, validateCursorRequest, validateCursorPosition, assertSourceIdentity, isResultIdentity } from './evidence-cursor.ts';
import type { Recovery } from './recovery.ts';

const digest = { of: (s: string) => createHash('sha256').update(s).digest('hex') };
const identity = `mcp-r1:${'a'.repeat(64)}`;
const selection = { category: 'rutas', subject: 'á' };
const cursor = { version: 1 as const, resultIdentity: identity, selection: selectionDigest(selection, digest), limit: 2, next: 1 };
const raw = (s: string) => `mcp-p1.${Buffer.from(s).toString('base64url')}`;
const bad = (value: unknown) => assert.equal((value as {ok: boolean}).ok, false);

test('canonical cursor roundtrip is deterministic and selection digest is independent', () => {
  const encoded = encodeCursor(cursor);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  assert.deepEqual(decodeCursor(encoded.value), {ok: true, value: cursor});
  assert.deepEqual(encodeCursor({next: 1, limit: 2, selection: cursor.selection, resultIdentity: identity, version: 1}), encoded);
  assert.equal(selectionDigest({subject: 'á', category: 'rutas'}, digest), cursor.selection);
  assert.notEqual(selectionDigest({category: 'other'}, digest), cursor.selection);
});

test('strict decoding rejects noncanonical encodings and structures', () => {
  const canonical = JSON.stringify({limit: 2, next: 1, resultIdentity: identity, selection: cursor.selection, version: 1});
  for (const s of ['', 'mcp-p2.abc', 'mcp-p1.=', 'mcp-p1.a', raw(canonical) + '=', raw(canonical) + '!', raw(canonical + '\0'), 'mcp-p1._w', 'mcp-p1.77u_', raw(canonical.replace('mcp-r1:', 'mcp-r1:Á')), raw('{}'), raw(canonical + ' '), raw(canonical.replace('"limit":2', '"limit":2,"limit":2')), raw(canonical.replace('"version":1', '"version":2')), raw(canonical.replace('"version":1', '"version":1,"extra":true')), raw(canonical.replace('"limit":2,', '')), raw(canonical.replace('"limit":2', '"limit":9007199254740992')), raw(canonical.replace('"next":1', '"next":0')), raw(canonical.replace('"limit":2', '"limit":2.0')), raw('null'), raw('{')]) bad(decodeCursor(s));
  bad(encodeCursor({...cursor, next: Number.MAX_SAFE_INTEGER + 1}));
  assert.equal(encodeCursor({...cursor, next: Number.MAX_SAFE_INTEGER}).ok, true);
  assert.equal(isResultIdentity(identity), true);
  assert.equal(isResultIdentity(identity.toUpperCase()), false);
});

test('request bindings and position are checked independently without authorization', () => {
  assert.equal(validateCursorRequest(cursor, selection, 2, undefined, digest).ok, true);
  bad(validateCursorRequest(cursor, {category: 'other'}, 2, undefined, digest));
  bad(validateCursorRequest(cursor, selection, 3, undefined, digest));
  bad(validateCursorRequest(cursor, selection, 2, `mcp-r1:${'b'.repeat(64)}`, digest));
  bad(validateCursorRequest(cursor, selection, 2, 'bad', digest));
  for (const total of [0, 1, -1, Number.MAX_SAFE_INTEGER + 1]) bad(validateCursorPosition(cursor, total));
  assert.equal(validateCursorPosition(cursor, 2).ok, true);
  assert.equal(validateCursorPosition({...cursor, next: Number.MAX_SAFE_INTEGER - 1}, Number.MAX_SAFE_INTEGER).ok, true);
  bad(validateCursorPosition({...cursor, next: Number.MAX_SAFE_INTEGER}, Number.MAX_SAFE_INTEGER));
});

test('source assertions preserve recovery reasons and compare complete identities', () => {
  const available: Recovery = {version: 1, status: 'available', resultIdentity: identity, query: {name: 'ye_ast_entrypoints', arguments: {repo: 'x'}}};
  assert.equal(assertSourceIdentity(available, identity).ok, true);
  assert.deepEqual(assertSourceIdentity({...available, resultIdentity: `mcp-r1:${'b'.repeat(64)}`}, identity), {ok: false, fault: {code: 'result-changed', expected: identity, actual: `mcp-r1:${'b'.repeat(64)}`, stage: 'source-identity'}});
  for (const reason of ['deadline', 'unresolved-context', 'redacted-context'] as const) assert.deepEqual(assertSourceIdentity({version: 1, status: 'unavailable', reason}, identity), {ok: false, fault: {code: 'replay-unavailable', reason}});
  bad(assertSourceIdentity({...available, resultIdentity: 'bad'}, identity));
  bad(assertSourceIdentity(available, 'bad'));
});
