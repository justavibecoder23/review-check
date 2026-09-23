import { createEmailTransport } from './email-transport.mjs';
import { emailBrandingUrls, emailLayoutStart, emailSocialFooter } from './email-branding.mjs';

function verificationEmailContent(codeValue, purposeValue) {
  const code = String(codeValue || '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error('Mã xác minh email không hợp lệ.');
  const purpose = purposeValue === 'contact' ? 'gửi liên hệ' : 'tạo tài khoản';
  return {
    subject: `Mã xác minh ${purpose} RealView`,
    text: [
      `Bạn vừa yêu cầu ${purpose} trên RealView.`,
      '',
      `Mã xác minh của bạn: ${code}`,
      '',
      'Mã có hiệu lực trong 10 phút và chỉ sử dụng được một lần. Hãy nhập mã này vào màn hình xác minh đang mở trên RealView.',
      'RealView sẽ không bao giờ yêu cầu bạn chia sẻ mã này qua điện thoại, tin nhắn hoặc mạng xã hội.',
      'Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email.',
      '',
      'Đội ngũ RealView'
    ].join('\n'),
    html: `${emailLayoutStart('Mã xác minh RealView có hiệu lực trong 10 phút và chỉ dùng được một lần.', 600)}
          <tr><td style="padding:22px 24px 8px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eeeeec" style="width:100%;border-radius:18px;background:#eeeeec;border-collapse:separate;">
              <tr>
                <td class="email-hero-mascot" width="132" align="center" valign="bottom" style="width:132px;padding:10px 0 0 10px;vertical-align:bottom;"><img src="${emailBrandingUrls.mascotVerification}" width="112" height="142" alt="Mascot RealView hướng dẫn xác minh an toàn" style="display:block;width:112px;height:auto;max-width:100%;border:0;"></td>
                <td class="email-hero-copy" valign="middle" style="padding:18px 16px 18px 10px;vertical-align:middle;">
                  <span style="display:inline-block;margin:0 0 10px;padding:7px 11px;border-radius:999px;background:#fff0e5;color:#a84400;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:0;">Mã xác minh email</span>
                  <h1 style="margin:0 0 8px;color:#171717;font-size:22px;line-height:1.2;">Xác minh để ${purpose}</h1>
                  <p style="margin:0;color:#55554f;font-size:13px;line-height:1.5;">Nhập mã này vào màn hình xác minh đang mở trên RealView.</p>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td class="email-content" style="padding:17px 28px 27px;">
            <p style="margin:0 0 13px;color:#30302d;font-size:15px;line-height:1.6;">Bạn vừa yêu cầu <strong>${purpose}</strong> trên RealView. Mã xác minh của bạn:</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#fff7f1" style="width:100%;border:1px solid #ffc79f;border-radius:16px;background:#fff7f1;border-collapse:separate;"><tr><td align="center" style="padding:19px 12px;color:#171717;font-size:34px;line-height:1.1;font-weight:900;letter-spacing:9px;">${code}</td></tr></table>
            <p style="margin:17px 0 0;color:#55554f;font-size:14px;line-height:1.6;"><strong>Mã có hiệu lực trong 10 phút</strong> và chỉ sử dụng được một lần.</p>
            <p style="margin:10px 0 0;padding:12px 13px;border-radius:12px;background:#f7f6f2;color:#686862;font-size:13px;line-height:1.55;">Vì sự an toàn của bạn, không chia sẻ mã này với bất kỳ ai. Nếu bạn không thực hiện yêu cầu, hãy bỏ qua email này.</p>
            <p style="margin:19px 0 0;color:#4f4f4a;font-size:14px;line-height:1.6;">Trân trọng,<br><strong style="color:#171717;">Đội ngũ RealView</strong></p>
          </td></tr>
          ${emailSocialFooter()}`
  };
}

export async function sendEmailVerificationCode(recipientValue, code, purpose, options = {}) {
  const recipient = String(recipientValue || '').trim().toLowerCase();
  if (!recipient) return { delivered: false, reason: 'missing_recipient' };

  const emailTransport = createEmailTransport(options);
  if (!emailTransport) return { delivered: false, reason: 'not_configured' };
  const info = await emailTransport.transporter.sendMail({
    from: emailTransport.from,
    to: recipient,
    ...verificationEmailContent(code, purpose)
  });
  return { delivered: true, messageId: String(info?.messageId || '') };
}

export const emailVerificationMailInternals = { verificationEmailContent };
