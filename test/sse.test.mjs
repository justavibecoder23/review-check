import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createProgressReporter, encodeSseEvent } from '../src/sse.mjs';

test('mã hóa event SSE thành hai dòng và kết thúc bằng dòng trống', () => {
  assert.equal(
    encodeSseEvent('progress', { percent: 25, message: 'Đang lấy review' }),
    'event: progress\ndata: {"percent":25,"message":"Đang lấy review"}\n\n'
  );
});

test('progress reporter chuẩn hóa phần trăm và giữ details', () => {
  const events = [];
  const report = createProgressReporter((event) => events.push(event));
  report('collecting', 140, 'Xong', { completedRuns: 5 });
  assert.deepEqual(events, [{
    stage: 'collecting',
    percent: 100,
    message: 'Xong',
    details: { completedRuns: 5 }
  }]);
});

test('lỗi ở consumer tiến độ không làm vỡ tiến trình backend', () => {
  const report = createProgressReporter(() => { throw new Error('client disconnected'); });
  assert.doesNotThrow(() => report('saving', 80, 'Đang lưu'));
});

test('spinner chỉ hiển thị thông tin chung, không lộ số account hoặc tiến trình backend', async () => {
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /Đang khởi tạo hệ thống lấy reviews/);
  assert.match(appSource, /Đang lấy reviews/);
  assert.match(appSource, /progress\.stage/);
  assert.doesNotMatch(appSource, /progress\.phase/);
  assert.doesNotMatch(appSource, /5 tài khoản|20\/20|Apify/i);
});
