function redisConfig() {
  return {
    url: String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, ''),
    token: String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '')
  };
}

export function isRedisConfigured() {
  const config = redisConfig();
  return Boolean(config.url && config.token);
}

async function execute(path, commands, options = {}) {
  const config = redisConfig();
  if (!config.url || !config.token) throw new Error('Chưa cấu hình Upstash Redis cho project.');
  const response = await (options.fetchImpl || fetch)(`${config.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(options.timeoutMs || 4_000)
  });
  if (!response.ok) throw new Error(`Redis trả về HTTP ${response.status}`);
  const body = await response.json();
  if (body?.error) throw new Error(`Redis: ${body.error}`);
  return body;
}

export async function redisCommand(command, options = {}) {
  const body = await execute('', command, options);
  return body?.result;
}

export async function redisTransaction(commands, options = {}) {
  const body = await execute('/multi-exec', commands, options);
  if (!Array.isArray(body)) throw new Error('Redis không trả về kết quả transaction hợp lệ.');
  const failed = body.find((item) => item?.error);
  if (failed) throw new Error(`Redis transaction: ${failed.error}`);
  return body.map((item) => item?.result);
}
