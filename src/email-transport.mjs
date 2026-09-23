import nodemailer from 'nodemailer';

const SMTP_TIMEOUTS = {
  connectionTimeout: 6_000,
  greetingTimeout: 6_000,
  socketTimeout: 10_000
};

function cleanValue(value) {
  return String(value || '').trim();
}

function safeSender(value) {
  const sender = cleanValue(value);
  if (!sender || /[\r\n]/.test(sender)) return '';
  return sender;
}

export function createEmailTransport(options = {}) {
  const provider = cleanValue(process.env.EMAIL_PROVIDER || 'gmail').toLowerCase();
  const createTransport = options.createTransportImpl || nodemailer.createTransport;

  if (provider === 'resend') {
    const apiKey = cleanValue(process.env.RESEND_API_KEY);
    const from = safeSender(process.env.EMAIL_FROM);
    if (!apiKey || !from) return null;

    return {
      from,
      transporter: createTransport({
        host: 'smtp.resend.com',
        port: 465,
        secure: true,
        ...SMTP_TIMEOUTS,
        auth: { user: 'resend', pass: apiKey }
      })
    };
  }

  if (provider !== 'gmail') return null;

  const smtpUser = cleanValue(process.env.GMAIL_SMTP_USER).toLowerCase();
  const appPassword = cleanValue(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '');
  if (!smtpUser || !appPassword) return null;

  return {
    from: `RealView <${smtpUser}>`,
    transporter: createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      ...SMTP_TIMEOUTS,
      auth: { user: smtpUser, pass: appPassword }
    })
  };
}

export const emailTransportInternals = { SMTP_TIMEOUTS, safeSender };

