import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { EventEmitter } from 'node:events';
import { clientDisconnectSignal, createProgressReporter, encodeSseEvent } from '../src/sse.mjs';

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

test('ngắt kết nối SSE phát AbortSignal để dừng backend', () => {
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.writableEnded = false;
  const signal = clientDisconnectSignal(request, response);
  response.emit('close');
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, 'AbortError');
});

test('trang chủ chuyển ngay sang kết quả và giao diện tiến trình không lộ tài nguyên backend', async () => {
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const resultsSource = await readFile(new URL('../public/results.js', import.meta.url), 'utf8');
  assert.match(appSource, /results\.html\?url=/);
  assert.match(resultsSource, /product_meta/);
  assert.match(resultsSource, /reviews_sample/);
  assert.match(resultsSource, /layer1_stats/);
  assert.match(resultsSource, /progress\.stage/);
  assert.doesNotMatch(resultsSource, /progress\.phase/);
  assert.doesNotMatch(resultsSource, /5 tài khoản|20\/20|Apify/i);
});

test('SSE phát các mốc dữ liệu tiệm tiến ngoài kết quả cuối', async () => {
  const handlerSource = await readFile(new URL('../api/analyze-stream.mjs', import.meta.url), 'utf8');
  assert.match(handlerSource, /stream\.send\('product_meta'/);
  assert.match(handlerSource, /stream\.send\('reviews_sample'/);
  assert.match(handlerSource, /stream\.send\('layer1_stats'/);
  assert.match(handlerSource, /stream\.send\('result'/);
});
