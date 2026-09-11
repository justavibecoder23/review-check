import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  contactAcknowledgementEmailInternals,
  sendContactAcknowledgementEmail
} from '../src/contact-acknowledgement-email.mjs';

test('email xác nhận liên hệ giữ nguyên chủ đề, nội dung, icon và liên kết RealView', () => {
  const content = contactAcknowledgementEmailInternals.contactAcknowledgementEmailContent({
    name: 'Nguyễn Văn A'
  });
  const expectedText = [
    'Chào Nguyễn Văn A,',
    '',
    'Cảm ơn bạn đã quan tâm và gửi email cho RealView. Hệ thống của chúng tôi xin xác nhận đã nhận được yêu cầu liên hệ của bạn.',
    '',
    'Đội ngũ phát triển đang tiến hành xem xét nội dung và sẽ nỗ lực phản hồi đến bạn trong thời gian sớm nhất.',
    '',
    'Trong lúc chờ đợi, bạn có thể trải nghiệm các tính năng hoặc tìm hiểu thêm về dự án thông qua các kênh thông tin chính thức bên dưới.',
    '',
    'Khám phá RealView: https://www.realview.com.vn/',
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
    '📘 Facebook: RealView - Tổng hợp và đánh giá reviews',
    '🎵 TikTok: @realviewueh'
  ].join('\n');

  assert.equal(content.subject, '[Tự động] Xác nhận yêu cầu liên hệ – RealView');
  assert.equal(content.text, expectedText);
  for (const expected of [
    'Cảm ơn bạn đã quan tâm và gửi email cho RealView. Hệ thống của chúng tôi xin xác nhận đã nhận được yêu cầu liên hệ của bạn.',
    'Đội ngũ phát triển đang tiến hành xem xét nội dung và sẽ nỗ lực phản hồi đến bạn trong thời gian sớm nhất.',
    'Trong lúc chờ đợi, bạn có thể trải nghiệm các tính năng hoặc tìm hiểu thêm về dự án thông qua các kênh thông tin chính thức bên dưới.',
    'Khám phá RealView',
    'Chúc bạn một ngày tốt lành!',
    'Trân trọng,',
    'ĐỘI NGŨ REALVIEW',
    'RealView - Một dự án tích hợp AI, hỗ trợ người dùng trong quyết định mua sắm online.',
    'Dự án thuộc khuôn khổ môn học Digital Marketing - Nhóm Sinh viên Đại học Kinh tế TP.HCM (UEH)'
  ]) {
    assert.match(content.text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(content.html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const [icon, label] of [
    ['🌐', 'Website:'],
    ['📧', 'Email:'],
    ['📞', 'Hotline:']
  ]) {
    assert.match(content.text, new RegExp(`${icon} ${label}`));
    assert.match(content.html, new RegExp(`>${icon}</span>`));
  }

  assert.match(content.html, /href="https:\/\/realview\.com\.vn\/"/);
  assert.match(content.html, /href="mailto:realviewueh@gmail\.com"/);
  assert.match(content.html, /href="tel:\+84377120633"/);
  assert.match(content.html, /href="https:\/\/www\.facebook\.com\/profile\.php\?id=61594093477895"/);
  assert.match(content.html, /href="https:\/\/www\.tiktok\.com\/@realviewueh"/);
  assert.match(content.html, /max-width:600px/);
  assert.match(content.html, /overflow-wrap:anywhere/);
  assert.match(content.html, /<body bgcolor="#f4f3ef"[^>]*background:#f4f3ef/);
  assert.match(content.html, /<table[^>]*bgcolor="#f4f3ef"[^>]*background:#f4f3ef/);
  assert.match(content.html, /border-top:1px solid #e0e0e0/);
  assert.doesNotMatch(content.text, /--------------------/);
  assert.doesNotMatch(content.html, /--------------------/);

  const links = content.html.match(/<a [^>]+>/g) || [];
  const contactLinks = links.filter((link) => link.includes('color:#a84400'));
  assert.equal(links.length, 6);
  assert.equal(contactLinks.length, 5);
  for (const link of contactLinks) {
    assert.match(link, /color:#a84400/);
    assert.match(link, /display:inline-block/);
    assert.match(link, /text-decoration:none/);
    assert.doesNotMatch(link, /text-decoration:underline/);
  }

  const contentEnd = content.html.indexOf('các kênh thông tin chính thức bên dưới.</p>');
  const ctaIndex = content.html.indexOf('>Khám phá RealView</a>');
  const goodDayIndex = content.html.indexOf('>Chúc bạn một ngày tốt lành!</p>');
  assert.ok(contentEnd >= 0 && ctaIndex > contentEnd && goodDayIndex > ctaIndex);
  assert.match(content.html, /<td align="center">\s*<a href="https:\/\/www\.realview\.com\.vn\/" target="_blank" rel="noopener noreferrer"[^>]*>Khám phá RealView<\/a>/);
  assert.match(content.html, /background:#ff7a1a/);

  assert.match(content.text, /📘 Facebook:/);
  assert.match(content.text, /🎵 TikTok:/);
  const iconCells = content.html.match(/<td width="26" valign="middle"[^>]*>/g) || [];
  const labelCells = content.html.match(/<td valign="middle" style="padding:0 0 (?:9px|0) 8px;[^>]*>/g) || [];
  assert.equal(iconCells.length, 5);
  assert.equal(labelCells.length, 5);
  for (const iconCell of iconCells) {
    assert.match(iconCell, /width:26px/);
    assert.match(iconCell, /text-align:center/);
    assert.match(iconCell, /vertical-align:middle/);
  }

  const emojiSpans = content.html.match(/<span style="[^"]*width:18px;height:18px;font-size:16px;line-height:18px;[^"]*">[^<]+<\/span>/g) || [];
  assert.equal(emojiSpans.length, 3);
  const logoImages = content.html.match(/<img [^>]+>/g) || [];
  assert.equal(logoImages.length, 2);
  assert.match(logoImages[0], /src="https:\/\/img\.icons8\.com\/color\/48\/facebook-new\.png"/);
  assert.match(logoImages[1], /src="https:\/\/img\.icons8\.com\/color\/48\/tiktok--v1\.png"/);
  for (const logo of logoImages) {
    assert.match(logo, /alt=""/);
    assert.match(logo, /width="18" height="18"/);
    assert.match(logo, /vertical-align:middle/);
  }

  for (const socialUrl of [
    'https://www.facebook.com/profile.php?id=61594093477895',
    'https://www.tiktok.com/@realviewueh'
  ]) {
    const socialLink = links.find((link) => link.includes(`href="${socialUrl}"`));
    assert.ok(socialLink);
    assert.match(socialLink, /target="_blank"/);
    assert.match(socialLink, /rel="noopener noreferrer"/);
    assert.match(socialLink, /padding:4px 0/);
  }

  assert.match(
    content.html,
    /<p style="[^"]*font-size:16px;[^"]*font-weight:400;">Chào <strong style="color:#171717;font-weight:700;">Nguyễn Văn A<\/strong>,<\/p>/
  );

  for (const paragraph of [
    'Cảm ơn bạn đã quan tâm và gửi email cho RealView. Hệ thống của chúng tôi xin xác nhận đã nhận được yêu cầu liên hệ của bạn.',
    'Đội ngũ phát triển đang tiến hành xem xét nội dung và sẽ nỗ lực phản hồi đến bạn trong thời gian sớm nhất.',
    'Trong lúc chờ đợi, bạn có thể trải nghiệm các tính năng hoặc tìm hiểu thêm về dự án thông qua các kênh thông tin chính thức bên dưới.',
    'Chúc bạn một ngày tốt lành!',
    'Trân trọng,'
  ]) {
    const escapedParagraph = paragraph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      content.html,
      new RegExp(`<p style="[^"]*font-size:16px;[^"]*color:#171717;font-weight:400;">${escapedParagraph}</p>`)
    );
  }
});

test('tên khách hàng được làm sạch và thoát an toàn trong lời chào', () => {
  const content = contactAcknowledgementEmailInternals.contactAcknowledgementEmailContent({
    name: '<Khách & hàng>\r\nRealView'
  });

  assert.match(content.text, /^Chào <Khách & hàng> RealView,/);
  assert.match(content.html, /<strong[^>]*>&lt;Khách &amp; hàng&gt; RealView<\/strong>,/);
  assert.doesNotMatch(content.html, /Chào <Khách & hàng>/);
});

test('email xác nhận liên hệ không giả vờ gửi khi SMTP chưa được cấu hình', async () => {
  const previousUser = process.env.GMAIL_SMTP_USER;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  delete process.env.GMAIL_SMTP_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  try {
    const result = await sendContactAcknowledgementEmail({ email: 'buyer@example.com' });
    assert.deepEqual(result, { delivered: false, reason: 'not_configured' });
  } finally {
    if (previousUser === undefined) delete process.env.GMAIL_SMTP_USER;
    else process.env.GMAIL_SMTP_USER = previousUser;
    if (previousPassword === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = previousPassword;
  }
});

test('email xác nhận liên hệ được gửi đúng người nhận qua Gmail SMTP', async () => {
  const previousUser = process.env.GMAIL_SMTP_USER;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  process.env.GMAIL_SMTP_USER = 'realviewueh@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'test app password';
  let transportOptions;
  let message;
  try {
    const result = await sendContactAcknowledgementEmail(
      { name: 'Nguyễn Văn A', email: 'Buyer@Example.com' },
      {
        createTransportImpl(options) {
          transportOptions = options;
          return {
            async sendMail(value) {
              message = value;
              return { messageId: 'contact-acknowledgement-id' };
            }
          };
        }
      }
    );

    assert.equal(transportOptions.host, 'smtp.gmail.com');
    assert.equal(transportOptions.port, 465);
    assert.equal(transportOptions.secure, true);
    assert.equal(transportOptions.auth.user, 'realviewueh@gmail.com');
    assert.equal(transportOptions.auth.pass, 'testapppassword');
    assert.equal(message.from, 'RealView <realviewueh@gmail.com>');
    assert.equal(message.to, 'buyer@example.com');
    assert.equal(message.subject, '[Tự động] Xác nhận yêu cầu liên hệ – RealView');
    assert.match(message.text, /^Chào Nguyễn Văn A,/);
    assert.match(message.html, />Chào <strong[^>]*>Nguyễn Văn A<\/strong>,<\/p>/);
    assert.deepEqual(result, { delivered: true, messageId: 'contact-acknowledgement-id' });
  } finally {
    if (previousUser === undefined) delete process.env.GMAIL_SMTP_USER;
    else process.env.GMAIL_SMTP_USER = previousUser;
    if (previousPassword === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = previousPassword;
  }
});

test('API chỉ gửi email xác nhận sau khi liên hệ đã được lưu', async () => {
  const contactApi = await readFile(new URL('../api/contact.mjs', import.meta.url), 'utf8');
  const saveIndex = contactApi.indexOf('const record = await saveContactMessage(value)');
  const acknowledgementIndex = contactApi.indexOf('sendContactAcknowledgementEmail(record)');

  assert.ok(saveIndex >= 0);
  assert.ok(acknowledgementIndex > saveIndex);
  assert.match(contactApi, /acknowledgementDelivered: acknowledgement\.delivered/);
  assert.match(contactApi, /sendContactAcknowledgementEmail\(record\)\s*\.catch/);
});
