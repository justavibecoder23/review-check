// Shared by the Vercel bridge and Worker. This authenticates an envelope only:
// replay consumption and an active D1 grant at commit are separate requirements.
const encoder = new TextEncoder();
const MAX_BODY_BYTES = 4_300_000;
const TOKEN = /^[a-zA-Z0-9:_-]{16,128}$/;
const HEX = /^[a-f0-9]{64}$/;

function fail(code = 'BLOG_AUTH_INVALID') {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 401;
  throw error;
}

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalBlogTarget(input) {
  // Inspect raw path before URL parsing can silently collapse dot segments.
  const raw = String(input);
  const match = /^https:\/\/[^/?#]+(\/[^?#]*)?(\?[^#]*)?$/.exec(raw);
  if (!match || raw.length > 2048) fail();
  const url = new URL(raw);
  if (url.username || url.password || url.hash) fail();
  const rawPath = match[1] || '/';
  if (rawPath.includes('\\') || rawPath.includes('//') || (rawPath.length > 1 && rawPath.endsWith('/'))) fail();
  let segments;
  try { segments = rawPath.split('/').map(segment => decodeURIComponent(segment)); }
  catch { fail(); }
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || /[\\/\u0000-\u001f\u007f]/.test(segment)) fail();
  }
  const path = segments.map(encode).join('/');
  // Reject malformed percent escapes/UTF-8 rather than accepting URLSearchParams replacement characters.
  const pairs = [];
  const names = new Set();
  const query = match[2]?.slice(1) || '';
  for (const field of query ? query.split('&') : []) {
    if (!field) fail();
    const equal = field.indexOf('=');
    const key = equal < 0 ? field : field.slice(0, equal);
    const value = equal < 0 ? '' : field.slice(equal + 1);
    let name, decoded;
    try {
      name = decodeURIComponent(key.replace(/\+/g, ' '));
      decoded = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch { fail(); }
    if (!name || /[\u0000-\u001f\u007f]/.test(name + decoded) || names.has(name)) fail();
    names.add(name);
    pairs.push([encode(name), encode(decoded)]);
  }
  pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return path + (pairs.length ? `?${pairs.map(([key, value]) => `${key}=${value}`).join('&')}` : '');
}

function bodyBytes(body) {
  if (!(body instanceof Uint8Array)) fail('BLOG_AUTH_BODY_REQUIRED');
  if (body.byteLength > MAX_BODY_BYTES) fail('BLOG_AUTH_BODY_TOO_LARGE');
  return body;
}

export async function blogBodyHash(body) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bodyBytes(body)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalEnvelope(fields, bodyHash) {
  if (!['preview', 'production'].includes(fields.environment)) fail();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(fields.method)) fail();
  if (!/^\d{10}$/.test(String(fields.timestamp))) fail();
  if (typeof fields.requestId !== 'string' || !TOKEN.test(fields.requestId)
    || typeof fields.actorId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(fields.actorId)) fail();
  if (!TOKEN.test(fields.idempotencyKey)) fail();
  if (!['application/json', 'application/octet-stream'].includes(fields.contentType)) fail();
  return [
    'realview-blog-hmac-v1', fields.environment, fields.method,
    canonicalBlogTarget(fields.url), String(fields.timestamp), fields.requestId,
    fields.actorId, fields.idempotencyKey, fields.contentType, bodyHash
  ].join('\n');
}

async function hmacKey(secret, usage) {
  if (typeof secret !== 'string' || encoder.encode(secret).byteLength < 32) fail('BLOG_AUTH_NOT_CONFIGURED');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signBlogRequest({ secret, body, ...fields }) {
  const hash = await blogBodyHash(body);
  const canonical = canonicalEnvelope(fields, hash);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(canonical)));
  return {
    'x-blog-environment': fields.environment,
    'x-blog-timestamp': String(fields.timestamp),
    'x-blog-request-id': fields.requestId,
    'x-blog-actor-id': fields.actorId,
    'x-blog-idempotency-key': fields.idempotencyKey,
    'x-blog-body-sha256': hash,
    'x-blog-signature': [...signature].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    'content-type': fields.contentType
  };
}

export async function verifyBlogRequest({ secret, environment, method, url, headers, body, now = Date.now() }) {
  const h = new Headers(headers);
  const fields = {
    environment: h.get('x-blog-environment'), method, url,
    timestamp: h.get('x-blog-timestamp'), requestId: h.get('x-blog-request-id'),
    actorId: h.get('x-blog-actor-id'), idempotencyKey: h.get('x-blog-idempotency-key'),
    contentType: h.get('content-type')
  };
  if (!['preview', 'production'].includes(environment) || fields.environment !== environment) fail();
  const signature = h.get('x-blog-signature');
  if (!HEX.test(signature || '') || !HEX.test(h.get('x-blog-body-sha256') || '')) fail();
  const bodyHash = await blogBodyHash(body);
  const canonical = canonicalEnvelope(fields, bodyHash);
  const seconds = Math.floor(now / 1000);
  const timestamp = Number(fields.timestamp);
  if (!Number.isFinite(seconds) || seconds - timestamp > 300 || timestamp - seconds > 30) fail('BLOG_AUTH_EXPIRED');
  const bytes = Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16));
  // WebCrypto verification avoids a JS string-equality signature check.
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), bytes, encoder.encode(canonical));
  if (!valid || bodyHash !== h.get('x-blog-body-sha256')) fail();
  return { actorId: fields.actorId, requestId: fields.requestId, idempotencyKey: fields.idempotencyKey, timestamp, bodyHash };
}
