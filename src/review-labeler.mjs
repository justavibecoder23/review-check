import { createRequire } from 'node:module';
import { geminiThinkingConfig, parseGeminiJson, requestGeminiWithFallback } from './gemini-response.mjs';
import { isRedisConfigured } from './redis-rest.mjs';

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

function gibberishSpam(text) {
  const tokens = String(text).match(/[a-z0-9]+/gu) || [];
  return tokens.some((token) => {
    if (token.length >= 24) return true;
    if (token.length < 14) return false;
    if (/\d/u.test(token) && /[a-z]/u.test(token)) return true;
    if (/[bcdfghjklmnpqrstvwxyz]{7,}/u.test(token)) return true;
    const bigrams = new Map();
    for (let index = 0; index < token.length - 1; index += 1) {
      const pair = token.slice(index, index + 2);
      bigrams.set(pair, (bigrams.get(pair) || 0) + 1);
    }
    return Math.max(0, ...bigrams.values()) >= 4;
  });
}

const logisticsCuePattern = /\b(?:giao|ship|van chuyen|dong goi|goi ky|goi ki|nhan hang|shop)\b/u;
const productExperiencePattern = /\b(?:san pham|chat luong|chat lieu|dung|su dung|xai|mac|uong|giu nhiet|ben|sac|pin|mau|size|form|mui|vi|cong nang|hoat dong)\b/u;

function logisticsOnlyReview(text) {
  if (!logisticsCuePattern.test(text) || productExperiencePattern.test(text)) return false;
  const stripped = text
    .replace(/\b(?:giao|hang|nhanh|ship|van chuyen|dong goi|goi|ky|ki|can than|dep|tot|ok|oke|oki|shop|nhan|duoc|sai|sài|xai)\b/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  return stripped.split(/\s+/u).filter(Boolean).length <= 3;
}

const productFamilies = Object.freeze({
  drinkware: ["binh nuoc", "binh giu nhiet", "ly giu nhiet", "ly nuoc", "coc nuoc", "chai nuoc"],
  grooming: ["dao cao rau", "may cao rau", "cao rau"],
  audio: ["tai nghe", "loa bluetooth", "headphone", "earphone"],
  clothing: ["ao thun", "ao khoac", "quan jean", "quan ao", "vay dam"],
  footwear: ["giay", "dep", "sandal"],
  phoneAccessory: ["op lung", "kinh cuong luc", "cap sac", "sac du phong"]
});

function matchingProductFamilies(text) {
  return Object.entries(productFamilies)
    .filter(([, phrases]) => phrases.some((phrase) => text.includes(phrase)))
    .map(([family]) => family);
}

function offTopicProductMismatch(reviewText, product = {}) {
  const title = normalizeVietnamese(product?.title || '');
  if (!title || /san pham dang phan tich/u.test(title)) return false;
  const titleFamilies = matchingProductFamilies(title);
  const reviewFamilies = matchingProductFamilies(reviewText);
  if (!titleFamilies.length || !reviewFamilies.length) return false;
  return !reviewFamilies.some((family) => titleFamilies.includes(family));
}

function baseLabels(layer1) {
  return {
    is_seeding: layer1.is_seeding,
    is_low_value: layer1.is_low_value,
    is_vague: layer1.is_vague,
    is_off_topic: layer1.is_off_topic,
    has_defect: layer1.has_defect,
    defect_categories: [...layer1.defect_categories],
    defect_quote: layer1.defect_quote,
    confidence: layer1.confidence,
    reason_code: layer1.reason_codes[0] || 'NO_RULE_MATCH'
  };
}

export function labelReviewLayer1(review = {}, index = 0, product = {}) {
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
  const gibberish = gibberishSpam(text);
  const logisticsOnly = logisticsOnlyReview(text);
  const isOffTopic = offTopicProductMismatch(text, product);
  const tooShort = text.length < Number(rules.spam_and_low_value.min_character_length)
    || tokens.length < Number(rules.spam_and_low_value.min_token_count);
  const repeated = repeatedCharacterSpam(text);
  const lowValueCandidate = !text || generic || iconOnly || repeated || gibberish || logisticsOnly || tooShort;
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
  if (isLowValue) reasonCodes.push(gibberish ? 'LOW_VALUE_GIBBERISH' : logisticsOnly ? 'LOW_VALUE_LOGISTICS_ONLY' : generic ? 'LOW_VALUE_GENERIC' : iconOnly ? 'LOW_VALUE_ICON_ONLY' : repeated ? 'LOW_VALUE_REPETITION' : 'LOW_VALUE_SHORT');
  if (isOffTopic) {
    reasonCodes.push('OFF_TOPIC_PRODUCT_MISMATCH');
    evidence.push({ label: 'off_topic', rule: 'product_family_mismatch', quote: originalText.slice(0, 180) });
  }
  if (isVague) reasonCodes.push(rantKeyword ? 'VAGUE_RANT' : 'VAGUE_WITHOUT_DEFECT');
  for (const defect of defects) {
    reasonCodes.push(`DEFECT_${defect.id.toUpperCase().replaceAll('-', '_')}`);
    evidence.push(...defect.evidence.map((item) => ({ label: defect.id, rule: item.keyword, quote: item.quote })));
  }

  const conflicts = [];
  if (isSeeding && defects.length) conflicts.push('SEEDING_WITH_CONCRETE_DEFECT');
  if (weakSeeding && !isSeeding) conflicts.push('WEAK_SEEDING_CUE_ONLY');
  const signalConfidence = isOffTopic || gibberish ? 0.97
    : exactSeeding ? 0.99
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
    is_off_topic: isOffTopic,
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
          is_off_topic: { type: 'boolean' },
          has_defect: { type: 'boolean' },
          defect_categories: { type: 'array', items: { type: 'string', enum: [...allowedCategories] }, maxItems: 5 },
          defect_quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          evidence_quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason_code: { type: 'string' }
        },
        required: ['id', 'decision', 'is_seeding', 'is_low_value', 'is_vague', 'is_off_topic', 'has_defect', 'defect_categories', 'defect_quote', 'evidence_quote', 'confidence', 'reason_code']
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
  const lockedLowValue = layer1.reason_codes.some((code) => ['LOW_VALUE_GIBBERISH', 'LOW_VALUE_LOGISTICS_ONLY', 'LOW_VALUE_REPETITION'].includes(code));
  const lockedOffTopic = layer1.reason_codes.includes('OFF_TOPIC_PRODUCT_MISMATCH');
  // Các tín hiệu deterministic này không được để LLM mở khóa bằng một category
  // defect được suy diễn. Review lỗi thật đã được Layer 1 ưu tiên defect và sẽ
  // không mang lockedLowValue ngay từ đầu.
  const hasDefect = Boolean(!lockedLowValue && !lockedOffTopic && candidate.has_defect && categories.length && quote);
  const ratingAllowsVague = policy.vague_only_for_ratings.includes(Number(review.rating));
  const isVague = Boolean(candidate.is_vague && ratingAllowsVague && !hasDefect);
  const isLowValue = Boolean(lockedLowValue || (candidate.is_low_value && !hasDefect));
  const isOffTopic = Boolean(candidate.is_off_topic || lockedOffTopic);
  const changed = ['is_seeding', 'is_vague', 'has_defect'].some((key) => Boolean(candidate[key]) !== Boolean(layer1[key]))
    || isLowValue !== Boolean(layer1.is_low_value)
    || isOffTopic !== Boolean(layer1.is_off_topic)
    || JSON.stringify(categories) !== JSON.stringify(layer1.defect_categories);
  const decision = candidate.decision === 'confirm' && changed ? 'correct' : candidate.decision;
  if (decision === 'correct' && !evidenceQuote) {
    return { decision: 'abstain', confidence, reason_code: 'CORRECTION_EVIDENCE_NOT_VERBATIM' };
  }
  return {
    decision,
    is_seeding: Boolean(candidate.is_seeding),
    is_low_value: isLowValue,
    is_vague: isVague,
    is_off_topic: isOffTopic,
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
  const geminiResult = await requestGeminiWithFallback({
    fetchImpl,
    apiKey,
    primaryModel: model,
    fallbackModels: process.env.LABELER_GEMINI_FALLBACK_MODELS || process.env.GEMINI_FALLBACK_MODELS,
    context: 'Gemini labeler',
    buildRequest: (selectedModel, selectedApiKey) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': selectedApiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 8192,
          thinkingConfig: geminiThinkingConfig('minimal', selectedModel),
          responseMimeType: 'application/json',
          responseSchema: layer2ResponseSchema
        }
      }),
      signal: AbortSignal.timeout(10_000)
    })
  });
  const { response } = geminiResult;
  const body = await response.json();
  const parsed = parseGeminiJson(body, 'Gemini labeler');
  return {
    labels: Array.isArray(parsed.labels) ? parsed.labels : [],
    retry: {
      model: geminiResult.model,
      attemptedModels: geminiResult.attemptedModels || [],
      credentialAttempts: geminiResult.attemptedCredentialIds?.length || (geminiResult.credentialId ? 1 : 0),
      durationMs: geminiResult.totalDurationMs || 0,
      finalAttemptLatencyMs: geminiResult.finalAttemptLatencyMs || 0
    }
  };
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export async function labelReviewsTwoLayer(reviews = [], options = {}) {
  const layer2StartedAt = Date.now();
  const prepared = reviews.map((review, index) => ({ review, layer1: labelReviewLayer1(review, index, options.product) }));
  const mode = options.mode || process.env.LABELER_LLM_MODE || 'all';
  const selected = mode === 'off' ? [] : mode === 'uncertain' ? prepared.filter((item) => item.layer1.requires_llm) : prepared;
  const batchSize = Math.min(20, Math.max(5, Number.parseInt(process.env.LABELER_LLM_BATCH_SIZE || '20', 10) || 20));
  const warnings = [];
  const layer2ById = new Map();
  const model = process.env.LABELER_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const batches = chunks(selected, batchSize);
  let succeededBatches = 0;
  let failedBatches = 0;
  let retryAttempts = 0;
  let credentialSwitches = 0;
  const modelsUsed = new Set();
  const batchDurationsMs = [];
  if (selected.length && (process.env.GEMINI_API_KEY || isRedisConfigured())) {
    const results = await Promise.all(batches.map(async (batch, batchIndex) => {
      try {
        const result = await classifyBatchWithGemini(batch, options.product, options.fetchImpl || fetch);
        succeededBatches += 1;
        const attemptedCount = result.retry?.attemptedModels?.length || 1;
        retryAttempts += Math.max(0, attemptedCount - 1);
        credentialSwitches += Math.max(0, (result.retry?.credentialAttempts || 1) - 1);
        if (result.retry?.model) modelsUsed.add(result.retry.model);
        if (result.retry?.durationMs) batchDurationsMs.push(result.retry.durationMs);
        if ((attemptedCount > 1 || result.retry?.credentialAttempts > 1) && (process.env.VERCEL || options.logLayer2Errors)) {
          (options.logger || console).warn('[review-labeler] Layer 2 recovered after retry', {
            batch: batchIndex + 1,
            totalBatches: batches.length,
            attemptedModels: result.retry.attemptedModels,
            credentialAttempts: result.retry.credentialAttempts,
            finalModel: result.retry.model
          });
        }
        return result;
      } catch (error) {
        failedBatches += 1;
        const warning = error?.message || 'Layer 2 không phản hồi.';
        if (process.env.VERCEL || options.logLayer2Errors) {
          (options.logger || console).error('[review-labeler] Layer 2 batch failed', {
            batch: batchIndex + 1,
            totalBatches: batches.length,
            reviewCount: batch.length,
            model,
            attemptedModels: error?.attemptedModels || [],
            credentialAttempts: error?.attemptedCredentialIds?.length || 0,
            error: warning
          });
        }
        return { labels: [], warning };
      }
    }));
    for (const result of results) {
      if (result.warning) warnings.push(result.warning);
      for (const candidate of result.labels) layer2ById.set(String(candidate.id), candidate);
    }
  } else if (selected.length) {
    warnings.push('Layer 2 chưa chạy vì GEMINI_API_KEY chưa được cấu hình; nhãn Layer 1 vẫn được lưu đầy đủ.');
  }

  const layer2Status = selected.length === 0
    ? 'disabled'
    : failedBatches === 0 && layer2ById.size === selected.length
      ? 'complete'
      : layer2ById.size > 0
        ? 'partial'
        : 'failed';

  let corrected = 0;
  let abstained = 0;
  const labeledReviews = prepared.map(({ review, layer1 }) => {
    const candidate = layer2ById.get(layer1.id);
    const layer2 = normalizeLayer2Label(candidate, review, layer1);
    if (layer2?.decision === 'abstain') abstained += 1;
    if (layer2?.changed) corrected += 1;
    const accepted = layer2 && layer2.decision !== 'abstain';
    const layer2Unavailable = Boolean(layer1.requires_llm && !accepted);
    const final = accepted ? {
      is_seeding: layer2.is_seeding,
      is_low_value: layer2.is_low_value,
      is_vague: layer2.is_vague,
      is_off_topic: layer2.is_off_topic,
      has_defect: layer2.has_defect,
      defect_categories: layer2.defect_categories,
      defect_quote: layer2.defect_quote,
      confidence: layer2.confidence,
      reason_code: layer2.reason_code,
      layer2_unavailable: false,
      reviewed_by: 'gemini-layer2'
    } : { ...baseLabels(layer1), layer2_unavailable: layer2Unavailable, reviewed_by: 'layer1' };
    return {
      ...review,
      labelId: layer1.id,
      labels: final,
      labeling: { layer1, layer2, final, pipelineVersion: '2.2.0' }
    };
  });

  const layer2DurationMs = Date.now() - layer2StartedAt;
  if (process.env.VERCEL || options.logLayer2Errors) {
    (options.logger || console).log(JSON.stringify({
      level: 'info',
      event: 'gemini_layer2_complete',
      durationMs: layer2DurationMs,
      reviews: reviews.length,
      requested: selected.length,
      returned: layer2ById.size,
      batches: batches.length,
      succeededBatches,
      failedBatches,
      retryAttempts,
      credentialSwitches,
      batchDurationsMs
    }));
  }

  return {
    reviews: labeledReviews,
    stats: {
      total: reviews.length,
      layer2Requested: selected.length,
      layer2Returned: layer2ById.size,
      layer2Status,
      layer2Model: model,
      layer2Batches: { total: batches.length, succeeded: succeededBatches, failed: failedBatches },
      layer2Retry: { retryAttempts, credentialSwitches, modelsUsed: [...modelsUsed] },
      layer2DurationMs,
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
