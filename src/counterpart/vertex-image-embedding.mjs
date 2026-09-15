import { createHash, createSign } from 'node:crypto';
import sharp from 'sharp';
import { isRedisConfigured, redisCommand } from '../redis-rest.mjs';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const CACHE_PREFIX = 'realview:counterpart:v2:embedding:';
let cachedAccessToken = null;

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function serviceAccount(env = process.env) {
  const raw = String(env.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    const decoded = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed?.client_email && parsed?.private_key && parsed?.project_id ? parsed : null;
  } catch {
    return null;
  }
}

export function isVertexImageEmbeddingConfigured(env = process.env) {
  return Boolean(serviceAccount(env));
}

async function accessToken(account, fetchImpl) {
  if (cachedAccessToken?.value && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: SCOPE,
    aud: account.token_uri || TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3_300
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`;
  const response = await fetchImpl(account.token_uri || TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Google OAuth trả về HTTP ${response.status}.`);
  const body = await response.json();
  if (!body?.access_token) throw new Error('Google OAuth không trả về access token.');
  cachedAccessToken = { value: body.access_token, expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 3_300) * 1_000 };
  return cachedAccessToken.value;
}

async function normalizedImage(buffer) {
  return sharp(buffer, { failOn: 'warning', limitInputPixels: 24_000_000 })
    .rotate()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return null;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

export async function createVertexImageEmbedding(buffer, options = {}) {
  const env = options.env || process.env;
  const account = serviceAccount(env);
  if (!account) return null;
  const image = await normalizedImage(buffer);
  const digest = createHash('sha256').update(image).digest('hex');
  if (isRedisConfigured()) {
    const cached = await redisCommand(['GET', `${CACHE_PREFIX}${digest}`], { fetchImpl: options.redisFetchImpl, timeoutMs: 1_500 }).catch(() => null);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* Recompute malformed cache entries. */ }
    }
  }
  const fetchImpl = options.vertexFetchImpl || options.fetchImpl || fetch;
  const token = await accessToken(account, fetchImpl);
  const location = String(env.GOOGLE_CLOUD_VERTEX_LOCATION || 'us-central1').trim();
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/locations/${encodeURIComponent(location)}/publishers/google/models/multimodalembedding@001:predict`;
  const configuredTimeoutMs = Math.max(5_000, Number(env.COUNTERPART_VERTEX_TIMEOUT_MS) || 15_000);
  const availableMs = Number.isFinite(Number(options.deadlineAt))
    ? Number(options.deadlineAt) - Date.now() - 5_000
    : configuredTimeoutMs;
  if (availableMs < 1_000) throw Object.assign(new Error('Hết thời gian tạo image embedding.'), { code: 'COUNTERPART_DEADLINE' });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ instances: [{ image: { bytesBase64Encoded: image.toString('base64') } }], parameters: { dimension: 512 } }),
    signal: AbortSignal.timeout(Math.min(configuredTimeoutMs, availableMs))
  });
  if (!response.ok) throw new Error(`Vertex multimodal embedding trả về HTTP ${response.status}.`);
  const body = await response.json();
  const embedding = body?.predictions?.[0]?.imageEmbedding;
  if (!Array.isArray(embedding) || !embedding.length) throw new Error('Vertex không trả về image embedding hợp lệ.');
  if (isRedisConfigured()) {
    await redisCommand(['SET', `${CACHE_PREFIX}${digest}`, JSON.stringify(embedding), 'EX', String(30 * 24 * 60 * 60)], {
      fetchImpl: options.redisFetchImpl,
      timeoutMs: 1_500
    }).catch(() => null);
  }
  return embedding;
}
