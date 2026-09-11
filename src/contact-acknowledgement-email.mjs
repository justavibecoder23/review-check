import nodemailer from 'nodemailer';

const CONTACT_ACKNOWLEDGEMENT_SUBJECT = '[Tự động] Xác nhận yêu cầu liên hệ – RealView';
const REALVIEW_WEBSITE_URL = 'https://realview.com.vn/';
const REALVIEW_HOME_URL = 'https://www.realview.com.vn/';
const REALVIEW_FACEBOOK_URL = 'https://www.facebook.com/profile.php?id=61594093477895';
const REALVIEW_TIKTOK_URL = 'https://www.tiktok.com/@realviewueh';
const FACEBOOK_LOGO_URL = 'https://img.icons8.com/color/48/facebook-new.png';
const TIKTOK_LOGO_URL = 'https://img.icons8.com/color/48/tiktok--v1.png';

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeDisplayName(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
}

function contactAcknowledgementEmailContent(record = {}) {
  const displayName = safeDisplayName(record.name) || 'bạn';
  const escapedDisplayName = escapeHtml(displayName);
  const text = [
    `Chào ${displayName},`,
    '',
    'Cảm ơn bạn đã quan tâm và gửi email cho RealView. Hệ thống của chúng tôi xin xác nhận đã nhận được yêu cầu liên hệ của bạn.',
    '',
    'Đội ngũ phát triển đang tiến hành xem xét nội dung và sẽ nỗ lực phản hồi đến bạn trong thời gian sớm nhất.',
    '',
    'Trong lúc chờ đợi, bạn có thể trải nghiệm các tính năng hoặc tìm hiểu thêm về dự án thông qua các kênh thông tin chính thức bên dưới.',
    '',
    `Khám phá RealView: ${REALVIEW_HOME_URL}`,
    '',
    'Chúc bạn một ngày tốt lành!',
    '',
    'Trân trọng,',
    '',
    'ĐỘI NGŨ REALVIEW',
    'RealView - Một dự án tích hợp AI, hỗ trợ người dùng trong quyết định mua sắm online.',
    'Dự án thuộc khuôn khổ môn học Digital Marketing - Nhóm Sinh viên Đại học Kinh tế TP.HCM (UEH)',
    '',
    '🌐 Website: realview.com.vn',
    '📧 Email: realviewueh@gmail.com',
    '📞 Hotline: 037 712 0633',
    '📘 Facebook: RealView - Tổng hợp và đánh giá reviews',
    '🎵 TikTok: @realviewueh'
  ].join('\n');

  const html = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${CONTACT_ACKNOWLEDGEMENT_SUBJECT}</title>
  </head>
  <body bgcolor="#f4f3ef" style="margin:0;padding:0;background:#f4f3ef;color:#171717;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f3ef" style="width:100%;background:#f4f3ef;border-collapse:collapse;">
      <tr>
        <td align="center" bgcolor="#f4f3ef" style="padding:28px 12px;background:#f4f3ef;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e4e1da;border-radius:24px;border-collapse:separate;overflow:hidden;">
            <tr>
              <td style="padding:25px 32px;background:#171717;color:#ffffff;font-size:22px;line-height:1.25;font-weight:800;letter-spacing:.2px;">
                <span style="color:#ff7a1a;">REAL</span>VIEW
              </td>
            </tr>
            <tr>
              <td style="padding:38px 32px 34px;">
                <p style="margin:0 0 22px;font-size:16px;line-height:1.65;color:#171717;font-weight:400;">Chào <strong style="color:#171717;font-weight:700;">${escapedDisplayName}</strong>,</p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#171717;font-weight:400;">Cảm ơn bạn đã quan tâm và gửi email cho RealView. Hệ thống của chúng tôi xin xác nhận đã nhận được yêu cầu liên hệ của bạn.</p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#171717;font-weight:400;">Đội ngũ phát triển đang tiến hành xem xét nội dung và sẽ nỗ lực phản hồi đến bạn trong thời gian sớm nhất.</p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#171717;font-weight:400;">Trong lúc chờ đợi, bạn có thể trải nghiệm các tính năng hoặc tìm hiểu thêm về dự án thông qua các kênh thông tin chính thức bên dưới.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 24px;border-collapse:collapse;">
                  <tr>
                    <td align="center">
                      <a href="${REALVIEW_HOME_URL}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 24px;border-radius:999px;background:#ff7a1a;color:#171717;font-size:15px;line-height:1.2;font-weight:800;text-decoration:none;">Khám phá RealView</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 24px;font-size:16px;line-height:1.65;color:#171717;font-weight:400;">Chúc bạn một ngày tốt lành!</p>
                <p style="margin:0;font-size:16px;line-height:1.65;color:#171717;font-weight:400;">Trân trọng,</p>
              </td>
            </tr>
            <tr>
              <td style="padding:26px 32px 30px;background:#faf9f6;border-top:1px solid #e0e0e0;">
                <p style="margin:0 0 6px;color:#171717;font-size:15px;line-height:1.5;font-weight:800;">ĐỘI NGŨ REALVIEW</p>
                <p style="margin:0 0 5px;color:#4f4f4a;font-size:14px;line-height:1.6;">RealView - Một dự án tích hợp AI, hỗ trợ người dùng trong quyết định mua sắm online.</p>
                <p style="margin:0 0 22px;color:#686862;font-size:13px;line-height:1.6;font-style:italic;">Dự án thuộc khuôn khổ môn học Digital Marketing - Nhóm Sinh viên Đại học Kinh tế TP.HCM (UEH)</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">
                  <tr>
                    <td width="26" valign="middle" style="width:26px;padding:0 0 9px;text-align:center;vertical-align:middle;"><span style="display:inline-block;width:18px;height:18px;font-size:16px;line-height:18px;text-align:center;vertical-align:middle;">🌐</span></td>
                    <td valign="middle" style="padding:0 0 9px 8px;color:#4f4f4a;font-size:14px;line-height:1.55;vertical-align:middle;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#171717;">Website:</strong> <a href="${REALVIEW_WEBSITE_URL}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:4px 0;color:#a84400;text-decoration:none;">realview.com.vn</a></td>
                  </tr>
                  <tr>
                    <td width="26" valign="middle" style="width:26px;padding:0 0 9px;text-align:center;vertical-align:middle;"><span style="display:inline-block;width:18px;height:18px;font-size:16px;line-height:18px;text-align:center;vertical-align:middle;">📧</span></td>
                    <td valign="middle" style="padding:0 0 9px 8px;color:#4f4f4a;font-size:14px;line-height:1.55;vertical-align:middle;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#171717;">Email:</strong> <a href="mailto:realviewueh@gmail.com" style="display:inline-block;padding:4px 0;color:#a84400;text-decoration:none;">realviewueh@gmail.com</a></td>
                  </tr>
                  <tr>
                    <td width="26" valign="middle" style="width:26px;padding:0 0 9px;text-align:center;vertical-align:middle;"><span style="display:inline-block;width:18px;height:18px;font-size:16px;line-height:18px;text-align:center;vertical-align:middle;">📞</span></td>
                    <td valign="middle" style="padding:0 0 9px 8px;color:#4f4f4a;font-size:14px;line-height:1.55;vertical-align:middle;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#171717;">Hotline:</strong> <a href="tel:+84377120633" style="display:inline-block;padding:4px 0;color:#a84400;text-decoration:none;">037 712 0633</a></td>
                  </tr>
                  <tr>
                    <td width="26" valign="middle" style="width:26px;padding:0 0 9px;text-align:center;vertical-align:middle;"><img src="${FACEBOOK_LOGO_URL}" alt="" width="18" height="18" style="display:inline-block;width:18px;height:18px;margin:0;border:0;outline:none;vertical-align:middle;"></td>
                    <td valign="middle" style="padding:0 0 9px 8px;color:#4f4f4a;font-size:14px;line-height:1.55;vertical-align:middle;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#171717;">Facebook:</strong> <a href="${REALVIEW_FACEBOOK_URL}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:4px 0;color:#a84400;text-decoration:none;">RealView - Tổng hợp và đánh giá reviews</a></td>
                  </tr>
                  <tr>
                    <td width="26" valign="middle" style="width:26px;padding:0;text-align:center;vertical-align:middle;"><img src="${TIKTOK_LOGO_URL}" alt="" width="18" height="18" style="display:inline-block;width:18px;height:18px;margin:0;border:0;outline:none;vertical-align:middle;"></td>
                    <td valign="middle" style="padding:0 0 0 8px;color:#4f4f4a;font-size:14px;line-height:1.55;vertical-align:middle;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#171717;">TikTok:</strong> <a href="${REALVIEW_TIKTOK_URL}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:4px 0;color:#a84400;text-decoration:none;">@realviewueh</a></td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: CONTACT_ACKNOWLEDGEMENT_SUBJECT, text, html };
}

export async function sendContactAcknowledgementEmail(record, options = {}) {
  const smtpUser = String(process.env.GMAIL_SMTP_USER || '').trim().toLowerCase();
  const appPassword = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const recipient = String(record?.email || '').trim().toLowerCase();
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
    ...contactAcknowledgementEmailContent(record)
  });

  return { delivered: true, messageId: String(info?.messageId || '') };
}

export const contactAcknowledgementEmailInternals = {
  CONTACT_ACKNOWLEDGEMENT_SUBJECT,
  REALVIEW_WEBSITE_URL,
  REALVIEW_HOME_URL,
  REALVIEW_FACEBOOK_URL,
  REALVIEW_TIKTOK_URL,
  FACEBOOK_LOGO_URL,
  TIKTOK_LOGO_URL,
  escapeHtml,
  safeDisplayName,
  contactAcknowledgementEmailContent
};
