import { createEmailTransport } from './email-transport.mjs';
import { emailBrandingUrls, emailLayoutStart, emailSocialFooter } from './email-branding.mjs';

const CONTACT_ACKNOWLEDGEMENT_SUBJECT = '[Tự động] Xác nhận yêu cầu liên hệ – RealView';
const REALVIEW_HOME_URL = emailBrandingUrls.home;

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
    'Đội ngũ RealView đã nhận được nội dung và sẽ xem xét để phản hồi bạn sớm nhất có thể. Nếu cần bổ sung thông tin, bạn có thể trả lời trực tiếp email này.',
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
    `Facebook: ${emailBrandingUrls.facebook}`,
    `TikTok: ${emailBrandingUrls.tiktok}`,
    `Threads: ${emailBrandingUrls.threads}`
  ].join('\n');

  const html = `${emailLayoutStart('RealView đã nhận được yêu cầu liên hệ của bạn và sẽ phản hồi sớm nhất có thể.', 600)}
          <tr><td style="padding:22px 24px 8px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eeeeec" style="width:100%;border-radius:18px;background:#eeeeec;border-collapse:separate;">
              <tr>
                <td class="email-hero-mascot" width="132" align="center" valign="bottom" style="width:132px;padding:10px 0 0 10px;vertical-align:bottom;"><img src="${emailBrandingUrls.mascotWelcome}" width="112" height="142" alt="Mascot RealView xác nhận đã nhận được yêu cầu" style="display:block;width:112px;height:auto;max-width:100%;border:0;"></td>
                <td class="email-hero-copy" valign="middle" style="padding:18px 16px 18px 10px;vertical-align:middle;">
                  <span style="display:inline-block;margin:0 0 10px;padding:7px 11px;border-radius:999px;background:#fff0e5;color:#a84400;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:0;">Đã nhận được yêu cầu</span>
                  <h1 style="margin:0 0 8px;color:#171717;font-size:22px;line-height:1.2;">Cảm ơn bạn đã liên hệ!</h1>
                  <p style="margin:0;color:#55554f;font-size:13px;line-height:1.5;">Yêu cầu của bạn đã đến đúng nơi.</p>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td class="email-content" style="padding:17px 28px 26px;">
            <p style="margin:0 0 15px;color:#30302d;font-size:15px;line-height:1.65;">Chào <strong>${escapedDisplayName}</strong>, cảm ơn bạn đã quan tâm và gửi lời nhắn đến RealView. Hệ thống đã ghi nhận yêu cầu liên hệ của bạn.</p>
            <p style="margin:0 0 15px;color:#30302d;font-size:15px;line-height:1.65;">Đội ngũ đang xem xét nội dung và sẽ phản hồi sớm nhất có thể. Nếu bạn cần bổ sung chi tiết, chỉ cần trả lời trực tiếp email này.</p>
            <p style="margin:0 0 21px;padding:13px 15px;border-left:3px solid #f05b16;background:#fff8f2;color:#55554f;font-size:14px;line-height:1.6;">Trong lúc chờ phản hồi, bạn có thể khám phá cách RealView tổng hợp review và hỗ trợ người mua cân nhắc sản phẩm.</p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 20px;"><tr><td align="center" bgcolor="#f05b16" style="border-radius:999px;background:#f05b16;"><a href="${REALVIEW_HOME_URL}" target="_blank" style="display:inline-block;padding:13px 23px;border-radius:999px;color:#ffffff;font-size:14px;line-height:1.2;font-weight:800;text-decoration:none;">Khám phá RealView&nbsp; →</a></td></tr></table>
            <p style="margin:0;color:#4f4f4a;font-size:14px;line-height:1.6;">Chúc bạn một ngày tốt lành!<br><strong style="color:#171717;">Đội ngũ RealView</strong></p>
          </td></tr>
          <tr><td bgcolor="#f3f5fc" style="padding:20px 27px;background:#f3f5fc;border-top:1px solid #dfe4ef;">
            <p style="margin:0 0 5px;color:#171717;font-size:14px;line-height:1.5;font-weight:800;">VỀ REALVIEW</p>
            <p style="margin:0 0 13px;color:#686862;font-size:12px;line-height:1.6;">Một dự án tích hợp AI, hỗ trợ người dùng trong quyết định mua sắm online.</p>
          </td></tr>
          ${emailSocialFooter()}`;

  return { subject: CONTACT_ACKNOWLEDGEMENT_SUBJECT, text, html };
}

export async function sendContactAcknowledgementEmail(record, options = {}) {
  const recipient = String(record?.email || '').trim().toLowerCase();
  if (!recipient) return { delivered: false, reason: 'missing_recipient' };

  const emailTransport = createEmailTransport(options);
  if (!emailTransport) return { delivered: false, reason: 'not_configured' };
  const info = await emailTransport.transporter.sendMail({
    from: emailTransport.from,
    to: recipient,
    ...contactAcknowledgementEmailContent(record)
  });

  return { delivered: true, messageId: String(info?.messageId || '') };
}

export const contactAcknowledgementEmailInternals = {
  CONTACT_ACKNOWLEDGEMENT_SUBJECT,
  REALVIEW_HOME_URL,
  emailBrandingUrls,
  escapeHtml,
  safeDisplayName,
  contactAcknowledgementEmailContent
};
