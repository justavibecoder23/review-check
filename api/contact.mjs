import { createHash } from 'node:crypto';
import { redisCommand } from '../src/redis-rest.mjs';
import { saveContactMessage, sendContactNotification } from '../src/contact-store.mjs';

function bodyOf(request) {
  if (typeof request.body === 'string') return JSON.parse(request.body || '{}');
  return request.body || {};
}

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json(payload);
}

async function enforceRateLimit(request) {
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const identity = forwarded || String(request.socket?.remoteAddress || 'local');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const key = `realview:contact:v1:rate:${digest}`;
  const count = Number(await redisCommand(['INCR', key]));
  if (count === 1) await redisCommand(['EXPIRE', key, 60 * 60]);
  if (count > 5) {
    const error = new Error('Bạn đã gửi quá nhiều liên hệ. Vui lòng thử lại sau.');
    error.statusCode = 429;
    error.code = 'RATE_LIMITED';
    throw error;
  }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return send(response, 405, { error: 'Phương thức không được hỗ trợ.' });
  }
  try {
    await enforceRateLimit(request);
    const record = await saveContactMessage(bodyOf(request));
    const notification = await sendContactNotification(record)
      .catch(() => ({ delivered: false, reason: 'delivery_failed' }));
    return send(response, notification.delivered ? 201 : 202, {
      stored: true,
      delivered: notification.delivered,
      ...(!notification.delivered ? { deliveryReason: notification.reason || 'delivery_failed' } : {})
    });
  } catch (error) {
    return send(response, error?.statusCode || 500, {
      error: error?.message || 'Không thể gửi liên hệ lúc này.',
      ...(error?.code ? { code: error.code } : {})
    });
  }
}

