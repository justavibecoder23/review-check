import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const environment = process.argv.includes('--production') ? 'production' : 'preview';
const content = readFileSync(`.vercel/.env.cloudflare-${environment}.local`, 'utf8');
const values = Object.fromEntries(content.trim().split('\n').map(line => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
values.REVIEW_DATASET_BLOB_FALLBACK = 'false';
for (const [name, value] of Object.entries(values)) {
  execFileSync('/opt/homebrew/bin/vercel', ['env', 'add', name, environment, '--force', '--yes'], {
    input: value, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000
  });
  console.log(`Configured ${name} for ${environment}; value not logged.`);
}
