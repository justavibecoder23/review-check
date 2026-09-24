import { createEmailTransport } from './email-transport.mjs';
import { emailBrandingUrls } from './email-branding.mjs';
import { welcomeTemplateHtml } from './email-templates-html.mjs';

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
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
}

function welcomeEmailContent(user) {
  const username = safeDisplayName(user?.username) || 'bạn';
  const escapedUsername = escapeHtml(username);
  const subject = 'Chào mừng bạn đến với RealView';
  const text = [
    `Xin chào ${username},`,
    '',
    'Tài khoản RealView của bạn đã sẵn sàng. Cảm ơn bạn đã đồng hành cùng chúng tôi.',
    '',
    'RealView giúp bạn nhìn nhanh hơn vào trải nghiệm mua hàng thực tế: tổng hợp review công khai, lọc phản hồi ít thông tin và làm nổi bật những điểm người mua nhắc lại.',
    '',
    'Bạn có thể phân tích sản phẩm Shopee và TikTok Shop, xem tóm tắt ưu/nhược điểm, TrustScore phản ánh độ tin cậy của tập review và lưu lại lịch sử phân tích để xem sau.',
    '',
    `Bắt đầu khám phá: ${REALVIEW_HOME_URL}`,
    '',
    'Hãy dùng kết quả như một góc nhìn tham khảo và cân nhắc cùng nhu cầu của bạn trước khi mua.',
    '',
    'Chúc bạn có những trải nghiệm thật tuyệt vời cùng RealView và luôn đưa ra quyết định mua sắm đúng đắn nhất.',
    '',
    'Trân trọng,',
    'Đội ngũ RealView',
    'Góc nhìn thật, lựa chọn đúng.'
  ].join('\n');

  const html = welcomeTemplateHtml.replaceAll('{{USER_NAME}}', escapedUsername);

  return { subject, text, html };
}

export async function sendWelcomeEmail(user, options = {}) {
  const recipient = String(user?.email || '').trim().toLowerCase();
  if (!recipient) return { delivered: false, reason: 'missing_recipient' };

  const emailTransport = createEmailTransport(options);
  if (!emailTransport) return { delivered: false, reason: 'not_configured' };
  const content = welcomeEmailContent(user);
  const info = await emailTransport.transporter.sendMail({
    from: emailTransport.from,
    to: recipient,
    ...content
  });

  return { delivered: true, messageId: String(info?.messageId || '') };
}

export const welcomeEmailInternals = { REALVIEW_HOME_URL, escapeHtml, welcomeEmailContent };

