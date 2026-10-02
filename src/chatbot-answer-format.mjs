// Versioned, text-only answer contract. No provider HTML or arbitrary URLs.
export const ANSWER_FORMAT_VERSION = '2.0';
export const ANSWER_LIMITS = Object.freeze({ summary: 900, text: 1400, sections: 5, items: 6, total: 7000 });
export function structuredAnswersEnabled(options = {}) {
  return options.structuredAnswers ?? process.env.CHATBOT_STRUCTURED_ANSWERS !== 'off';
}
function invalid() { throw Object.assign(new Error('Cấu trúc câu trả lời không hợp lệ.'), { code: 'GEMINI_INVALID_RESPONSE' }); }
function text(value, maximum, required = false) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) invalid();
  return value.trim();
}
function refs(value, allowed) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8 || value.some(x => typeof x !== 'string')) invalid();
  return [...new Set(value.filter(x => allowed.has(x)))];
}
export const answerDocumentSchema = {
  type: 'object', properties: {
    summary: { type: 'string' }, evidenceRefs: { type: 'array', items: { type: 'string' } },
    sections: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, kind: { type: 'string', enum: ['paragraph', 'bullets', 'steps'] },
      items: { type: 'array', items: { type: 'object', properties: {
        text: { type: 'string' }, evidenceRefs: { type: 'array', items: { type: 'string' } }
      }, required: ['text', 'evidenceRefs'] } }
    }, required: ['title', 'kind', 'items'] } },
    limitations: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'string', enum: ['analyze', 'criteria', 'contact'] } }
  }, required: ['summary', 'evidenceRefs', 'sections', 'limitations', 'actions']
};
export const CHATBOT_ACTIONS = Object.freeze({
  analyze: { label: 'Phân tích sản phẩm', href: '/' },
  criteria: { label: 'Xem tiêu chí lọc review', href: '/tieu-chi-loc' },
  contact: { label: 'Liên hệ RealView', href: '/lien-he' }
});
export function formatAnswerText(doc) {
  const parts = [doc.summary];
  for (const section of doc.sections) {
    parts.push([section.title, ...section.items.map((item, index) =>
      `${section.kind === 'steps' ? `${index + 1}. ` : section.kind === 'bullets' ? '• ' : ''}${item.text}`)].filter(Boolean).join('\n'));
  }
  if (doc.limitations.length) parts.push(`Lưu ý\n${doc.limitations.join('\n')}`);
  return parts.join('\n\n');
}
export function normalizeAnswerDocument(value, allowedRefs = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const summary = text(value.summary, ANSWER_LIMITS.summary, true);
  if (!Array.isArray(value.sections) || value.sections.length > ANSWER_LIMITS.sections) invalid();
  const sections = value.sections.map(section => {
    if (!section || !['paragraph', 'bullets', 'steps'].includes(section.kind)
      || !Array.isArray(section.items) || !section.items.length || section.items.length > ANSWER_LIMITS.items) invalid();
    return { title: text(section.title, 100), kind: section.kind,
      items: section.items.map(item => ({ text: text(item?.text, ANSWER_LIMITS.text, true), evidenceRefs: refs(item.evidenceRefs, allowedRefs) })) };
  });
  if (!Array.isArray(value.limitations) || value.limitations.length > 3
    || !Array.isArray(value.actions) || value.actions.length > 2 || value.actions.some(x => !Object.hasOwn(CHATBOT_ACTIONS, x))) invalid();
  const doc = { version: ANSWER_FORMAT_VERSION, summary, evidenceRefs: refs(value.evidenceRefs, allowedRefs), sections,
    limitations: value.limitations.map(x => text(x, 700, true)), actions: [...new Set(value.actions)] };
  if (formatAnswerText(doc).length > ANSWER_LIMITS.total) invalid();
  return doc;
}
export function paragraphAnswer(answer) {
  const sentences = String(answer).split(/(?<=[.!?])\s+(?=[A-ZÀ-Ỹ0-9])/u).filter(Boolean);
  const summary = String(answer).length <= ANSWER_LIMITS.summary ? String(answer) : sentences.shift();
  return { summary, evidenceRefs: [], sections: String(answer).length <= ANSWER_LIMITS.summary ? []
    : [section('Giải thích thêm', 'paragraph', sentences)], limitations: [], actions: [] };
}
export function section(title, kind, items) {
  return { title, kind, items: items.map(item => typeof item === 'string' ? { text: item, evidenceRefs: [] } : item) };
}
export function attachAnswerDocument(result, value, contexts = []) {
  const allReviews = contexts.flatMap(context => context?.reviews || []);
  const allowed = new Set(allReviews.map(review => review.ref));
  const document = normalizeAnswerDocument(value, allowed);
  const citations = [...new Set([...document.evidenceRefs, ...document.sections.flatMap(s => s.items.flatMap(i => i.evidenceRefs))])];
  // Evidence snippets come ONLY from authorized server context, never from model text.
  const evidence = citations.map(ref => {
    const review = allReviews.find(x => x.ref === ref);
    const context = contexts.find(x => x?.reviews?.some(r => r.ref === ref));
    return { ref, text: review.text, rating: review.rating ?? null,
      included: typeof review.included === 'boolean' ? review.included : null,
      exclusionReason: review.exclusionReason || null, productTitle: context?.product?.title || null };
  });
  return { ...result, answer: formatAnswerText(document), answerDocument: document, citations, evidence };
}
