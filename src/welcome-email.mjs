import nodemailer from 'nodemailer';

const REALVIEW_HOME_URL = 'https://www.realview.com.vn/';

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeDisplayName(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
}

function welcomeEmailContent(user) {
  const username = safeDisplayName(user?.username) || 'bạn';
  const escapedUsername = escapeHtml(username);
  const subject = 'Chào mừng bạn đến với RealView';
  const text = [
    `Xin chào ${username},`,
    '',
    'Tài khoản RealView của bạn đã được tạo thành công.',
    '',
    'Từ bây giờ, bạn có thể lưu lịch sử phân tích, xem lại kết quả cũ và quản lý các sản phẩm đã kiểm tra thuận tiện hơn.',
    '',
    `Khám phá RealView: ${REALVIEW_HOME_URL}`,
    '',
    'RealView giúp bạn tổng hợp đánh giá công khai, lọc nội dung ít giá trị và nhận diện những điểm đáng cân nhắc trước khi mua hàng.',
    '',
    'Chúc bạn có những trải nghiệm thật tuyệt vời cùng RealView và luôn đưa ra quyết định mua sắm đúng đắn nhất.',
    '',
    'Trân trọng,',
    'Đội ngũ RealView',
    'Góc nhìn thật, lựa chọn đúng.'
  ].join('\n');

  const html = `<!doctype html>
<html lang="vi">
  <body style="margin:0;padding:0;background:#f4f3ef;color:#171717;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Tài khoản của bạn đã được tạo thành công.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ef;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e4e1da;border-radius:24px;overflow:hidden;">
            <tr>
              <td style="padding:26px 34px;background:#171717;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:.2px;">
                <span style="color:#ff7a1a;">REAL</span>VIEW
              </td>
            </tr>
            <tr>
              <td style="padding:40px 34px 36px;">
                <div style="display:inline-block;margin-bottom:18px;padding:8px 13px;border-radius:999px;background:#fff0e5;color:#a84400;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;">Tài khoản đã sẵn sàng</div>
                <h1 style="margin:0 0 22px;font-size:32px;line-height:1.18;color:#171717;">Chào mừng bạn đến với RealView!</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.65;">Xin chào <strong>${escapedUsername}</strong>,</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.65;">Tài khoản RealView của bạn đã được tạo thành công.</p>
                <p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#4f4f4a;">Từ bây giờ, bạn có thể lưu lịch sử phân tích, xem lại kết quả cũ và quản lý các sản phẩm đã kiểm tra thuận tiện hơn.</p>
                <a href="${REALVIEW_HOME_URL}" style="display:inline-block;padding:14px 24px;border-radius:999px;background:#ff7a1a;color:#171717;font-size:15px;font-weight:800;text-decoration:none;">Khám phá RealView</a>
                <div style="height:1px;margin:30px 0;background:#ece9e2;"></div>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#4f4f4a;">RealView giúp bạn tổng hợp đánh giá công khai, lọc nội dung ít giá trị và nhận diện những điểm đáng cân nhắc trước khi mua hàng.</p>
                <p style="margin:0;font-size:16px;line-height:1.65;font-weight:700;">Chúc bạn có những trải nghiệm thật tuyệt vời cùng RealView và luôn đưa ra quyết định mua sắm đúng đắn nhất.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 34px;background:#faf9f6;color:#686862;font-size:13px;line-height:1.6;">
                Trân trọng,<br><strong style="color:#171717;">Đội ngũ RealView</strong><br>Góc nhìn thật, lựa chọn đúng.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

export async function sendWelcomeEmail(user, options = {}) {
  const smtpUser = String(process.env.GMAIL_SMTP_USER || '').trim().toLowerCase();
  const appPassword = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!smtpUser || !appPassword) return { delivered: false, reason: 'not_configured' };

  const recipient = String(user?.email || '').trim().toLowerCase();
  if (!recipient) return { delivered: false, reason: 'missing_recipient' };

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
    }
  });
  const content = welcomeEmailContent(user);
  const info = await transporter.sendMail({
    from: `RealView <${smtpUser}>`,
    to: recipient,
    ...content
  });

  return { delivered: true, messageId: String(info?.messageId || '') };
}

export const welcomeEmailInternals = { REALVIEW_HOME_URL, escapeHtml, welcomeEmailContent };

