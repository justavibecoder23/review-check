import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const preview = process.argv.includes('--preview');
const file = `.vercel/.env.cloudflare-${preview ? 'preview' : 'production'}.local`;
const url = `https://realview-review-cache${preview ? '-preview' : ''}.wwpk-cloudflare-relay.workers.dev`;
let secret;
try {
  secret = readFileSync(file, 'utf8').match(/^CLOUDFLARE_REVIEW_CACHE_SECRET=(.+)$/m)?.[1];
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!secret) {
  secret = randomBytes(32).toString('hex');
  writeFileSync(file, `CLOUDFLARE_REVIEW_CACHE_URL=${url}\nCLOUDFLARE_REVIEW_CACHE_SECRET=${secret}\nREVIEW_DATASET_BACKEND=d1\nREVIEW_DATASET_BLOB_FALLBACK=true\n`, { mode: 0o600, flag: 'wx' });
}
if (!process.env.WRANGLER_BIN) throw new Error('WRANGLER_BIN must point to the installed official Wrangler CLI.');
const args = [process.env.WRANGLER_BIN, 'secret', 'put', 'REVIEW_CACHE_SECRET', '--config', 'cloudflare/review-cache/wrangler.jsonc',
  ...(preview ? ['--env', 'preview'] : [])];
const output = execFileSync(process.execPath, args, { input: `${secret}\n`, encoding: 'utf8', timeout: 120_000,
  stdio: ['pipe', 'pipe', 'pipe'] });
process.stdout.write(output);
console.log(`Credential configured; local environment saved in ${file}.`);
