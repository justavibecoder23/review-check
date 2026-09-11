import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { isRedisConfigured, redisTransaction } from './redis-rest.mjs';

const CONTACT_INBOX_KEY = 'realview:contact:v1:messages';
const CONTACT_EMAILS_KEY = 'realview:contact:v1:emails';
const CONTACT_LIMIT = 500;

function contactError(message, statusCode = 400, code = 'CONTACT_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function validateContact(input = {}) {
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const message = String(input.message || '').trim();
  if (name.length < 2 || name.length > 100) throw contactError('Vui lòng nhập họ tên hợp lệ.', 400, 'INVALID_NAME');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw contactError('Email chưa đúng định dạng.', 400, 'INVALID_EMAIL');
  if (message.length < 10 || message.length > 5_000) throw contactError('Nội dung cần từ 10–5.000 ký tự.', 400, 'INVALID_MESSAGE');
  return { name, email, message };
}

export async function saveContactMessage(input = {}, options = {}) {
  if (!isRedisConfigured()) throw contactError('Hộp thư liên hệ chưa được cấu hình.', 503, 'CONTACT_STORAGE_UNAVAILABLE');
  const value = validateContact(input);
  const record = { id: randomUUID(), ...value, createdAt: new Date().toISOString() };
  await redisTransaction([
    ['RPUSH', CONTACT_INBOX_KEY, JSON.stringify(record)],
    ['LTRIM', CONTACT_INBOX_KEY, String(-CONTACT_LIMIT), '-1'],
    ['SADD', CONTACT_EMAILS_KEY, record.email]
  ], options);
  return record;
}

export async function sendContactNotification(record, options = {}) {
  const smtpUser = String(process.env.GMAIL_SMTP_USER || '').trim().toLowerCase();
  const appPassword = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!smtpUser || !appPassword) return { delivered: false, reason: 'not_configured' };

  const recipient = 'realviewueh@gmail.com';
  const createTransport = options.createTransportImpl || nodemailer.createTransport;
  const transporter = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    connectionTimeout: 6_000,
    greetingTimeout: 6_000,
    socketTimeout: 10_000,
    auth: {
      user: smtpUser,
      pass: appPassword
    },
  });

  const safeName = String(record.name || '').replace(/[\r\n]+/g, ' ').trim();
  const info = await transporter.sendMail({
    from: `RealView <${smtpUser}>`,
    to: recipient,
    replyTo: record.email,
    subject: `Liên hệ mới từ ${safeName} qua RealView`,
    text: `Họ tên: ${safeName}\nEmail: ${record.email}\nThời gian: ${record.createdAt}\n\n${record.message}`
  });

  return { delivered: true, messageId: String(info?.messageId || '') };
}

export const contactStoreInternals = { CONTACT_INBOX_KEY, CONTACT_EMAILS_KEY, validateContact };

