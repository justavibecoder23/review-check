import { createHash } from 'node:crypto';
import { redisCommand } from '../src/redis-rest.mjs';
import { saveContactMessage, sendContactNotification, validateContact } from '../src/contact-store.mjs';
import {
  createEmailVerification,
  deleteEmailVerification,
  verifyEmailCode
} from '../src/email-verification.mjs';
import { sendEmailVerificationCode } from '../src/email-verification-mail.mjs';
import { sendContactAcknowledgementEmail } from '../src/contact-acknowledgement-email.mjs';
import { currentAccount } from './auth.mjs';

function bodyOf(request) {
  if (typeof request.body === 'string') return JSON.parse(request.body || '{}');
  return request.body || {};
}

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json(payload);
}

async function enforceRateLimit(request, action) {
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const identity = forwarded || String(request.socket?.remoteAddress || 'local');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const key = `realview:contact:v1:rate:${action}:${digest}`;
  const count = Number(await redisCommand(['INCR', key]));
  if (count === 1) await redisCommand(['EXPIRE', key, 60 * 60]);
  if (count > 5) {
    const error = new Error('Bạn đã gửi quá nhiều liên hệ. Vui lòng thử lại sau.');
    error.statusCode = 429;
    error.code = 'RATE_LIMITED';
    throw error;
  }
}

function assertSameOrigin(request) {
  const origin = String(request.headers?.origin || '');
  const host = String(request.headers?.['x-forwarded-host'] || request.headers?.host || '').split(',')[0].trim();
  if (!origin || !host) return;
  try {
    if (new URL(origin).host !== host) throw new Error('invalid');
  } catch {
    const error = new Error('Yêu cầu không hợp lệ.');
    error.statusCode = 403;
    error.code = 'INVALID_ORIGIN';
    throw error;
  }
}

function contactContext(value) {
  return JSON.stringify({ name: value.name, email: value.email, message: value.message });
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return send(response, 405, { error: 'Phương thức không được hỗ trợ.' });
  }
  try {
    assertSameOrigin(request);
    const body = bodyOf(request);
    const action = body.action || 'submit_contact';
    await enforceRateLimit(request, action);
    const account = await currentAccount(request);
    const value = validateContact({ ...body, email: account?.email || body.email });

    if (action === 'request_verification' && !account) {
      const verification = await createEmailVerification({
        purpose: 'contact',
        email: value.email,
        context: contactContext(value)
      });
      const delivery = await sendEmailVerificationCode(value.email, verification.code, 'contact')
        .catch(() => ({ delivered: false, reason: 'delivery_failed' }));
      if (!delivery.delivered) {
        await deleteEmailVerification(verification.requestId).catch(() => {});
        const error = new Error('Chưa thể gửi mã xác minh đến email này. Vui lòng kiểm tra địa chỉ và thử lại.');
        error.statusCode = 503;
        error.code = 'EMAIL_DELIVERY_FAILED';
        throw error;
      }
      return send(response, 200, {
        verificationId: verification.requestId,
        expiresIn: verification.expiresIn,
        message: 'Mã xác minh 6 số đã được gửi đến email của bạn.'
      });
    }

    if (!['request_verification', 'submit_contact'].includes(action)) {
      return send(response, 400, { error: 'Yêu cầu liên hệ không hợp lệ.' });
    }
    if (!account) {
      await verifyEmailCode({
        requestId: body.verificationId,
        code: body.code,
        purpose: 'contact',
        email: value.email,
        context: contactContext(value)
      });
    }
    const record = await saveContactMessage(value);
    const [notification, acknowledgement] = await Promise.all([
      sendContactNotification(record)
        .catch(() => ({ delivered: false, reason: 'delivery_failed' })),
      sendContactAcknowledgementEmail(record)
        .catch(() => ({ delivered: false, reason: 'delivery_failed' }))
    ]);
    return send(response, notification.delivered ? 201 : 202, {
      stored: true,
      delivered: notification.delivered,
      acknowledgementDelivered: acknowledgement.delivered,
      verifiedByAccount: Boolean(account),
      ...(!notification.delivered ? { deliveryReason: notification.reason || 'delivery_failed' } : {}),
      ...(!acknowledgement.delivered
        ? { acknowledgementDeliveryReason: acknowledgement.reason || 'delivery_failed' }
        : {})
    });
  } catch (error) {
    return send(response, error?.statusCode || 500, {
      error: error?.message || 'Không thể gửi liên hệ lúc này.',
      ...(error?.code ? { code: error.code } : {})
    });
  }
}

