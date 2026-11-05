import { canonicalJson } from '../core/domain/shared/canonical-json.ts';
import type { Result } from '../core/domain/shared/result.ts';
import type { Digest } from '../core/ports/digest.port.ts';
import type { Recovery } from './recovery.ts';

export const RESULT_IDENTITY_PATTERN = /^mcp-r1:[0-9a-f]{64}$/;
const PREFIX = 'mcp-p1.';
export type CursorV1 = { version: 1; resultIdentity: string; selection: string; limit: number; next: number };
export type InvalidCursorFault = { code: 'invalid-cursor' };
export type SourceVerificationFault = InvalidCursorFault | { code: 'replay-unavailable'; reason: Extract<Recovery, {status: 'unavailable'}>['reason'] } | { code: 'result-changed'; expected: string; actual: string; stage: 'source-identity' };
const invalid = (): Result<never, InvalidCursorFault> => ({ok: false, fault: {code: 'invalid-cursor'}});
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
export function isResultIdentity(value: unknown): value is string { return typeof value === 'string' && RESULT_IDENTITY_PATTERN.test(value); }
function isCursor(value: unknown): value is CursorV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const o = value as Record<string, unknown>;
  return Object.keys(o).sort().join(',') === 'limit,next,resultIdentity,selection,version' && o.version === 1 && isResultIdentity(o.resultIdentity) && typeof o.selection === 'string' && isResultIdentity(`mcp-r1:${o.selection}`) && positive(o.limit) && positive(o.next);
}
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function selectionDigest(selection: unknown, digest: Digest): string { return digest.of(canonicalJson(selection)); }
export function encodeCursor(cursor: CursorV1): Result<string, InvalidCursorFault> {
  if (!isCursor(cursor)) return invalid();
  return {ok: true, value: PREFIX + base64url(canonicalJson(cursor))};
}
export function decodeCursor(encoded: string): Result<CursorV1, InvalidCursorFault> {
  if (typeof encoded !== 'string' || !encoded.startsWith(PREFIX)) return invalid();
  const payload = encoded.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) return invalid();
  try {
    const binary = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const json = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const value: unknown = JSON.parse(json);
    if (!isCursor(value) || canonicalJson(value) !== json || base64url(json) !== payload) return invalid();
    return {ok: true, value};
  } catch { return invalid(); }
}
export function validateCursorRequest(cursor: CursorV1, selection: unknown, limit: number, expect: string | undefined, digest: Digest): Result<CursorV1, InvalidCursorFault> {
  if (!isCursor(cursor) || !positive(limit) || cursor.limit !== limit || cursor.selection !== selectionDigest(selection, digest) || (expect !== undefined && (!isResultIdentity(expect) || expect !== cursor.resultIdentity))) return invalid();
  return {ok: true, value: cursor};
}
export function validateCursorPosition(cursor: CursorV1, total: number): Result<number, InvalidCursorFault> {
  if (!isCursor(cursor) || !Number.isSafeInteger(total) || total < 0 || cursor.next >= total) return invalid();
  return {ok: true, value: cursor.next};
}
export function assertSourceIdentity(recovery: Recovery, expected: string): Result<string, SourceVerificationFault> {
  if (!isResultIdentity(expected)) return invalid();
  if (recovery.status === 'unavailable') return {ok: false, fault: {code: 'replay-unavailable', reason: recovery.reason}};
  if (!isResultIdentity(recovery.resultIdentity)) return invalid();
  if (recovery.resultIdentity !== expected) return {ok: false, fault: {code: 'result-changed', expected, actual: recovery.resultIdentity, stage: 'source-identity'}};
  return {ok: true, value: recovery.resultIdentity};
}
