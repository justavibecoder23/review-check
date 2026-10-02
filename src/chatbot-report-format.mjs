import { paragraphAnswer, section } from './chatbot-answer-format.mjs';
import { REVIEW_SCORE_LIMITATION, REVIEW_SAMPLE_LIMITATION } from './chatbot-site-facts.mjs';

function numeric(value) { return value != null && typeof value !== 'boolean' && !(typeof value === 'string' && !value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null; }
function scoreLine(context) {
  const score = numeric(context.trust?.score);
  return `TrustScore: ${score == null ? 'Chưa có đủ dữ liệu để xác định' : `${score}/100`}${context.trust?.label ? ` (${context.trust.label})` : ''}.`;
}
function summaryItems(items, limit = 3) {
  return (Array.isArray(items) ? items : []).slice(0, limit).map(item => ({
    text: typeof item === 'string' ? item : item?.label || item?.title || item?.detail || item?.text || '',
    evidenceRefs: Array.isArray(item?.evidenceIds) ? item.evidenceIds : []
  })).filter(item => item.text);
}
export function reportFallbackDocument(context, question, purchase = false) {
  const q = String(question).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  const doc = { ...paragraphAnswer(purchase ? 'Hãy đối chiếu ưu điểm và hạn chế trong báo cáo với nhu cầu của bạn trước khi quyết định mua.'
    : 'Dịch vụ trả lời tự động đang tạm thời gián đoạn. Dưới đây là thông tin đã có trong báo cáo, không phải một phân tích mới.'),
    limitations: [REVIEW_SCORE_LIMITATION, REVIEW_SAMPLE_LIMITATION] };
  if (purchase || /trustscore|diem|tin cay/.test(q)) {
    const items = [{ text: scoreLine(context), evidenceRefs: [] }];
    if (!purchase && context.trust?.summary) items.push({ text: context.trust.summary, evidenceRefs: [] });
    doc.sections.push(section('Độ tin cậy của tập review', 'paragraph', items));
  }
  if (purchase || /uu diem|diem manh|tot o dau/.test(q)) {
    const items = summaryItems(context.trust?.pros, purchase ? 2 : 3);
    doc.sections.push(section('Ưu điểm được ghi nhận', 'bullets', items.length ? items : ['Chưa có thông tin về ưu điểm trong dữ liệu được cung cấp.']));
  }
  if (purchase || /nhuoc diem|diem yeu|van de/.test(q)) {
    const items = summaryItems(context.trust?.cons, purchase ? 2 : 3);
    doc.sections.push(section('Điểm cần cân nhắc', 'bullets', items.length ? items : ['Chưa có thông tin về hạn chế trong dữ liệu được cung cấp; không có nghĩa sản phẩm không có hạn chế.']));
  }
  if (/bao nhieu|bi loai|da quet|dang tham khao/.test(q)) {
    doc.sections.push(section('Số liệu của báo cáo', 'bullets', [
      `Review đã quét: ${numeric(context.stats?.scanned) ?? 'chưa xác định'}.`,
      `Review đáng tham khảo: ${numeric(context.stats?.included) ?? 'chưa xác định'}.`,
      `Review bị loại: ${numeric(context.stats?.excluded) ?? 'chưa xác định'}.`
    ]));
  }
  if (!doc.sections.length) doc.sections.push(section('Điều chưa thể xác nhận', 'paragraph', ['Chưa thể diễn giải câu hỏi này khi dịch vụ AI gián đoạn. Bạn có thể hỏi riêng về TrustScore, ưu điểm, nhược điểm hoặc số lượng review trong báo cáo.']));
  return doc;
}

// Guard clear numeric claims only; this is NOT proof that all prose is grounded.
export function validateReportNumbers(document, contexts) {
  if (!contexts.length) return;
  const text = [document.summary, ...document.sections.flatMap(s => s.items.map(i => i.text)), ...document.limitations].join('\n');
  const scores = new Set(contexts.map(c => numeric(c.trust?.score)).filter(x => x != null));
  for (const match of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*\/\s*100\b/g)) {
    if (!scores.has(Number(match[1].replace(',', '.')))) throw new Error('Điểm số không khớp báo cáo.');
  }
  for (const match of text.matchAll(/TrustScore\s*(?:của tập review này\s*)?(?:là|:|=|đạt)?\s*(\d+(?:[.,]\d+)?)/gi)) {
    if (!scores.has(Number(match[1].replace(',', '.')))) throw new Error('Điểm số không khớp báo cáo.');
  }
  if (contexts.length === 1) {
    const stats = contexts[0].stats || {};
    for (const [pattern, field] of [[/(?:đã quét|quét)\s+(\d+)\s*(?:review|đánh giá)/gi, 'scanned'],
      [/(?:giữ|giữ lại)\s+(\d+)\s*(?:review|đánh giá)/gi, 'included'], [/(?:loại|loại bỏ)\s+(\d+)\s*(?:review|đánh giá)/gi, 'excluded'],
      [/(?:review|đánh giá)\s+đã quét\s*:\s*(\d+)/gi, 'scanned'],
      [/(?:review|đánh giá)\s+đáng tham khảo\s*:\s*(\d+)/gi, 'included'],
      [/(?:review|đánh giá)\s+bị loại\s*:\s*(\d+)/gi, 'excluded']]) {
      for (const match of text.matchAll(pattern)) if (numeric(stats[field]) !== Number(match[1])) throw new Error('Số lượng review không khớp báo cáo.');
    }
  }
}
