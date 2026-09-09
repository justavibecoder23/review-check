import nodemailer from 'nodemailer';

function safeCode(value) {
  const code = String(value || '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error('Mã đặt lại mật khẩu không hợp lệ.');
  return code;
}

function passwordResetEmailContent(codeValue) {
  const code = safeCode(codeValue);
  return {
    subject: 'Mã xác minh đặt lại mật khẩu RealView',
    text: [
      'Bạn vừa yêu cầu đặt lại mật khẩu RealView.',
      '',
      `Mã xác minh của bạn: ${code}`,
      '',
      'Mã có hiệu lực trong 10 phút và chỉ sử dụng được một lần.',
      'Nếu bạn không yêu cầu thay đổi mật khẩu, hãy bỏ qua email này.',
      '',
      'Đội ngũ RealView'
    ].join('\n'),
    html: `<!doctype html>
<html lang="vi">
  <body style="margin:0;padding:0;background:#f4f3ef;color:#171717;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Mã xác minh RealView có hiệu lực trong 10 phút.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ef;padding:28px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #e4e1da;border-radius:24px;overflow:hidden;">
          <tr><td style="padding:25px 32px;background:#171717;color:#fff;font-size:22px;font-weight:800;"><span style="color:#ff7a1a;">REAL</span>VIEW</td></tr>
          <tr><td style="padding:38px 32px;">
            <div style="display:inline-block;margin-bottom:16px;padding:8px 13px;border-radius:999px;background:#fff0e5;color:#a84400;font-size:12px;font-weight:700;letter-spacing:.7px;">XÁC MINH TÀI KHOẢN</div>
            <h1 style="margin:0 0 14px;font-size:29px;line-height:1.2;">Đặt lại mật khẩu</h1>
            <p style="margin:0 0 24px;color:#55554f;font-size:16px;line-height:1.6;">Nhập mã dưới đây tại RealView để tạo mật khẩu mới.</p>
            <div style="padding:18px;border:1px solid #ffc79f;border-radius:16px;background:#fff7f1;color:#171717;font-size:34px;font-weight:900;letter-spacing:10px;text-align:center;">${code}</div>
            <p style="margin:22px 0 0;color:#686862;font-size:14px;line-height:1.6;">Mã có hiệu lực trong 10 phút và chỉ sử dụng được một lần.</p>
            <p style="margin:10px 0 0;color:#686862;font-size:14px;line-height:1.6;">Nếu bạn không yêu cầu thay đổi mật khẩu, hãy bỏ qua email này.</p>
          </td></tr>
          <tr><td style="padding:22px 32px;background:#faf9f6;color:#686862;font-size:13px;line-height:1.6;">Trân trọng,<br><strong style="color:#171717;">Đội ngũ RealView</strong></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
  };
}

export async function sendPasswordResetEmail(user, code, options = {}) {
  const smtpUser = String(process.env.GMAIL_SMTP_USER || '').trim().toLowerCase();
  const appPassword = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const recipient = String(user?.email || '').trim().toLowerCase();
  if (!smtpUser || !appPassword) return { delivered: false, reason: 'not_configured' };
  if (!recipient) return { delivered: false, reason: 'missing_recipient' };

  const createTransport = options.createTransportImpl || nodemailer.createTransport;
  const transporter = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    connectionTimeout: 6_000,
    greetingTimeout: 6_000,
    socketTimeout: 10_000,
    auth: { user: smtpUser, pass: appPassword }
  });
  const info = await transporter.sendMail({
    from: `RealView <${smtpUser}>`,
    to: recipient,
    ...passwordResetEmailContent(code)
  });
  return { delivered: true, messageId: String(info?.messageId || '') };
}

export const passwordResetEmailInternals = { safeCode, passwordResetEmailContent };

