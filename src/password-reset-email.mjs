import { createEmailTransport } from './email-transport.mjs';
import { emailBrandingUrls, emailLayoutStart, emailSocialFooter } from './email-branding.mjs';

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
      'Mã có hiệu lực trong 10 phút và chỉ sử dụng được một lần. Hãy nhập mã vào màn hình đặt lại mật khẩu trên RealView.',
      'RealView sẽ không bao giờ yêu cầu bạn chia sẻ mã này qua điện thoại, tin nhắn hoặc mạng xã hội.',
      'Nếu bạn không yêu cầu thay đổi mật khẩu, hãy bỏ qua email này.',
      '',
      'Đội ngũ RealView'
    ].join('\n'),
    html: `${emailLayoutStart('Mã đặt lại mật khẩu RealView có hiệu lực trong 10 phút.', 600)}
          <tr><td style="padding:22px 24px 8px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eeeeec" style="width:100%;border-radius:18px;background:#eeeeec;border-collapse:separate;">
              <tr>
                <td class="email-hero-mascot" width="132" align="center" valign="bottom" style="width:132px;padding:10px 0 0 10px;vertical-align:bottom;"><img src="${emailBrandingUrls.mascotVerification}" width="112" height="142" alt="Mascot RealView nhắc bạn bảo vệ tài khoản" style="display:block;width:112px;height:auto;max-width:100%;border:0;"></td>
                <td class="email-hero-copy" valign="middle" style="padding:18px 16px 18px 10px;vertical-align:middle;">
                  <span style="display:inline-block;margin:0 0 10px;padding:7px 11px;border-radius:999px;background:#fff0e5;color:#a84400;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:0;">Bảo vệ tài khoản</span>
                  <h1 style="margin:0 0 8px;color:#171717;font-size:22px;line-height:1.2;">Đặt lại mật khẩu</h1>
                  <p style="margin:0;color:#55554f;font-size:13px;line-height:1.5;">Dùng mã bảo mật này để tạo mật khẩu mới.</p>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td class="email-content" style="padding:17px 28px 27px;">
            <p style="margin:0 0 13px;color:#30302d;font-size:15px;line-height:1.6;">Bạn vừa yêu cầu đặt lại mật khẩu RealView. Nhập mã sau tại màn hình đang mở:</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#fff7f1" style="width:100%;border:1px solid #ffc79f;border-radius:16px;background:#fff7f1;border-collapse:separate;"><tr><td align="center" style="padding:19px 12px;color:#171717;font-size:34px;line-height:1.1;font-weight:900;letter-spacing:9px;">${code}</td></tr></table>
            <p style="margin:17px 0 0;color:#55554f;font-size:14px;line-height:1.6;"><strong>Mã có hiệu lực trong 10 phút</strong> và chỉ sử dụng được một lần.</p>
            <p style="margin:10px 0 0;padding:12px 13px;border-radius:12px;background:#f7f6f2;color:#686862;font-size:13px;line-height:1.55;">Không chia sẻ mã này với bất kỳ ai. Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này — mật khẩu hiện tại của bạn sẽ không thay đổi.</p>
            <p style="margin:19px 0 0;color:#4f4f4a;font-size:14px;line-height:1.6;">Trân trọng,<br><strong style="color:#171717;">Đội ngũ RealView</strong></p>
          </td></tr>
          ${emailSocialFooter()}`
  };
}

export async function sendPasswordResetEmail(user, code, options = {}) {
  const recipient = String(user?.email || '').trim().toLowerCase();
  if (!recipient) return { delivered: false, reason: 'missing_recipient' };

  const emailTransport = createEmailTransport(options);
  if (!emailTransport) return { delivered: false, reason: 'not_configured' };
  const info = await emailTransport.transporter.sendMail({
    from: emailTransport.from,
    to: recipient,
    ...passwordResetEmailContent(code)
  });
  return { delivered: true, messageId: String(info?.messageId || '') };
}

export const passwordResetEmailInternals = { safeCode, passwordResetEmailContent };

