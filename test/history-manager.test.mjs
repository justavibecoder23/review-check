import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HISTORY_MAX_ITEMS,
  HISTORY_STORAGE_KEY,
  LAST_ANALYSIS_KEY,
  deleteHistoryItem,
  formatRelativeTime,
  getHistory,
  pruneAnalysisReport,
  restoreHistoryItem,
  saveToHistory
} from '../public/history-manager.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function report(itemId = '123', title = `Sản phẩm ${itemId}`) {
  return {
    product: { platform: 'Shopee', itemId, url: `https://shopee.vn/product-i.1.${itemId}`, title, image: 'https://cdn.example/image.jpg' },
    stats: { scanned: 30, genuine: 22, excluded: 8, internalDebug: 'remove-me' },
    trust: { score: 76, tone: 'yellow', summary: 'Tập review khá đáng tin.', pros: [], cons: [], drivers: [], method: {} },
    verdict: 'Có thể tham khảo.',
    issues: [],
    reviews: [{ author: 'Khách', rating: 5, text: 'Dùng tốt và chắc chắn.', date: '8/9/2026', verified: true, included: true, labelId: 'r1', labels: { internal: true } }],
    source: { type: 'live', label: 'Shopee', credential: 'must-not-persist' },
    warnings: [],
    dataset: { rawDataset: ['must-not-persist'] },
    geminiContext: { apiKey: 'must-not-persist' }
  };
}

test('tinh gọn báo cáo chỉ giữ dữ liệu cần để dựng lại trang kết quả', () => {
  const pruned = pruneAnalysisReport(report());
  assert.equal(pruned.product.itemId, '123');
  assert.equal(pruned.reviews[0].text, 'Dùng tốt và chắc chắn.');
  assert.equal(pruned.reviews[0].labels, undefined);
  assert.equal(pruned.stats.internalDebug, undefined);
  assert.equal(pruned.source.credential, undefined);
  assert.equal(pruned.dataset, undefined);
  assert.equal(pruned.geminiContext, undefined);
});

test('lịch sử khử trùng sản phẩm và đưa lần phân tích mới nhất lên đầu', () => {
  const storage = new MemoryStorage();
  const firstTime = new Date('2026-09-08T08:00:00.000Z');
  const secondTime = new Date('2026-09-08T09:00:00.000Z');
  saveToHistory(report('123', 'Tên cũ'), { storage, now: () => firstTime });
  saveToHistory(report('456'), { storage, now: () => firstTime });
  saveToHistory(report('123', 'Tên mới'), { storage, now: () => secondTime });
  const history = getHistory({ storage });
  assert.equal(history.length, 2);
  assert.equal(history[0].title, 'Tên mới');
  assert.equal(history[0].analyzedAt, secondTime.toISOString());
});

test('lịch sử chỉ giữ tối đa mười báo cáo mới nhất', () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < HISTORY_MAX_ITEMS + 3; index += 1) {
    saveToHistory(report(String(index)), { storage, now: () => new Date(2026, 8, 8, 10, index) });
  }
  const history = getHistory({ storage });
  assert.equal(history.length, HISTORY_MAX_ITEMS);
  assert.equal(history[0].title, `Sản phẩm ${HISTORY_MAX_ITEMS + 2}`);
  assert.equal(history.at(-1).title, 'Sản phẩm 3');
});

test('khôi phục báo cáo qua sessionStorage mà không gọi backend', () => {
  const storage = new MemoryStorage();
  const session = new MemoryStorage();
  const item = saveToHistory(report(), { storage });
  let target = '';
  assert.equal(restoreHistoryItem(item.id, { storage, session, navigate: (url) => { target = url; } }), true);
  assert.equal(target, '/results.html');
  assert.equal(JSON.parse(session.getItem(LAST_ANALYSIS_KEY)).product.itemId, '123');
});

test('bản ghi hỏng bị bỏ qua và có thể xóa riêng một mục', () => {
  const storage = new MemoryStorage();
  const first = saveToHistory(report('1'), { storage });
  saveToHistory(report('2'), { storage });
  const raw = JSON.parse(storage.getItem(HISTORY_STORAGE_KEY));
  storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([...raw, { broken: true }]));
  assert.equal(getHistory({ storage }).length, 2);
  assert.equal(deleteHistoryItem(first.id, { storage }).length, 1);
});

test('thời gian tương đối hiển thị bằng tiếng Việt', () => {
  const now = new Date('2026-09-08T10:00:00.000Z');
  assert.equal(formatRelativeTime('2026-09-08T09:59:40.000Z', now), 'Vừa xong');
  assert.equal(formatRelativeTime('2026-09-08T09:40:00.000Z', now), '20 phút trước');
});

test('giao diện có lịch sử trang chủ, drawer, badge và nút tại trang kết quả', () => {
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const results = readFileSync(new URL('../public/results.html', import.meta.url), 'utf8');
  const nav = readFileSync(new URL('../public/nav.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../public/history-ui.js', import.meta.url), 'utf8');
  assert.match(index, /data-history-section/);
  assert.match(index, /data-history-list/);
  assert.match(results, /data-history-open/);
  assert.match(nav, /nav-history-trigger/);
  assert.match(ui, /analysis-history-drawer/);
  assert.match(ui, /restoreHistoryItem/);
});
