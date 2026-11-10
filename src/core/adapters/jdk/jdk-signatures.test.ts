import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJdkSignatures, serializeJdkSignatures, JdkSignaturesFault } from './jdk-signatures.js';
import { generateJdkSignatures } from '../../../../scripts/jdk-signatures.js';
test('canonical bytes and malformed tables', () => {
 const table = { digest: 'a'.repeat(64), release: (n: number) => n === 23 ? new Map() : undefined };
 const text = serializeJdkSignatures(table);
 assert.equal(text, serializeJdkSignatures(table));
 assert.equal(parseJdkSignatures(text).release(23)?.size, 0);
 assert.equal(parseJdkSignatures(text).release(6), undefined);
 assert.throws(() => parseJdkSignatures(text.slice(0,-1)), JdkSignaturesFault);
});
test('rejected digest reads no members and generates nothing', () => {
 assert.throws(() => generateJdkSignatures({digest: 'bad', names: () => { assert.fail(); }, entry: () => { assert.fail(); }}), JdkSignaturesFault);
});
