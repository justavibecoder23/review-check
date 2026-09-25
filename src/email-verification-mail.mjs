import { createEmailTransport } from './email-transport.mjs';
import { verificationTemplateHtml } from './email-templates-html.mjs';
import { withTransactionalFooter } from './transactional-email-footer.mjs';

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
    html: withTransactionalFooter(verificationTemplateHtml, purposeValue === 'contact' ? 'contactVerification' : 'registration')
      .replaceAll('{{VERIFICATION_CODE}}', code)
      .replaceAll('{{PURPOSE}}', purpose)
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
