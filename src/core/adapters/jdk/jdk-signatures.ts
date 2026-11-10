import type { ClassDeclaration, ClassMember } from './class-file.js';
export type JdkType = Omit<ClassDeclaration, 'fqn'>;
export type JdkMember = ClassMember;
export type JdkRelease = ReadonlyMap<string, JdkType>;
export interface JdkSignatures {
 readonly digest: string;
 release(level: number): JdkRelease | undefined;
}
export class JdkSignaturesFault extends Error {
 constructor(readonly code: 'digest' | 'archive' | 'decode' | 'format') { super(code); }
}
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,canonical(v)]));
 return value;
}
export function serializeJdkSignatures(table: JdkSignatures): string {
 const release = table.release(23);
 const types = release === undefined ? undefined : Object.fromEntries([...release].map(([name,type]) => [name,{...type, members: [...type.members].sort((a,b) => {
 const x = JSON.stringify(canonical(a)), y = JSON.stringify(canonical(b));
 return x < y ? -1 : x > y ? 1 : 0;
 })}]));
 return JSON.stringify(canonical({digest: table.digest, releases: types === undefined ? {} : {'23':types}}));
}
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(x => typeof x === 'string');
function validType(v: unknown): v is JdkType {
 if (v === null || typeof v !== 'object') return false;
 const t = v as JdkType;
 return ['class','interface','enum','record','annotation'].includes(t.kind) && typeof t.abstract === 'boolean' && strings(t.typeParameters) && strings(t.supertypes) && Array.isArray(t.members) && t.members.every(m => m !== null && typeof m === 'object' && typeof m.name === 'string' && strings(m.typeParameters) && strings(m.parameters) && typeof m.returns === 'string' && ['static','abstract','varargs'].every(k => typeof m[k as keyof JdkMember] === 'boolean'));
}
export function parseJdkSignatures(text: string): JdkSignatures {
 let value: unknown;
 try { value = JSON.parse(text); } catch { throw new JdkSignaturesFault('format'); }
 if (!value || typeof value !== 'object') throw new JdkSignaturesFault('format');
 const v = value as {digest: unknown; releases: unknown};
 if (typeof v.digest !== 'string' || !/^[a-f0-9]{64}$/.test(v.digest) || !v.releases || typeof v.releases !== 'object' || Array.isArray(v.releases)) throw new JdkSignaturesFault('format');
 const releases = new Map<number,JdkRelease>();
 for (const [level,types] of Object.entries(v.releases)) {
 if (level !== '23' || !types || typeof types !== 'object' || Array.isArray(types) || !Object.values(types).every(validType)) throw new JdkSignaturesFault('format');
 releases.set(Number(level),new Map(Object.entries(types)));
 }
 return {digest:v.digest,release: n => releases.get(n)};
}
