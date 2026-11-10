import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openJdkArchive } from '../src/core/adapters/jdk/jdk-archive.adapter.js';
import { generateJdkSignatures } from '../src/core/adapters/jdk/jdk-signature-generator.js';
import { JdkSignaturesFault } from '../src/core/adapters/jdk/jdk-signatures.js';
export { generateJdkSignatures };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const args = process.argv.slice(2);
 const option = (name: string) => args[args.indexOf(name)+1];
 if (!args.includes('--jdk') || !args.includes('--out')) throw new JdkSignaturesFault('format');
 const text = generateJdkSignatures(openJdkArchive(join(option('--jdk')!, 'lib', 'ct.sym')),args.includes('--digest') ? option('--digest') : undefined);
 writeFileSync(option('--out')!,text);
}
