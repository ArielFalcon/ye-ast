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
test('a java module wiring file in the archive is skipped, never a decode fault', () => {
  const digest = 'e47b50ac58efc23859ade811e266307a3fc9d9b9b65fff01b830b0e9d8aae263';
  const archive = {
    digest,
    names: (prefix: string) => (prefix === '' ? ['N/java.base/module-info.sig'] : []),
    entry: () => ({ kind: 'entry', bytes: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) }),
  } as unknown as Parameters<typeof generateJdkSignatures>[0];
  assert.throws(() => generateJdkSignatures(archive), (error: unknown) => error instanceof JdkSignaturesFault && error.code === 'archive', 'skipped, so the table is empty rather than a decode rejection');
});
