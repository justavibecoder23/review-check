import { emailBrandingUrls } from './email-branding.mjs';

const FOOTER_BACKGROUND = '#f5f1eb';
const FOOTER_MARKER = 'background-color:#ede9e2';
const CONTACT_EMAIL = 'realviewueh@gmail.com';

const reasons = Object.freeze({
  welcome: 'Bạn nhận email này vì đã tạo tài khoản RealView.',
  registration: 'Bạn nhận email này vì đã yêu cầu mã xác minh để tạo tài khoản RealView.',
  contactVerification: 'Bạn nhận email này vì đã yêu cầu mã xác minh để gửi liên hệ RealView.',
  contact: 'Bạn nhận email này vì đã gửi lời nhắn đến RealView.',
  passwordReset: 'Bạn nhận email này vì đã yêu cầu đặt lại mật khẩu RealView.'
});

function footerHtml(reason) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${FOOTER_BACKGROUND}" style="width:100%;border-collapse:collapse;background-color:${FOOTER_BACKGROUND};">
    <tbody>
      <tr><td style="padding:35px 39px 27px;background-color:${FOOTER_BACKGROUND};">
        <h2 style="margin:0 0 10px;color:#24262a;font-family:Arial,Helvetica,sans-serif;font-size:17px;line-height:1.3;font-weight:800;letter-spacing:0.1px;">ĐỘI NGŨ REALVIEW</h2>
        <p style="margin:0 0 7px;color:#43464b;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">RealView - Một dự án tích hợp AI, hỗ trợ người dùng trong quyết định mua sắm online.</p>
        <p style="margin:0 0 22px;color:#616267;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;font-style:italic;">Dự án thuộc khuôn khổ môn học Digital Marketing - Nhóm Sinh viên Đại học Kinh tế TP.HCM (UEH)</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr><td style="padding:0 0 10px;color:#24262a;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;overflow-wrap:anywhere;"><strong>Website:</strong> <a href="${emailBrandingUrls.home}" style="color:#994013;text-decoration:underline;">RealView | Góc nhìn thật, lựa chọn đúng</a></td></tr>
          <tr><td style="padding:0 0 10px;color:#24262a;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;overflow-wrap:anywhere;"><strong>Email:</strong> <a href="mailto:${CONTACT_EMAIL}" style="color:#994013;text-decoration:underline;">${CONTACT_EMAIL}</a></td></tr>
          <tr><td style="padding:0 0 9px;color:#24262a;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;overflow-wrap:anywhere;"><a href="${emailBrandingUrls.facebook}" style="color:#24262a;text-decoration:none;"><img src="https://www.realview.com.vn/assets/email/facebook-icon.png" width="24" height="24" alt="" style="display:inline-block;width:24px;height:24px;border:0;vertical-align:middle;">&nbsp; <strong>Facebook:</strong> <span style="color:#994013;text-decoration:underline;">RealView - Tổng hợp và đánh giá reviews</span></a></td></tr>
          <tr><td style="padding:0 0 9px;color:#24262a;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;overflow-wrap:anywhere;"><a href="${emailBrandingUrls.tiktok}" style="color:#24262a;text-decoration:none;"><img src="https://www.realview.com.vn/assets/email/tiktok-icon.png" width="24" height="24" alt="" style="display:inline-block;width:24px;height:24px;border:0;vertical-align:middle;">&nbsp; <strong>TikTok:</strong> <span style="color:#994013;text-decoration:underline;">RealView on TikTok</span></a></td></tr>
          <tr><td style="padding:0 0 0 1px;color:#24262a;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;overflow-wrap:anywhere;"><strong>Threads:</strong> <a href="${emailBrandingUrls.threads}" style="color:#994013;text-decoration:underline;">REALVIEW (@real.viewueh)</a></td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 39px 29px;background-color:${FOOTER_BACKGROUND};">
        <div style="height:1px;background-color:#d7d2cb;font-size:1px;line-height:1px;">&nbsp;</div>
        <p style="margin:17px 0 5px;color:#737276;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.55;">${reason}</p>
        <p style="margin:0;color:#737276;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.55;">Không phải yêu cầu của bạn? <a href="mailto:${CONTACT_EMAIL}" style="color:#7e4120;text-decoration:underline;">Liên hệ RealView</a>.</p>
      </td></tr>
    </tbody>
  </table>`;
}

function footerTableBounds(html) {
  const markerIndex = html.lastIndexOf(FOOTER_MARKER);
  const headingIndex = html.lastIndexOf('ĐỘI NGŨ REALVIEW');
  if (markerIndex < 0 || headingIndex < markerIndex) throw new Error('Không tìm thấy footer email RealView.');

  const start = html.lastIndexOf('<table', markerIndex);
  if (start < 0) throw new Error('Không tìm thấy bảng footer email RealView.');
  const tableTags = /<\/?table\b[^>]*>/gi;
  tableTags.lastIndex = start;
  let depth = 0;
  for (const match of html.matchAll(tableTags)) {
    if (match.index < start) continue;
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return { start, end: match.index + match[0].length };
  }
  throw new Error('Bảng footer email RealView chưa đóng.');
}

export function withTransactionalFooter(html, kind) {
  const reason = reasons[kind];
  if (!reason) throw new Error('Loại email giao dịch không hợp lệ.');
  const { start, end } = footerTableBounds(html);
  return html.slice(0, start) + footerHtml(reason) + html.slice(end);
}

export const transactionalFooterInternals = { reasons, footerTableBounds };
