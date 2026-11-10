import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openJdkArchive, type JdkArchive } from '../src/core/adapters/jdk/jdk-archive.adapter.js';
import { readClassFile } from '../src/core/adapters/jdk/class-file.js';
import { JdkSignaturesFault, serializeJdkSignatures, type JdkType } from '../src/core/adapters/jdk/jdk-signatures.js';
const digests = new Set(['e47b50ac58efc23859ade811e266307a3fc9d9b9b65fff01b830b0e9d8aae263','4a8cfcd91fd9156268e350f8473168927c4ccca21fd5c87285153f4934f0e1c6']);
export function generateJdkSignatures(archive: JdkArchive, expectedDigest = archive.digest): string {
 if (!digests.has(archive.digest) || archive.digest !== expectedDigest) throw new JdkSignaturesFault('digest');
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const args = process.argv.slice(2);
 const option = (name: string) => args[args.indexOf(name)+1];
 if (!args.includes('--jdk') || !args.includes('--out')) throw new JdkSignaturesFault('format');
 const text = generateJdkSignatures(openJdkArchive(join(option('--jdk')!, 'lib', 'ct.sym')),args.includes('--digest') ? option('--digest') : undefined);
 writeFileSync(option('--out')!,text);
}
