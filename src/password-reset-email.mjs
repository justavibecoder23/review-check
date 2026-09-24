import { createEmailTransport } from './email-transport.mjs';
import { passwordResetTemplateHtml } from './email-templates-html.mjs';

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
    html: passwordResetTemplateHtml.replaceAll('{{VERIFICATION_CODE}}', code)
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

