import { createEmailTransport } from './email-transport.mjs';
import { emailBrandingUrls } from './email-branding.mjs';
import { contactAcknowledgementTemplateHtml } from './email-templates-html.mjs';
import { withTransactionalFooter } from './transactional-email-footer.mjs';

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

  const html = withTransactionalFooter(contactAcknowledgementTemplateHtml, 'contact')
    .replaceAll('{{USER_NAME}}', escapedDisplayName);

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
