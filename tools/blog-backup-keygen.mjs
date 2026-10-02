import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, access, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = process.argv[2];
if (!directory?.startsWith('/')) throw new Error('Provide an absolute private key directory outside the Git repository.');
const target = resolve(directory);
if (target === process.cwd() || target.startsWith(`${process.cwd()}/`)) throw new Error('PRIVATE_KEY_MUST_BE_OUTSIDE_REPO');
// Check the destination's Git ancestry too, not only the current checkout.
let ancestor = target;
while (true) {
  try { await access(ancestor); break; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(ancestor);
    if (parent === ancestor) throw error;
    ancestor = parent;
  }
}
ancestor = await realpath(ancestor);
const git = spawnSync('git', ['-C', ancestor, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (git.status === 0 && git.stdout.trim() === 'true') throw new Error('PRIVATE_KEY_DESTINATION_IS_GIT_WORKSPACE');
await mkdir(target, { recursive: true, mode: 0o700 });
const pair = generateKeyPairSync('rsa', { modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
await writeFile(`${target}/private.pem`, pair.privateKey, { flag: 'wx', mode: 0o600 });
await writeFile(`${target}/public.pem`, pair.publicKey, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ created: true, privateKeyPrinted: false, uploaded: false }));
