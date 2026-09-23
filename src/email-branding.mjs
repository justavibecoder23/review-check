const REALVIEW_URL = 'https://www.realview.com.vn';
const EMAIL_ASSET_URL = `${REALVIEW_URL}/assets/email`;

export const emailBrandingUrls = {
  home: `${REALVIEW_URL}/`,
  blog: `${REALVIEW_URL}/bai-viet`,
  contact: `${REALVIEW_URL}/lien-he`,
  criteria: `${REALVIEW_URL}/tieu-chi-loc`,
  facebook: 'https://www.facebook.com/profile.php?id=61594093477895',
  tiktok: 'https://www.tiktok.com/@realviewueh',
  threads: 'https://www.threads.com/@real.viewueh',
  logo: `${REALVIEW_URL}/assets/realview-logo-v1.webp`,
  mascotWelcome: `${EMAIL_ASSET_URL}/mascot-welcome-contact.png`,
  mascotVerification: `${EMAIL_ASSET_URL}/mascot-verification.png`
};

export function escapeEmailHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function emailLayoutStart(preheader, maxWidth = 620) {
  const safePreheader = escapeEmailHtml(preheader);
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <style>
      body,table,td,p,h1,h2,h3,a,span,strong { font-family:Arial,Helvetica,sans-serif !important; }
      @media only screen and (max-width:480px) {
        .email-shell { width:100% !important; border-radius:0 !important; }
        .email-hero-mascot,.email-hero-copy { display:block !important; width:auto !important; text-align:center !important; padding:10px 18px !important; }
        .email-hero-mascot img { width:96px !important; height:auto !important; margin:0 auto !important; }
        .email-content { padding-left:20px !important; padding-right:20px !important; }
      }
    </style>
  </head>
  <body bgcolor="#f4f3ef" style="margin:0;padding:0;background:#f4f3ef;color:#171717;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    <div style="max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:0;line-height:0;color:transparent;mso-hide:all;">${safePreheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f3ef" style="width:100%;background:#f4f3ef;border-collapse:collapse;">
      <tr><td align="center" style="padding:24px 12px;">
        <table class="email-shell" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:${maxWidth}px;background:#ffffff;border:1px solid #dce2ef;border-radius:22px;border-collapse:separate;overflow:hidden;">
          <tr><td height="5" bgcolor="#f05b16" style="height:5px;background:#f05b16;font-size:1px;line-height:1px;">&nbsp;</td></tr>
          <tr>
            <td bgcolor="#ffffff" style="padding:17px 24px;border-bottom:1px solid #e5e7ed;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
                <td valign="middle" style="padding:0 11px 0 0;vertical-align:middle;"><span style="display:block;padding:3px;border-radius:11px;background:#ffffff;"><img src="${emailBrandingUrls.logo}" width="42" height="40" alt="" style="display:block;width:42px;height:40px;object-fit:contain;border:0;"></span></td>
                <td valign="middle" style="vertical-align:middle;color:#171717;font-family:Arial,Helvetica,sans-serif;font-size:21px;line-height:1;font-weight:900;letter-spacing:-.6px;"><span style="color:#f05b16;font-family:Arial,Helvetica,sans-serif;">REAL</span><span style="color:#171717;font-family:Arial,Helvetica,sans-serif;">VIEW</span><br><span style="display:inline-block;margin-top:6px;color:#687080;font-family:Arial,Helvetica,sans-serif;font-size:9px;line-height:1.2;font-weight:700;letter-spacing:1.2px;">GÓC NHÌN THẬT&nbsp; · &nbsp;LỰA CHỌN ĐÚNG</span></td>
              </tr></table>
            </td>
          </tr>`;
}

export function emailSocialFooter({ includeSiteLinks = false } = {}) {
  const navLinks = includeSiteLinks
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 17px;border-bottom:1px solid #e1e5ef;"><tr><td style="padding:0 0 15px;text-align:center;font-size:13px;line-height:1.8;"><a href="${emailBrandingUrls.blog}" style="color:#344ca7;text-decoration:underline;font-weight:700;">Blog</a><span style="color:#b9c1d1;">&nbsp;&nbsp;·&nbsp;&nbsp;</span><a href="${emailBrandingUrls.contact}" style="color:#344ca7;text-decoration:underline;font-weight:700;">Liên hệ</a><span style="color:#b9c1d1;">&nbsp;&nbsp;·&nbsp;&nbsp;</span><a href="${emailBrandingUrls.criteria}" style="color:#344ca7;text-decoration:underline;font-weight:700;">Tiêu chí lọc</a></td></tr></table>`
    : '';
  const contactRows = [
    ['◎', 'Website', 'realview.com.vn', emailBrandingUrls.home, '#e4f3ff', '#168bd2'],
    ['✉', 'Email', 'realviewueh@gmail.com', 'mailto:realviewueh@gmail.com', '#e8f0ff', '#3862c9'],
    ['☎', 'Hotline', '037 712 0633', 'tel:+84377120633', '#fff1e7', '#e56b20'],
    ['f', 'Facebook', 'RealView - Tổng hợp và đánh giá reviews', emailBrandingUrls.facebook, '#e8efff', '#2864d8'],
    ['♪', 'TikTok', '@realviewueh', emailBrandingUrls.tiktok, '#e9eaed', '#171b2e'],
    ['@', 'Threads', '@real.viewueh', emailBrandingUrls.threads, '#ececf1', '#171b2e']
  ].map(([icon, label, value, href, iconBg, iconColor]) => `<tr>
    <td width="30" valign="middle" style="width:30px;padding:0 0 8px;vertical-align:middle;font-family:Arial,Helvetica,sans-serif;"><span style="display:inline-block;width:21px;height:21px;border-radius:7px;background:${iconBg};color:${iconColor};font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:21px;font-weight:800;text-align:center;">${icon}</span></td>
    <td valign="middle" style="padding:0 0 8px 4px;color:#252a36;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;vertical-align:middle;overflow-wrap:anywhere;word-break:break-word;"><strong style="color:#171b2e;font-family:Arial,Helvetica,sans-serif;">${label}:</strong> <a href="${href}"${href.startsWith('https:') ? ' target="_blank"' : ''} style="color:#344ca7;font-family:Arial,Helvetica,sans-serif;text-decoration:none;">${value}</a></td>
  </tr>`).join('');
  return `<tr>
    <td bgcolor="#f7f8fc" style="padding:22px 24px 24px;background:#f7f8fc;border-top:1px solid #dfe4ef;">
      ${navLinks}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:490px;margin:0 auto 14px;border-collapse:collapse;">
        <tr><td colspan="2" style="padding:0 0 10px;color:#171b2e;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:.3px;">THÔNG TIN &amp; KẾT NỐI</td></tr>
        ${contactRows}
      </table>
      <p style="margin:0;text-align:center;color:#7a8191;font-size:10px;line-height:1.55;">Góc nhìn thật, lựa chọn đúng.<br>© 2026 RealView</p>
    </td>
  </tr>
  </table></td></tr></table>
  </body>
</html>`;
}

export const emailBrandingInternals = { REALVIEW_URL, EMAIL_ASSET_URL };
