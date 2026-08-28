import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rulesDocument = require('./layer1_rules.json');
const layer2Document = require('./sample_ai_payload.json');
const rules = rulesDocument.layer1_rules;
const policy = rulesDocument.policy;
const layer2Config = layer2Document.layer2_config;
const allowedCategories = new Set(policy.allowed_defect_categories);

export function normalizeVietnamese(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function compilePatterns(patterns = []) {
  return patterns.map((pattern) => new RegExp(pattern, 'iu'));
}

const strongSeedingPatterns = compilePatterns(rules.seeding_detection.strong_regex_patterns);
const weakSeedingPatterns = compilePatterns(rules.seeding_detection.weak_regex_patterns);
const iconOnlyPattern = new RegExp(rules.spam_and_low_value.icon_only_regex, 'u');

function evidenceClause(originalText, foldedKeyword) {
  const clauses = String(originalText).split(/(?<=[.!?;])\s+|[,\n]+/u).map((part) => part.trim()).filter(Boolean);
  const matching = clauses.find((part) => normalizeVietnamese(part).includes(foldedKeyword));
  return String(matching || originalText).slice(0, 180);
}

function hasLocalNegation(normalizedText, keywordIndex, keyword) {
  if (/^(khong|chang|cha|dau co)\b/.test(keyword)) return false;
  const window = Number(rules.negation_filter.window_characters) || 28;
  const prefix = normalizedText.slice(Math.max(0, keywordIndex - window), keywordIndex);
  const negations = rules.negation_filter.negation_words.join('|');
  const bridges = rules.negation_filter.bridge_words.join('|');
  return new RegExp(`(?:^|\\s)(?:${negations})(?:\\s+(?:${bridges})){0,2}\\s*$`, 'u').test(prefix);
}

function defectMatches(reviewText) {
  const normalized = normalizeVietnamese(reviewText);
  const matches = [];
  for (const [category, definition] of Object.entries(rules.defect_categories)) {
    const categoryMatches = [];
    for (const rawKeyword of definition.keywords) {
      const keyword = normalizeVietnamese(rawKeyword);
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matcher = new RegExp(`(?:^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, 'gu');
      let occurrence;
      while ((occurrence = matcher.exec(normalized))) {
        const index = occurrence.index + occurrence[0].indexOf(occurrence[1]);
        if (!hasLocalNegation(normalized, index, keyword)) {
          categoryMatches.push({ keyword, quote: evidenceClause(reviewText, keyword) });
          break;
        }
      }
    }
    if (categoryMatches.length) {
      matches.push({
        id: category,
        label: definition.label,
        severity: Number(definition.severity_weight),
        evidence: categoryMatches.slice(0, 3)
      });
    }
  }
  return matches;
}

function matchAny(patterns, text) {
  const pattern = patterns.find((candidate) => candidate.test(text));
  return pattern ? pattern.source : null;
}

function repeatedCharacterSpam(text) {
  const maximum = Number(rules.spam_and_low_value.max_repeated_chars_allowed) || 5;
  return new RegExp(`(.)\\1{${maximum},}`, 'u').test(text);
}

function baseLabels(layer1) {
  return {
    is_seeding: layer1.is_seeding,
    is_low_value: layer1.is_low_value,
    is_vague: layer1.is_vague,
    has_defect: layer1.has_defect,
    defect_categories: [...layer1.defect_categories],
    defect_quote: layer1.defect_quote,
    confidence: layer1.confidence,
    reason_code: layer1.reason_codes[0] || 'NO_RULE_MATCH'
  };
}

export function labelReviewLayer1(review = {}, index = 0) {
  const originalText = String(review.text || '').trim();
  const text = normalizeVietnamese(originalText);
  const defects = defectMatches(originalText);
  const exactSeeding = rules.seeding_detection.exact_phrases.find((phrase) => text.includes(normalizeVietnamese(phrase)));
  const strongSeeding = exactSeeding ? null : matchAny(strongSeedingPatterns, text);
  const weakSeeding = matchAny(weakSeedingPatterns, text);
  const isSeeding = Boolean(exactSeeding || strongSeeding);
  const tokens = text ? text.split(/\s+/u) : [];
  const generic = rules.spam_and_low_value.generic_short_phrases.some((phrase) => text === normalizeVietnamese(phrase));
  const iconOnly = Boolean(originalText && iconOnlyPattern.test(originalText));
  const tooShort = text.length < Number(rules.spam_and_low_value.min_character_length)
    || tokens.length < Number(rules.spam_and_low_value.min_token_count);
  const lowValueCandidate = !text || generic || iconOnly || repeatedCharacterSpam(text) || tooShort;
  const isLowValue = defects.length === 0 && lowValueCandidate;
  const rating = Number(review.rating) || 0;
  const rantKeyword = rules.vague_rant_detection.rant_keywords.find((keyword) => text.includes(normalizeVietnamese(keyword)));
  const vagueRating = rules.vague_rant_detection.trigger_ratings.includes(rating);
  const isVague = vagueRating
    && defects.length === 0
    && Boolean(rantKeyword || isLowValue || text.length <= Number(rules.vague_rant_detection.max_length_without_defect));
  const reasonCodes = [];
  const evidence = [];
  if (exactSeeding || strongSeeding) {
    reasonCodes.push(exactSeeding ? 'SEEDING_EXACT_PHRASE' : 'SEEDING_STRONG_PATTERN');
    evidence.push({ label: 'seeding', rule: exactSeeding || strongSeeding, quote: originalText.slice(0, 180) });
  }
  if (weakSeeding) {
    reasonCodes.push('SEEDING_WEAK_CUE');
    evidence.push({ label: 'seeding_candidate', rule: weakSeeding, quote: originalText.slice(0, 180) });
  }
  if (isLowValue) reasonCodes.push(generic ? 'LOW_VALUE_GENERIC' : iconOnly ? 'LOW_VALUE_ICON_ONLY' : repeatedCharacterSpam(text) ? 'LOW_VALUE_REPETITION' : 'LOW_VALUE_SHORT');
  if (isVague) reasonCodes.push(rantKeyword ? 'VAGUE_RANT' : 'VAGUE_WITHOUT_DEFECT');
  for (const defect of defects) {
    reasonCodes.push(`DEFECT_${defect.id.toUpperCase().replaceAll('-', '_')}`);
    evidence.push(...defect.evidence.map((item) => ({ label: defect.id, rule: item.keyword, quote: item.quote })));
  }

  const conflicts = [];
  if (isSeeding && defects.length) conflicts.push('SEEDING_WITH_CONCRETE_DEFECT');
  if (weakSeeding && !isSeeding) conflicts.push('WEAK_SEEDING_CUE_ONLY');
  const signalConfidence = exactSeeding ? 0.99
    : strongSeeding ? 0.94
      : defects.length ? 0.92
        : rantKeyword ? 0.88
          : isLowValue ? 0.9
            : weakSeeding ? 0.62
              : 0.76;
  const confidence = conflicts.length ? Math.min(signalConfidence, 0.68) : signalConfidence;
  const result = {
    id: `r${String(index + 1).padStart(4, '0')}`,
    version: rulesDocument.version,
    is_seeding: isSeeding,
    is_low_value: isLowValue,
    is_vague: isVague,
    has_defect: defects.length > 0,
    defect_categories: defects.map((defect) => defect.id),
    defect_quote: defects[0]?.evidence?.[0]?.quote || null,
    confidence,
    reason_codes: reasonCodes.length ? reasonCodes : ['NO_RULE_MATCH'],
    evidence,
    conflicts,
    requires_llm: conflicts.length > 0 || confidence < Number(policy.llm_review_confidence_below)
  };
  return result;
}

const layer2ResponseSchema = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          decision: { type: 'string', enum: ['confirm', 'correct', 'abstain'] },
          is_seeding: { type: 'boolean' },
          is_low_value: { type: 'boolean' },
          is_vague: { type: 'boolean' },
          has_defect: { type: 'boolean' },
          defect_categories: { type: 'array', items: { type: 'string', enum: [...allowedCategories] }, maxItems: 5 },
          defect_quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          evidence_quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason_code: { type: 'string' }
        },
        required: ['id', 'decision', 'is_seeding', 'is_low_value', 'is_vague', 'has_defect', 'defect_categories', 'defect_quote', 'evidence_quote', 'confidence', 'reason_code']
      }
    }
  },
  required: ['labels']
};

function normalizeLayer2Label(candidate, review, layer1) {
  if (!candidate || !['confirm', 'correct', 'abstain'].includes(candidate.decision)) return null;
  const categories = [...new Set((candidate.defect_categories || []).filter((category) => allowedCategories.has(category)))];
  const confidence = clamp(candidate.confidence);
  if (candidate.decision === 'abstain' || confidence < 0.65) {
    return { decision: 'abstain', confidence, reason_code: String(candidate.reason_code || 'LLM_ABSTAIN') };
  }
  const text = String(review.text || '');
  const quote = typeof candidate.defect_quote === 'string' && text.includes(candidate.defect_quote.trim())
    ? candidate.defect_quote.trim()
    : null;
  const evidenceQuote = typeof candidate.evidence_quote === 'string' && text.includes(candidate.evidence_quote.trim())
    ? candidate.evidence_quote.trim()
    : null;
  if (candidate.has_defect && (!categories.length || !quote)) {
    return {
      decision: 'abstain',
      confidence,
      reason_code: !categories.length ? 'INVALID_DEFECT_CATEGORY' : 'DEFECT_QUOTE_NOT_VERBATIM'
    };
  }
  const hasDefect = Boolean(candidate.has_defect && categories.length && quote);
  const ratingAllowsVague = policy.vague_only_for_ratings.includes(Number(review.rating));
  const isVague = Boolean(candidate.is_vague && ratingAllowsVague && !hasDefect);
  const changed = ['is_seeding', 'is_low_value', 'is_vague', 'has_defect'].some((key) => Boolean(candidate[key]) !== Boolean(layer1[key]))
    || JSON.stringify(categories) !== JSON.stringify(layer1.defect_categories);
  const decision = candidate.decision === 'confirm' && changed ? 'correct' : candidate.decision;
  if (decision === 'correct' && !evidenceQuote) {
    return { decision: 'abstain', confidence, reason_code: 'CORRECTION_EVIDENCE_NOT_VERBATIM' };
  }
  return {
    decision,
    is_seeding: Boolean(candidate.is_seeding),
    is_low_value: Boolean(candidate.is_low_value && !hasDefect),
    is_vague: isVague,
    has_defect: hasDefect,
    defect_categories: hasDefect ? categories : [],
    defect_quote: hasDefect ? quote : null,
    evidence_quote: evidenceQuote,
    confidence,
    reason_code: String(candidate.reason_code || 'LLM_REVIEWED').slice(0, 80),
    changed
  };
}

async function classifyBatchWithGemini(batch, product, fetchImpl) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { labels: [], warning: 'GEMINI_API_KEY chưa được cấu hình; sử dụng nhãn Layer 1.' };
  const model = process.env.LABELER_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const payload = batch.map(({ review, layer1 }) => ({
    id: layer1.id,
    rating: Number(review.rating) || 0,
    text: String(review.text || '').slice(0, 1000),
    verified: Boolean(review.verified),
    layer1
  }));
  const prompt = [
    layer2Config.system_instruction,
    ...layer2Config.decision_rules.map((rule, index) => `${index + 1}. ${rule}`),
    'decision=confirm nếu Layer 1 đúng; correct nếu có đủ bằng chứng để sửa; abstain nếu chưa đủ bằng chứng.',
    'Không được dùng rating một mình để kết luận seeding hoặc giả mạo.',
    `Ngữ cảnh sản phẩm: ${JSON.stringify({ title: product?.title || null, category: product?.category || null, platform: product?.platform || null })}`,
    `Dữ liệu cần kiểm định: ${JSON.stringify(payload)}`
  ].join('\n');
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: layer2ResponseSchema }
    }),
    signal: AbortSignal.timeout(18_000)
  });
  if (!response.ok) throw new Error(`Gemini labeler trả về HTTP ${response.status}`);
  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  const parsed = JSON.parse(text);
  return { labels: Array.isArray(parsed.labels) ? parsed.labels : [] };
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export async function labelReviewsTwoLayer(reviews = [], options = {}) {
  const prepared = reviews.map((review, index) => ({ review, layer1: labelReviewLayer1(review, index) }));
  const mode = options.mode || process.env.LABELER_LLM_MODE || 'all';
  const selected = mode === 'off' ? [] : mode === 'uncertain' ? prepared.filter((item) => item.layer1.requires_llm) : prepared;
  const batchSize = Math.min(30, Math.max(5, Number.parseInt(process.env.LABELER_LLM_BATCH_SIZE || '25', 10) || 25));
  const warnings = [];
  const layer2ById = new Map();
  if (selected.length && process.env.GEMINI_API_KEY) {
    const results = await Promise.all(chunks(selected, batchSize).map(async (batch) => {
      try {
        return await classifyBatchWithGemini(batch, options.product, options.fetchImpl || fetch);
      } catch (error) {
        return { labels: [], warning: error?.message || 'Layer 2 không phản hồi.' };
      }
    }));
    for (const result of results) {
      if (result.warning) warnings.push(result.warning);
      for (const candidate of result.labels) layer2ById.set(String(candidate.id), candidate);
    }
  } else if (selected.length) {
    warnings.push('Layer 2 chưa chạy vì GEMINI_API_KEY chưa được cấu hình; nhãn Layer 1 vẫn được lưu đầy đủ.');
  }

  let corrected = 0;
  let abstained = 0;
  const labeledReviews = prepared.map(({ review, layer1 }) => {
    const candidate = layer2ById.get(layer1.id);
    const layer2 = normalizeLayer2Label(candidate, review, layer1);
    if (layer2?.decision === 'abstain') abstained += 1;
    if (layer2?.changed) corrected += 1;
    const accepted = layer2 && layer2.decision !== 'abstain';
    const final = accepted ? {
      is_seeding: layer2.is_seeding,
      is_low_value: layer2.is_low_value,
      is_vague: layer2.is_vague,
      has_defect: layer2.has_defect,
      defect_categories: layer2.defect_categories,
      defect_quote: layer2.defect_quote,
      confidence: layer2.confidence,
      reason_code: layer2.reason_code,
      reviewed_by: 'gemini-layer2'
    } : { ...baseLabels(layer1), reviewed_by: 'layer1' };
    return {
      ...review,
      labelId: layer1.id,
      labels: final,
      labeling: { layer1, layer2, final, pipelineVersion: '2.1.0' }
    };
  });

  return {
    reviews: labeledReviews,
    stats: {
      total: reviews.length,
      layer2Requested: selected.length,
      layer2Returned: layer2ById.size,
      corrected,
      abstained,
      engine: layer2ById.size ? 'layer1+gemini-layer2' : 'layer1-only',
      rulesVersion: rulesDocument.version,
      promptVersion: layer2Document.version
    },
    warnings: [...new Set(warnings)]
  };
}

export { rulesDocument as LAYER1_RULES, layer2Document as LAYER2_PROMPT };
