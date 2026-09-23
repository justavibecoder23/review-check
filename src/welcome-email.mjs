import { createEmailTransport } from './email-transport.mjs';
import { emailBrandingUrls, emailLayoutStart, emailSocialFooter } from './email-branding.mjs';

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

  const html = `${emailLayoutStart('Tài khoản RealView của bạn đã sẵn sàng — khám phá cách đọc review nhanh và rõ hơn.')}
          <tr><td style="padding:22px 24px 8px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eeeeec" style="width:100%;border-radius:18px;background:#eeeeec;border-collapse:separate;">
              <tr>
                <td class="email-hero-mascot" width="150" align="center" valign="bottom" style="width:150px;padding:12px 0 0 12px;vertical-align:bottom;"><img src="${emailBrandingUrls.mascotWelcome}" width="126" height="160" alt="Mascot RealView chào mừng bạn" style="display:block;width:126px;height:auto;max-width:100%;border:0;"></td>
                <td class="email-hero-copy" valign="middle" style="padding:22px 19px 22px 12px;vertical-align:middle;">
                  <span style="display:inline-block;margin:0 0 12px;padding:7px 11px;border-radius:999px;background:#fff0e5;color:#a84400;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:0;">Tài khoản đã sẵn sàng</span>
                  <h1 style="margin:0 0 12px;color:#171717;font-size:25px;line-height:1.16;">Chào mừng đến với RealView!</h1>
                  <p style="margin:0;color:#4f4f4a;font-size:14px;line-height:1.55;">Xin chào <strong>${escapedUsername}</strong>, hành trình mua sắm với góc nhìn rõ hơn bắt đầu từ đây.</p>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td class="email-content" style="padding:18px 28px 28px;">
            <p style="margin:0 0 15px;color:#30302d;font-size:15px;line-height:1.65;">RealView giúp bạn tiết kiệm thời gian đọc hàng trăm bình luận bằng cách tổng hợp review công khai, giảm nhiễu từ phản hồi ít thông tin và làm nổi bật những điểm được người mua nhắc lại.</p>
            <p style="margin:0 0 14px;color:#30302d;font-size:15px;line-height:1.65;">Bạn có thể dán link sản phẩm từ <strong>Shopee hoặc TikTok Shop</strong> để xem tóm tắt ưu, nhược điểm, phân tích review bằng AI và TrustScore — điểm phản ánh độ tin cậy của tập review, không phải chất lượng sản phẩm.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 23px;border-collapse:separate;">
              <tr><td style="padding:12px 13px;border-left:3px solid #f05b16;background:#fff8f2;color:#4f4f4a;font-size:13px;line-height:1.55;"><strong style="color:#171717;">Phân tích rõ ràng</strong><br>Nhìn nhanh các nhược điểm nổi bật và tín hiệu cần cân nhắc.</td></tr>
              <tr><td height="8" style="height:8px;font-size:1px;line-height:1px;">&nbsp;</td></tr>
              <tr><td style="padding:12px 13px;border-left:3px solid #f05b16;background:#fff8f2;color:#4f4f4a;font-size:13px;line-height:1.55;"><strong style="color:#171717;">Lưu để xem lại</strong><br>Lịch sử phân tích giúp bạn quay lại những sản phẩm đã kiểm tra.</td></tr>
              <tr><td height="8" style="height:8px;font-size:1px;line-height:1px;">&nbsp;</td></tr>
              <tr><td style="padding:12px 13px;border-left:3px solid #f05b16;background:#fff8f2;color:#4f4f4a;font-size:13px;line-height:1.55;"><strong style="color:#171717;">Đọc thêm kiến thức</strong><br>Blog RealView chia sẻ cách kiểm tra review và mua sắm tỉnh táo hơn.</td></tr>
            </table>
            <p style="margin:0 0 16px;color:#30302d;font-size:14px;line-height:1.65;">Ngoài trang phân tích sản phẩm, bạn có thể ghé <strong>Blog</strong> để đọc hướng dẫn mua sắm; xem <strong>Tiêu chí lọc</strong> để hiểu cách nhận diện những review hữu ích; hoặc vào trang <strong>Liên hệ</strong> để gửi câu hỏi và góp ý cho đội ngũ RealView.</p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 12px;"><tr><td align="center" bgcolor="#f05b16" style="border-radius:999px;background:#f05b16;"><a href="${REALVIEW_HOME_URL}" target="_blank" style="display:inline-block;padding:14px 26px;border-radius:999px;color:#ffffff;font-size:15px;line-height:1.2;font-weight:800;text-decoration:none;">Khám phá RealView&nbsp; →</a></td></tr></table>
            <p style="margin:18px 0 10px;text-align:center;color:#30302d;font-size:14px;line-height:1.5;font-weight:700;">Bạn cũng có thể khám phá:</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:410px;margin:0 auto 20px;border-collapse:separate;">
              <tr><td align="center" style="padding:5px;"><a href="${emailBrandingUrls.blog}" target="_blank" style="display:block;padding:11px 14px;border:1px solid #e3e5eb;border-radius:10px;background:#ffffff;color:#30354a;font-size:14px;line-height:1.3;font-weight:700;text-decoration:none;">Đọc Blog RealView&nbsp; →</a></td></tr>
              <tr><td align="center" style="padding:5px;"><a href="${emailBrandingUrls.criteria}" target="_blank" style="display:block;padding:11px 14px;border:1px solid #e3e5eb;border-radius:10px;background:#ffffff;color:#30354a;font-size:14px;line-height:1.3;font-weight:700;text-decoration:none;">Xem tiêu chí lọc&nbsp; →</a></td></tr>
              <tr><td align="center" style="padding:5px;"><a href="${emailBrandingUrls.contact}" target="_blank" style="display:block;padding:11px 14px;border:1px solid #e3e5eb;border-radius:10px;background:#ffffff;color:#30354a;font-size:14px;line-height:1.3;font-weight:700;text-decoration:none;">Liên hệ RealView&nbsp; →</a></td></tr>
            </table>
            <p style="margin:0;text-align:center;color:#777770;font-size:12px;line-height:1.6;">Kết quả là góc nhìn tham khảo — hãy cân nhắc cùng nhu cầu của bạn trước khi mua.</p>
            <p style="margin:19px 0 0;color:#4f4f4a;font-size:14px;line-height:1.6;">Chúc bạn có những trải nghiệm thật tuyệt vời cùng RealView và luôn đưa ra quyết định mua sắm đúng đắn nhất.<br><strong style="color:#171717;">Đội ngũ RealView</strong></p>
          </td></tr>
          ${emailSocialFooter()}`;

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

