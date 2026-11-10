import type { JdkArchive } from './jdk-archive.adapter.js';
import { readClassFile } from './class-file.js';
import { JdkSignaturesFault, serializeJdkSignatures, type JdkType } from './jdk-signatures.js';

/** The whole ct.sym SHA-256 digests the pin accepts (ADR-0044 decision 10): Oracle and OpenJDK 23.0.1+11. */
export const PINNED_JDK_DIGESTS: ReadonlySet<string> = new Set([
 'e47b50ac58efc23859ade811e266307a3fc9d9b9b65fff01b830b0e9d8aae263',
 '4a8cfcd91fd9156268e350f8473168927c4ccca21fd5c87285153f4934f0e1c6',
]);

export function generateJdkSignatures(archive: JdkArchive, expectedDigest = archive.digest, pins: ReadonlySet<string> = PINNED_JDK_DIGESTS): string {
 if (!pins.has(archive.digest) || archive.digest !== expectedDigest) throw new JdkSignaturesFault('digest');
 const types = new Map<string,JdkType>();
 for (const name of archive.names('')) {
 const parts = name.split('/');
 if (!parts[0]?.includes('N') || !parts[1]?.startsWith('java.') || !name.endsWith('.sig') || name.endsWith('module-info.sig')) continue;
 const entry = archive.entry(name);
 if (entry.kind !== 'entry') throw new JdkSignaturesFault('archive');
 const declaration = readClassFile(entry.bytes);
 if (!declaration) throw new JdkSignaturesFault('decode');
 const {fqn,...type} = declaration;
 if (types.has(fqn)) throw new JdkSignaturesFault('archive');
 types.set(fqn,type);
 }
 if (types.size === 0) throw new JdkSignaturesFault('archive');
 return serializeJdkSignatures({digest:archive.digest,release:n => n === 23 ? types : undefined});
}
