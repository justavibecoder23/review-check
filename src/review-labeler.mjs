import { createRequire } from 'node:module';
import {
  geminiThinkingConfig,
  getGeminiRouteCapacity,
  parseGeminiJson,
  requestGeminiWithFallback
} from './gemini-response.mjs';
import { isRedisConfigured } from './redis-rest.mjs';
import { annotateReviewDuplicates } from './review-deduplication.mjs';
import { REVIEW_PIPELINE_VERSION } from './review-pipeline-version.mjs';

const require = createRequire(import.meta.url);
const rulesDocument = require('./layer1_rules.json');
const layer2Document = require('./sample_ai_payload.json');
const rules = rulesDocument.layer1_rules;
const policy = rulesDocument.policy;
const layer2Config = layer2Document.layer2_config;
const allowedCategories = new Set(policy.allowed_defect_categories);
const LAYER2_MAX_ROUTE_ATTEMPTS = 2;
const LAYER2_DEFAULT_BATCH_SIZE = 10;
const LAYER2_DEFAULT_BASE_CONCURRENCY = 3;
const LAYER2_DEFAULT_MAX_CONCURRENCY = 10;
const LAYER2_DEFAULT_FIXED_CONCURRENCY = 2;
const LAYER2_DEFAULT_ESTIMATED_BATCH_MS = 22_000;
const LAYER2_DEFAULT_DEADLINE_BUFFER_MS = 5_000;
const LAYER2_DEFAULT_MIN_START_BUDGET_MS = 8_000;
const LAYER2_DEFAULT_RESERVED_ROUTES = 1;
const LAYER2_DEFAULT_RAMP_GROUP_SIZE = 3;
const LAYER2_DEFAULT_RAMP_INTERVAL_MS = 150;

export function normalizeVietnamese(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
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

function defectMatches(reviewText, product = {}) {
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
    const applicableMatches = categoryMatches.filter(({ quote }) => defectCategoryFitsProductContext(category, quote, product));
    if (applicableMatches.length) {
      matches.push({
        id: category,
        label: definition.label,
        severity: Number(definition.severity_weight),
        evidence: applicableMatches.slice(0, 3)
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
  // Chỉ khóa chuỗi chữ kéo dài. Số serial/SKU hoặc dấu phân cách dài không
  // được xem là spam chỉ vì có ký tự lặp.
  return new RegExp(`([a-z])\\1{${maximum},}`, 'u').test(text);
}

function gibberishSpam(text) {
  const tokens = String(text).match(/[a-z0-9]+/gu) || [];
  return tokens.some((token) => {
    if (token.length < 14) return false;
    if (/[bcdfghjklmnpqrstvwxyz]{7,}/u.test(token)) return true;
    const bigrams = new Map();
    for (let index = 0; index < token.length - 1; index += 1) {
      const pair = token.slice(index, index + 2);
      bigrams.set(pair, (bigrams.get(pair) || 0) + 1);
    }
    return Math.max(0, ...bigrams.values()) >= 4;
  });
}

const SHOPEE_TEMPLATE_HEADER_PATTERN = /\b(?:dung\s+voi\s+mo\s+ta|chat\s+luong\s+san\s+pham|tinh\s+nang\s+noi\s+bat|do\s+ben|mau\s+sac|chat\s+lieu|kich\s+thuoc|mui\s+huong|kha\s+nang\s+tuong\s+thich|hieu\s+qua\s+su\s+dung|thiet\s+ke|tinh\s+nang)\s*[:：]\s*/giu;

export function stripShopeeTemplateHeaders(text = '') {
  return normalizeVietnamese(text)
    .replace(SHOPEE_TEMPLATE_HEADER_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const explicitNoUsagePattern = /\b(?:chua\s+(?:su\s+dung|dung|xai|trai\s+nghiem|mo|boc|thu|test)|(?:phai\s+)?(?:dung|thu|xai)\s+moi\s+biet|chua\s+biet(?:\s+chat\s+luong|\s+the\s+nao)?)\b/iu;
const logisticsCuePattern = /\b(?:giao|ship|van chuyen|dong goi|goi ky|goi ki|nhan hang|shop)\b/u;
const productExperiencePattern = /\b(?:san pham|chat luong|chat lieu|su dung|dung (?:thu|on|tot|ben|duoc|lau|hang|ngay|san pham|thoi gian|vai|rat)|da dung|xai|mac|uong|giu nhiet|ben|sac|pin|size|form|mui|vi|cong nang|hoat dong|son|moi|len mau|do bam|che phu)\b/u;
const meaningfulFeedbackPattern = /\b(?:chat luong|chat lieu|do ben|chac chan|mem mai|mem|em chan|om chan|vua chan|bam chan|lot giay|lot vao|de dieu chinh|khong dau chan|im ban chan|dai|day dan|tien loi|gon|dung tich|dung do|sac nhanh|sac on dinh|khong nong|nhan dien|dung on|dung tot|rat tot|chat luong tot|san pham tot|hang tot|hoat dong tot|dung duoc|y hinh|dung mo ta|de cuon|bao hanh|mau dep|mau xinh|son dep|xoan kho|xoan nuoc|mui thom|thom|len mau|do che phu|che phu|son li|son ly|li lau|ly lau|li tren moi|ly tren moi|bam mau|nhe moi|mem moi|kho moi|nut moi|tham moi|kho tan|de tan|son tan|kho xai|kho danh|nhanh kho|mau kho|son long|qua long|rat long|tran ra|trao ra|chay son|chay nuoc|lem mau|lem ban|nhanh troi|mau troi|giu mau|nong rat|rat moi|te moi|vi man|dang mieng)\b/u;
const concreteFeedbackPattern = /\b(?:khong|ko|k|bi|loi|hong|rach|bung|dut|roi|rot|bong|nong|yeu|cham|nhanh|ben|chac|mem|em chan|om chan|vua chan|bam chan|lot giay|lot vao|de dieu chinh|khong dau chan|im ban chan|dai|mong|day|vai|nhua|kim loai|boc du|dau cam|bao hanh|son|mau|li|ly|bam mau|nhe moi|mem moi|kho moi|nut moi|tan|kho tan|nhanh kho|mau kho|long|chay|lem|troi|nong rat|rat moi|dang|\d+\s*(?:ngay|thang|nam|gio|phut|lan|lop|\/10))\b/u;

function logisticsOnlyReview(text) {
  if (!logisticsCuePattern.test(text) || productExperiencePattern.test(text)) return false;
  const stripped = text
    .replace(/\b(?:giao|hang|nhanh|ship|van chuyen|dong goi|goi|ky|ki|can than|dep|tot|ok|oke|oki|shop|nhan|duoc|sai|sài|xai|dung)\b/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  return stripped.split(/\s+/u).filter(Boolean).length <= 3;
}

const resaleCuePattern = /\b(?:can pass|pass lai|pass nha|tui pass|toi pass|minh pass|em pass|thanh ly|sang lai|ban lai)\b/u;
const resaleTransactionPattern = /\b(?:\d+(?:[.,]\d+)?k(?:\s*\/\s*(?:c|cay|chai|hop|bo))?|lay het|gia pass|nhan pass|chot|ib|inbox|bao ship)\b/u;

function resaleOnlyReview(text) {
  return resaleCuePattern.test(text) && resaleTransactionPattern.test(text);
}

const promotionalCatalogPattern = /\b(?:shop|cua hang).{0,80}\b(?:co ban|ban tat ca|chuyen ban|day du)\b.{0,100}\b(?:mat hang|hang gia dung|san pham)\b/u;
const promotionalCallToActionPattern = /\b(?:ghe|vao|tham khao|ung ho|theo doi|mua hang|dat hang).{0,40}\b(?:shop|cua hang)\b|\b(?:shop|cua hang).{0,40}\b(?:tham khao|ung ho|mua hang|dat hang)\b/u;
const externalPromotionPattern = /(?:https?:\/\/|www\.|\b(?:zalo|lien he|goi|nhan tin|inbox)\b.{0,24}\b0\d{8,10}\b|\b0\d{8,10}\b.{0,24}\b(?:zalo|lien he|goi|nhan tin|inbox)\b)/u;

function promotionalCatalogReview(text) {
  if (externalPromotionPattern.test(text)) return true;
  if (!promotionalCatalogPattern.test(text)) return false;
  const listSeparators = (String(text).match(/[,;:]/gu) || []).length;
  return promotionalCallToActionPattern.test(text) || listSeparators >= 4;
}

// Chỉ dùng cụm từ có nghĩa sản phẩm rõ ràng. Không dùng từ đơn mơ hồ sau khi
// bỏ dấu (ví dụ "đẹp" và "dép" đều thành "dep").
const productFamilies = Object.freeze({
  drinkware: ['binh nuoc', 'binh giu nhiet', 'ly giu nhiet', 'ly nuoc', 'coc nuoc', 'chai nuoc'],
  grooming: ['dao cao rau', 'may cao rau', 'luoi dao cao'],
  audio: ['tai nghe', 'loa bluetooth', 'headphone', 'earphone'],
  clothing: ['ao thun', 'ao khoac', 'quan jean', 'quan ao', 'chiec vay', 'vay dam', 'mac ao', 'mac quan'],
  footwear: ['giay', 'giay the thao', 'giay cao got', 'doi giay', 'doi dep', 'dep quai', 'dep sandal'],
  display: ['man hinh', 'gaming monitor', 'monitor', 'ultragear'],
  fan: ['quat mini', 'quat cam tay', 'quat tich dien', 'quat dien', 'cay quat', 'canh quat'],
  babyCare: ['bim', 'ta quan', 'ta dan', 'diaper'],
  household: ['hang gia dung', 'choi quet nha', 'choi quet bui', 'cay lau nha', 'cay cao nuoc', 'ban chai cha san', 'co rua toilet'],
  phoneAccessory: ['op lung', 'kinh cuong luc', 'cap sac', 'day sac', 'dau sac', 'sac du phong', 'cap type c', 'cap lightning'],
  storage: ['hop dung do', 'hop vai', 'tu vai', 'dung quan ao', 'dung do da nang']
});

const apparelFamilies = new Set(['clothing', 'footwear']);
const physicalSizeSubjectPattern = /\b(?:kich thuoc|man hinh|chan de|than may|thiet bi|san pham)\b/u;
const physicalSizeProblemPattern = /\b(?:qua (?:to|lon|rong|be|nho)|khong vua|ko vua|k vua|khong phu hop|chiem (?:nhieu|qua nhieu) (?:cho|dien tich|khong gian)|vuong viu|can tro)\b/u;

function defectCategoryFitsProductContext(category, evidence, product = {}) {
  if (category !== 'kich-co') return true;
  const targetFamilies = matchingProductFamilies(`${product?.category || ''} ${product?.title || ''}`)
    .map(({ family }) => family);
  if (targetFamilies.some((family) => apparelFamilies.has(family))) return true;

  // Ngoài thời trang, chỉ coi kích thước là nhược điểm khi cùng một mệnh đề
  // vừa chỉ rõ sản phẩm/bộ phận, vừa nêu hệ quả không phù hợp. Ví dụ
  // "góc làm việc hơi chật" mô tả không gian của người mua, không phải lỗi màn hình.
  return String(evidence || '')
    .split(/(?<=[.!?;])\s+|[,\n]+/u)
    .map(normalizeVietnamese)
    .some((clause) => physicalSizeSubjectPattern.test(clause) && physicalSizeProblemPattern.test(clause));
}

function containsFoldedPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'u').test(text);
}

function matchingProductFamilies(value) {
  const text = normalizeVietnamese(value);
  return Object.entries(productFamilies).flatMap(([family, phrases]) => {
    const matches = phrases.filter((phrase) => containsFoldedPhrase(text, phrase));
    return matches.length ? [{ family, phrases: matches }] : [];
  });
}

function assessProductRelevance(reviewText, product = {}) {
  const title = normalizeVietnamese(product?.title || '');
  if (!title || /san pham dang phan tich/u.test(title)) {
    return { state: 'unknown', targetFamilies: [], reviewFamilies: [], targetEvidence: [], otherEvidence: [] };
  }
  const titleFamilies = matchingProductFamilies(title);
  const reviewFamilies = matchingProductFamilies(reviewText);
  const targetFamilyIds = new Set(titleFamilies.map(({ family }) => family));
  const targetEvidence = reviewFamilies.filter(({ family }) => targetFamilyIds.has(family));
  const otherEvidence = reviewFamilies.filter(({ family }) => !targetFamilyIds.has(family));
  const state = !titleFamilies.length || !reviewFamilies.length
    ? 'unknown'
    : targetEvidence.length
      ? 'on_topic'
      : otherEvidence.length
        ? 'needs_review'
        : 'unknown';
  return {
    state,
    targetFamilies: [...targetFamilyIds],
    reviewFamilies: reviewFamilies.map(({ family }) => family),
    targetEvidence: targetEvidence.flatMap(({ phrases }) => phrases),
    otherEvidence: otherEvidence.flatMap(({ phrases }) => phrases)
  };
}

function assessInformationValue(text, defects, flags = {}) {
  if (flags.gibberish || flags.iconOnly || flags.repeated || flags.resaleOnly || flags.rewardMotivated || flags.promotional || flags.exaggerated) return 'none';
  if (flags.logisticsOnly || flags.generic || flags.noUsageExperience || !text) return 'low';
  const structuralSpecificity = assessStructuralSpecificity(text);
  if (defects.length || (meaningfulFeedbackPattern.test(text) && concreteFeedbackPattern.test(text)) || structuralSpecificity === 'high') return 'high';
  if (meaningfulFeedbackPattern.test(text) || structuralSpecificity === 'medium') return 'medium';
  return 'low';
}

const concreteMeasurementPattern = /\b\d+(?:[.,]\d+)?\s*(?:hz|khz|mhz|w|kw|wh|mah|v|a|cm|mm|m|kg|g|ml|l|inch|in|gb|tb|mb|mp|che do|mau|ngay|thang|nam|gio|phut|lan)\b/gu;
const groundedExperiencePattern = /\b(?:phu hop|de dang|dieu chinh|canh chinh|su dung|da dung|dung thu|xai thu|cam thay|thuc te|diem cong|diem tru|uu diem|nhuoc diem|duy nhat|khong bi|co mui|am thanh|hinh anh|mau sac|kich thuoc|do sang|len mau|che phu|bam mau|kho moi|kho tan|nhanh troi|mau troi|nong rat|dang mieng)\b/gu;
const balancedObservationPattern = /\b(?:diem tru|diem cong|uu diem|nhuoc diem|nhung|tuy nhien|con lai|duy nhat)\b/u;
const exaggeratedClaimPattern = /\b(?:tuyet voi|hoan hao|xuat sac|dinh cua chop|sieu pham|tot nhat|so mot|than toc|cuc ky|vo cung|khong the tot hon|te nhat|kinh khung|khung khiep|tham hoa|rac ruoi|vo dung|lua dao|khong the chap nhan)\b|100\s*%/gu;

function exaggeratedOpinionReview(text) {
  const claims = String(text).match(exaggeratedClaimPattern) || [];
  if (claims.length < 3) return false;
  const grounded = (String(text).match(concreteMeasurementPattern) || []).length > 0
    || balancedObservationPattern.test(String(text));
  return !grounded;
}

function assessStructuralSpecificity(text = '') {
  const tokens = String(text).split(/\s+/u).filter(Boolean);
  const clauses = String(text)
    .split(/[.!?;,\n]+|\s+(?:nhung|tuy nhien|diem tru|diem cong)\s+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/u).length >= 3);
  const measurements = String(text).match(concreteMeasurementPattern) || [];
  const experienceSignals = String(text).match(groundedExperiencePattern) || [];
  const balanced = balancedObservationPattern.test(String(text));
  const concreteAnchors = measurements.length + Math.min(experienceSignals.length, 3) + Number(balanced);

  if (experienceSignals.length >= 1 && tokens.length >= 24 && clauses.length >= 3 && concreteAnchors >= 3) return 'high';
  if (experienceSignals.length >= 1 && tokens.length >= 12 && clauses.length >= 2 && concreteAnchors >= 2) return 'medium';
  return 'low';
}

function baseLabels(layer1) {
  return {
    hard_reject: layer1.hard_reject,
    is_seeding: layer1.is_seeding,
    is_low_value: layer1.is_low_value,
    is_vague: layer1.is_vague,
    is_off_topic: layer1.is_off_topic,
    relevance: layer1.relevance,
    information_value: layer1.information_value,
    has_defect: layer1.has_defect,
    defect_categories: [...layer1.defect_categories],
    defect_quote: layer1.defect_quote,
    confidence: layer1.confidence,
    reason_code: layer1.reason_codes[0] || 'NO_RULE_MATCH'
  };
}

function canUseConservativeFallback(layer1) {
  // Nếu Layer 2 không trả được kết quả sau retry, chỉ giữ nguyên quyết định
  // loại của các quy tắc chắc chắn. Mọi ứng viên ngữ nghĩa còn lại được giữ để
  // sự cố AI không biến thành loại oan review thật.
  return !layer1.hard_reject;
}

export function labelReviewLayer1(review = {}, index = 0, product = {}) {
  const originalText = String(review.text || '').trim();
  const text = normalizeVietnamese(originalText);
  const cleanText = stripShopeeTemplateHeaders(text);
  const defects = defectMatches(originalText, product);
  const rating = Number(review.rating) || 0;
  const exactSeeding = rules.seeding_detection.exact_phrases.find((phrase) => text.includes(normalizeVietnamese(phrase)));
  const strongSeeding = exactSeeding ? null : matchAny(strongSeedingPatterns, text);
  const weakSeeding = matchAny(weakSeedingPatterns, text);

  // Chỉ khóa khi văn bản nói rõ động cơ nhận xu/điểm/thưởng. Câu mô tả ảnh
  // "mang tính chất minh họa" đứng riêng không phải bằng chứng nhận thưởng.
  const rewardMotivated = Boolean(exactSeeding || strongSeeding);
  const isSeeding = rewardMotivated;

  const effectiveText = cleanText || text;
  const tokens = effectiveText ? effectiveText.split(/\s+/u) : [];
  const generic = rules.spam_and_low_value.generic_short_phrases.some((phrase) => effectiveText === normalizeVietnamese(phrase));
  const iconOnly = Boolean(originalText && iconOnlyPattern.test(originalText));
  const gibberish = gibberishSpam(effectiveText);
  const logisticsOnly = logisticsOnlyReview(effectiveText);
  // Bài đăng sang tay/thanh lý không phải đánh giá chất lượng. Chỉ khóa khi
  // đồng thời có lời rao bán, giá/liên hệ giao dịch và không có lỗi sản phẩm.
  const resaleOnly = resaleOnlyReview(effectiveText) && defects.length === 0;
  const promotional = promotionalCatalogReview(effectiveText);
  // Cường điệu là tín hiệu cần kiểm định ngữ nghĩa, không phải lý do loại cứng.
  const exaggerated = exaggeratedOpinionReview(effectiveText);
  const tooShort = effectiveText.length < Number(rules.spam_and_low_value.min_character_length)
    || tokens.length < Number(rules.spam_and_low_value.min_token_count);
  const repeated = repeatedCharacterSpam(effectiveText);
  const relevanceAssessment = assessProductRelevance(originalText, product);
  const offTopicCandidate = relevanceAssessment.state === 'needs_review';

  // Không dùng template header "Chất lượng sản phẩm:" để tự kích hoạt meaningfulFeedback
  const meaningfulFeedback = !generic && meaningfulFeedbackPattern.test(effectiveText);
  const hasConcreteEvidence = defects.length > 0
    || (meaningfulFeedback && concreteFeedbackPattern.test(effectiveText));
  // Nội dung dưới ngưỡng tối thiểu và không nêu được thuộc tính/lỗi cụ thể
  // không đủ làm bằng chứng. Câu ngắn nhưng có bằng chứng cụ thể vẫn được giữ.
  const shortWithoutEvidence = tooShort && !hasConcreteEvidence;
  const deterministicHardReject = gibberish || iconOnly || repeated || resaleOnly
    || rewardMotivated || promotional;
  const noUsageExperience = !hasConcreteEvidence && explicitNoUsagePattern.test(effectiveText);

  const lowValueCandidate = !effectiveText || generic || iconOnly || repeated || gibberish || logisticsOnly || resaleOnly || rewardMotivated || promotional || exaggerated || tooShort || noUsageExperience;
  // Tín hiệu rác chắc chắn không được phép bị một tiền tố chung như
  // "Chất lượng sản phẩm:" mở khóa.
  const isLowValue = rewardMotivated || promotional || exaggerated || shortWithoutEvidence || (defects.length === 0
    && (deterministicHardReject || (lowValueCandidate && !meaningfulFeedback)));
  const informationValue = assessInformationValue(effectiveText, defects, {
    generic, iconOnly, repeated, gibberish, logisticsOnly, resaleOnly, rewardMotivated, promotional, exaggerated, tooShort, noUsageExperience
  });
  const rantKeyword = rules.vague_rant_detection.rant_keywords.find((keyword) => text.includes(normalizeVietnamese(keyword)));
  const vagueRating = rules.vague_rant_detection.trigger_ratings.includes(rating);
  const isVague = vagueRating
    && defects.length === 0
    && Boolean(rantKeyword || isLowValue || text.length <= Number(rules.vague_rant_detection.max_length_without_defect));
  const reasonCodes = [];
  const evidence = [];
  if (rewardMotivated) {
    reasonCodes.push('LOW_VALUE_REWARD_CONTENT');
    evidence.push({ label: 'reward_motivated_content', rule: exactSeeding || strongSeeding, quote: originalText.slice(0, 180) });
  }
  if (promotional) {
    reasonCodes.push('LOW_VALUE_PROMOTIONAL_CONTENT');
    evidence.push({ label: 'promotional_catalog', rule: 'catalog_listing_with_shop_promotion', quote: originalText.slice(0, 180) });
  }
  if (exaggerated) {
    reasonCodes.push('LOW_VALUE_EXAGGERATED_LANGUAGE');
    evidence.push({ label: 'exaggerated_language', rule: 'multiple_absolute_claims_without_grounding', quote: originalText.slice(0, 180) });
  }
  if (weakSeeding && !rewardMotivated) {
    reasonCodes.push('SEEDING_WEAK_CUE');
    evidence.push({ label: 'seeding_candidate', rule: weakSeeding, quote: originalText.slice(0, 180) });
  }
  if (isLowValue && !rewardMotivated && !promotional) {
    reasonCodes.push(
      gibberish ? 'LOW_VALUE_GIBBERISH'
        : logisticsOnly ? 'LOW_VALUE_LOGISTICS_ONLY'
          : resaleOnly ? 'LOW_VALUE_RESALE_ONLY'
        : noUsageExperience ? 'LOW_VALUE_NO_USAGE_EXPERIENCE'
        : generic ? 'LOW_VALUE_GENERIC'
        : iconOnly ? 'LOW_VALUE_ICON_ONLY'
        : repeated ? 'LOW_VALUE_REPETITION'
        : 'LOW_VALUE_SHORT'
    );
  }
  if (resaleOnly) {
    evidence.push({ label: 'resale_only', rule: 'resale_transaction', quote: originalText.slice(0, 180) });
  }
  if (offTopicCandidate) {
    reasonCodes.push('OFF_TOPIC_CANDIDATE');
    evidence.push({
      label: 'off_topic_candidate',
      rule: `other_product:${relevanceAssessment.otherEvidence.join('|')}`,
      quote: originalText.slice(0, 180)
    });
  }
  if (isVague) reasonCodes.push(rantKeyword ? 'VAGUE_RANT' : 'VAGUE_WITHOUT_DEFECT');
  for (const defect of defects) {
    reasonCodes.push(`DEFECT_${defect.id.toUpperCase().replaceAll('-', '_')}`);
    evidence.push(...defect.evidence.map((item) => ({ label: defect.id, rule: item.keyword, quote: item.quote })));
  }

  const conflicts = [];
  if (isSeeding && defects.length) conflicts.push('SEEDING_WITH_CONCRETE_DEFECT');
  if (weakSeeding && !isSeeding) conflicts.push('WEAK_SEEDING_CUE_ONLY');
  const signalConfidence = promotional ? 0.98
    : exaggerated ? 0.96
    : shortWithoutEvidence ? 0.97
    : gibberish ? 0.97
    : exactSeeding ? 0.99
    : strongSeeding ? 0.94
      : defects.length ? 0.92
        : meaningfulFeedback ? 0.91
          : informationValue === 'high' ? 0.91
            : informationValue === 'medium' ? 0.86
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
    // Layer 1 không tự kết luận off-topic. Gemini phải xác nhận ứng viên bằng
    // trích dẫn nguyên văn để tránh false positive từ chuẩn hóa/ngữ cảnh.
    is_off_topic: false,
    relevance: relevanceAssessment.state,
    information_value: informationValue,
    has_defect: defects.length > 0,
    defect_categories: defects.map((defect) => defect.id),
    defect_quote: defects[0]?.evidence?.[0]?.quote || null,
    confidence,
    reason_codes: reasonCodes.length ? reasonCodes : ['NO_RULE_MATCH'],
    evidence,
    conflicts,
    hard_reject: deterministicHardReject,
    // Review ngắn, generic, cường điệu, off-topic chưa chắc chắn hoặc chưa khớp
    // từ điển đều phải qua Gemini. Layer 1 chỉ khóa tín hiệu xác định bằng luật.
    requires_llm: !deterministicHardReject && (
      isLowValue || offTopicCandidate || conflicts.length > 0
      || confidence < Number(policy.llm_review_confidence_below)
    )
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
          relevance: { type: 'string', enum: ['on_topic', 'uncertain', 'off_topic'] },
          information_value: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
          has_defect: { type: 'boolean' },
          defect_categories: { type: 'array', items: { type: 'string', enum: [...allowedCategories] }, maxItems: 5 },
          defect_quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          defect_evidence: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                category: { type: 'string', enum: [...allowedCategories] },
                quote: { type: 'string' }
              },
              required: ['category', 'quote']
            }
          },
          evidence_quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason_code: { type: 'string' }
        },
        required: ['id', 'decision', 'is_seeding', 'is_low_value', 'is_vague', 'is_off_topic', 'relevance', 'information_value', 'has_defect', 'defect_categories', 'defect_quote', 'defect_evidence', 'evidence_quote', 'confidence', 'reason_code']
      }
    }
  },
  required: ['labels']
};

function normalizeLayer2Label(candidate, review, layer1) {
  if (!candidate || !['confirm', 'correct', 'abstain'].includes(candidate.decision)) return null;
  const categories = [...new Set((Array.isArray(candidate.defect_categories) ? candidate.defect_categories : [])
    .filter((category) => allowedCategories.has(category)))];
  const confidence = clamp(candidate.confidence);
  if (candidate.decision === 'abstain' || confidence < 0.65) {
    return { decision: 'abstain', confidence, reason_code: String(candidate.reason_code || 'LLM_ABSTAIN') };
  }
  const text = String(review.text || '');
  const quote = typeof candidate.defect_quote === 'string' && text.includes(candidate.defect_quote.trim())
    ? candidate.defect_quote.trim()
    : null;
  const evidenceByCategory = new Map();
  for (const item of Array.isArray(candidate.defect_evidence) ? candidate.defect_evidence : []) {
    const category = String(item?.category || '');
    const itemQuote = typeof item?.quote === 'string' ? item.quote.trim() : '';
    if (allowedCategories.has(category) && itemQuote && text.includes(itemQuote)) {
      evidenceByCategory.set(category, itemQuote);
    }
  }
  // Tương thích cache cũ chỉ khi LLM gắn đúng một category.
  if (categories.length === 1 && quote && !evidenceByCategory.has(categories[0])) {
    evidenceByCategory.set(categories[0], quote);
  }
  const evidenceQuote = typeof candidate.evidence_quote === 'string' && text.includes(candidate.evidence_quote.trim())
    ? candidate.evidence_quote.trim()
    : null;
  if (candidate.has_defect && (!categories.length || !quote || categories.some((category) => !evidenceByCategory.has(category)))) {
    return {
      decision: 'abstain',
      confidence,
      reason_code: !categories.length
        ? 'INVALID_DEFECT_CATEGORY'
        : !quote
          ? 'DEFECT_QUOTE_NOT_VERBATIM'
          : 'DEFECT_CATEGORY_EVIDENCE_MISSING'
    };
  }
  // Layer 2 là tầng quyết định ngữ nghĩa. Backend chỉ kiểm tra schema, taxonomy
  // và trích dẫn nguyên văn; không dùng từ điển hoặc kết luận Layer 1 để phủ
  // quyết một kết quả Gemini hợp lệ.
  const hasDefect = Boolean(candidate.has_defect && categories.length && quote);
  const isVague = Boolean(candidate.is_vague && !hasDefect);
  const isLowValue = Boolean(candidate.is_low_value && !hasDefect);
  const requestedRelevance = ['on_topic', 'uncertain', 'off_topic'].includes(candidate.relevance)
    ? candidate.relevance
    : candidate.is_off_topic
      ? 'off_topic'
      : 'on_topic';
  const informationValue = ['high', 'medium', 'low', 'none'].includes(candidate.information_value)
    ? candidate.information_value
    : layer1.information_value;
  const wantsOffTopic = Boolean(candidate.is_off_topic || requestedRelevance === 'off_topic');
  if (wantsOffTopic && (!evidenceQuote || confidence < 0.8)) {
    return {
      decision: 'abstain',
      confidence,
      reason_code: !evidenceQuote ? 'OFF_TOPIC_EVIDENCE_NOT_VERBATIM' : 'OFF_TOPIC_CONFIDENCE_TOO_LOW'
    };
  }
  const isOffTopic = wantsOffTopic;
  const relevance = isOffTopic ? 'off_topic' : requestedRelevance;
  const changed = ['is_seeding', 'is_vague', 'has_defect'].some((key) => Boolean(candidate[key]) !== Boolean(layer1[key]))
    || isLowValue !== Boolean(layer1.is_low_value)
    || isOffTopic !== Boolean(layer1.is_off_topic)
    || relevance !== layer1.relevance
    || informationValue !== layer1.information_value
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
    relevance,
    information_value: informationValue,
    has_defect: hasDefect,
    defect_categories: hasDefect ? categories : [],
    defect_quote: hasDefect ? quote : null,
    evidence_quote: evidenceQuote,
    confidence,
    reason_code: String(candidate.reason_code || 'LLM_REVIEWED').slice(0, 80),
    changed
  };
}

export async function classifyBatchWithGemini(batch, product, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-3.5-flash-lite';
  const payload = batch.map(({ review, layer1 }) => ({
    id: layer1.id,
    rating: Number(review.rating) || 0,
    text: String(review.text || '').slice(0, 1000),
    verified: typeof review.verified === 'boolean' ? review.verified : null,
    layer1: {
      is_seeding: layer1.is_seeding,
      is_low_value: layer1.is_low_value,
      is_vague: layer1.is_vague,
      relevance: layer1.relevance,
      information_value: layer1.information_value,
      has_defect: layer1.has_defect,
      defect_categories: layer1.defect_categories,
      confidence: layer1.confidence,
      reason_codes: layer1.reason_codes,
      evidence: layer1.evidence
    }
  }));
  const prompt = [
    layer2Config.system_instruction,
    ...layer2Config.decision_rules.map((rule, index) => `${index + 1}. ${rule}`),
    'decision=confirm nếu Layer 1 đúng; correct nếu có đủ bằng chứng để sửa; abstain nếu chưa đủ bằng chứng.',
    'Không được dùng rating một mình để kết luận seeding hoặc giả mạo.',
    `Ngữ cảnh sản phẩm: ${JSON.stringify({ title: product?.title || null, category: product?.category || null, platform: product?.platform || null })}`,
    `Dữ liệu cần kiểm định: ${JSON.stringify(payload)}`
  ].join('\n');
  const validateResponse = async (response) => {
      const body = await response.json();
      const parsed = parseGeminiJson(body, 'Gemini labeler');
      if (!Array.isArray(parsed.labels)) throw new Error('Thiếu mảng labels.');
      const expectedIds = new Set(batch.map(({ layer1 }) => String(layer1.id)));
      const returnedIds = parsed.labels.map((candidate) => String(candidate?.id || ''));
      if (returnedIds.length !== expectedIds.size || new Set(returnedIds).size !== returnedIds.length
        || returnedIds.some((id) => !expectedIds.has(id))) {
        throw new Error(`Kết quả phải chứa đúng ${expectedIds.size} nhãn với ID không trùng.`);
      }
      return parsed.labels;
  };
  const requestGemini = options.requestGeminiImpl || requestGeminiWithFallback;
  const run = (maxRetries, signal, avoidBusyRoutes = false) => requestGemini({
    fetchImpl: options.fetchImpl,
    redisFetchImpl: options.redisFetchImpl,
    apiKey,
    primaryModel: model,
    context: 'Gemini labeler',
    deadlineAt: options.deadlineAt,
    attemptTimeoutMs: 25_000,
    maxRetries,
    retryOnTimeout: true,
    routeContext: options.routeContext,
    avoidBusyRoutes,
    validateResponse,
    buildRequest: (selectedModel, selectedApiKey) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': selectedApiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          thinkingConfig: geminiThinkingConfig('minimal', selectedModel),
          responseMimeType: 'application/json',
          responseSchema: layer2ResponseSchema
        }
      }),
      signal
    })
  });
  // Hai route tuần tự: tránh hedge tạo burst khiến mọi key cùng chạm RPM.
  // requestGeminiWithFallback luôn ưu tiên route có bộ đếm thấp nhất.
  const geminiResult = await run(LAYER2_MAX_ROUTE_ATTEMPTS - 1, options.signal, true);
  return {
    labels: geminiResult.value,
    retry: {
      model: geminiResult.model,
      attemptedModels: geminiResult.attemptedModels || [],
      credentialAttempts: geminiResult.attemptedCredentialIds?.length || (geminiResult.credentialId ? 1 : 0),
      reservationRejects: geminiResult.reservationRejects || [],
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

function integerSetting(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

function booleanSetting(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

export function calculateLayer2Concurrency({
  remainingBatches,
  maxConcurrency = LAYER2_DEFAULT_MAX_CONCURRENCY,
  routeCapacity = maxConcurrency
} = {}) {
  const batches = Math.max(0, Number.parseInt(remainingBatches, 10) || 0);
  if (!batches) return 0;
  const capacity = Math.max(1, Number.parseInt(routeCapacity, 10) || 1);
  const ceiling = Math.max(1, Math.min(batches, maxConcurrency, capacity));
  // Ưu tiên một wave khi pool còn route kỹ thuật khả dụng. Deadline vẫn được
  // kiểm tra trước mỗi lần schedule, còn EWMA chỉ dùng xếp hạng route.
  return ceiling;
}

async function mapWithAdaptiveConcurrency(items, options, mapper) {
  if (!items.length) return { results: [], peakConcurrency: 0, initialConcurrency: 0, skippedDeadline: 0 };
  const results = new Array(items.length);
  const adaptive = options.adaptive;
  const startedAt = Date.now();
  let estimatedBatchMs = options.estimatedBatchMs;
  let cursor = 0;
  let active = 0;
  let completed = 0;
  let peakConcurrency = 0;
  let initialConcurrency = 0;
  let skippedDeadline = 0;

  return new Promise((resolve) => {
    const emitState = (targetConcurrency) => options.onState?.({
      completed,
      total: items.length,
      running: active,
      targetConcurrency,
      peakConcurrency,
      skippedDeadline,
      estimatedBatchMs: Math.round(estimatedBatchMs),
      elapsedMs: Date.now() - startedAt
    });

    const schedule = () => {
      const nowMs = Date.now();
      const deadlineAt = Number(options.deadlineAt);
      const finiteDeadline = Number.isFinite(deadlineAt);
      const usableRemainingMs = finiteDeadline
        ? deadlineAt - nowMs - options.deadlineBufferMs
        : Number.POSITIVE_INFINITY;
      if (finiteDeadline && deadlineAt - nowMs < options.minStartBudgetMs) {
        while (cursor < items.length) {
          results[cursor] = options.skipFactory(items[cursor], cursor);
          cursor += 1;
          completed += 1;
          skippedDeadline += 1;
        }
      }

      const remainingBatches = items.length - completed;
      const targetConcurrency = adaptive
        ? calculateLayer2Concurrency({
            remainingBatches,
            remainingMs: usableRemainingMs,
            estimatedBatchMs,
            baseConcurrency: options.baseConcurrency,
            maxConcurrency: options.maxConcurrency,
            routeCapacity: options.routeCapacity
          })
        : Math.min(remainingBatches, options.fixedConcurrency, options.routeCapacity);
      if (!initialConcurrency && targetConcurrency) initialConcurrency = targetConcurrency;
      emitState(targetConcurrency);

      while (cursor < items.length && active < targetConcurrency) {
        const index = cursor;
        cursor += 1;
        active += 1;
        peakConcurrency = Math.max(peakConcurrency, active);
        const batchStartedAt = Date.now();
        Promise.resolve(mapper(items[index], index))
          .then((value) => { results[index] = value; })
          .catch((error) => { results[index] = options.errorFactory(error, items[index], index); })
          .finally(() => {
            const observedMs = Math.max(1, Date.now() - batchStartedAt);
            estimatedBatchMs = Math.min(25_000, Math.max(5_000,
              Math.round(estimatedBatchMs * 0.65 + observedMs * 0.35)
            ));
            active -= 1;
            completed += 1;
            schedule();
          });
      }

      if (completed >= items.length && active === 0) {
        emitState(0);
        resolve({ results, peakConcurrency, initialConcurrency, skippedDeadline });
      }
    };
    schedule();
  });
}

export async function labelReviewsTwoLayer(reviews = [], options = {}) {
  const layer2StartedAt = Date.now();
  const prepared = reviews.map((review, index) => ({ review, layer1: labelReviewLayer1(review, index, options.product) }));
  // Phát hiện bản sao trước khi gọi Gemini để một nội dung lặp không tiêu hao
  // nhiều request/token. Bản đại diện được chọn ổn định, không phụ thuộc thứ tự.
  const duplicateAudit = annotateReviewDuplicates(prepared.map(({ review, layer1 }) => ({
    ...review,
    labelId: layer1.id,
    labels: baseLabels(layer1)
  })));
  const duplicateById = new Map(duplicateAudit.reviews
    .filter((review) => review.labels?.is_duplicate)
    .map((review) => [String(review.labelId), {
      is_duplicate: true,
      duplicate_of: review.labels.duplicate_of,
      duplicate_similarity: review.labels.duplicate_similarity,
      duplicate_rating_conflict: Boolean(review.labels.duplicate_rating_conflict),
      duplicate_semantic_conflict: Boolean(review.labels.duplicate_semantic_conflict),
      reason_code: review.labels.reason_code || 'DUPLICATE_CONTENT'
    }]));
  const uniquePrepared = prepared.filter(({ layer1 }) => !duplicateById.has(String(layer1.id)));
  const mode = options.mode || process.env.LABELER_LLM_MODE || 'uncertain';
  const selectedByMode = mode === 'off' ? [] : mode === 'uncertain' ? uniquePrepared.filter((item) => item.layer1.requires_llm) : uniquePrepared;
  // Hard reject là quyết định cuối của Layer 1: không gửi sang Gemini ở bất kỳ
  // chế độ nào để AI không thể mở khóa nội dung nhận xu hoặc rác chắc chắn.
  const selected = selectedByMode.filter((item) => !item.layer1.hard_reject);
  const selectedIds = new Set(selected.map((item) => String(item.layer1.id)));
  if (typeof options.onLayer1Stats === 'function') {
    try {
      options.onLayer1Stats({
        total: reviews.length,
        duplicateCount: duplicateAudit.duplicateCount,
        hardRejected: prepared.filter(({ layer1 }) => layer1.hard_reject).length,
        semanticReviewCount: selected.length
      });
    } catch {
      // A disconnected progress consumer must not interrupt the labeler.
    }
  }
  const batchSize = Math.min(12, Math.max(8, Number.parseInt(
    process.env.LABELER_LLM_BATCH_SIZE || String(LAYER2_DEFAULT_BATCH_SIZE), 10
  ) || LAYER2_DEFAULT_BATCH_SIZE));
  const warnings = [];
  // Mỗi yêu cầu phân tích mới phải được Gemini kiểm định lại. localStorage chỉ
  // phục vụ thao tác mở lịch sử ở trình duyệt, không được thay thế lượt Layer 2.
  const layer2ById = new Map();
  const cacheHits = 0;
  const model = 'gemini-3.5-flash-lite';
  const batches = chunks(selected, batchSize);
  let succeededBatches = 0;
  let failedBatches = 0;
  let retryAttempts = 0;
  let credentialSwitches = 0;
  let reservationRejectCount = 0;
  const modelsUsed = new Set();
  const batchDurationsMs = [];
  const schedulerOverrides = options.scheduler || {};
  const adaptiveConcurrency = booleanSetting(
    schedulerOverrides.adaptive ?? process.env.LAYER2_ADAPTIVE_CONCURRENCY,
    true
  );
  const baseConcurrency = integerSetting(
    schedulerOverrides.baseConcurrency ?? process.env.LAYER2_BASE_CONCURRENCY,
    LAYER2_DEFAULT_BASE_CONCURRENCY,
    1,
    10
  );
  const maxConcurrency = integerSetting(
    schedulerOverrides.maxConcurrency ?? process.env.LAYER2_MAX_CONCURRENCY,
    LAYER2_DEFAULT_MAX_CONCURRENCY,
    baseConcurrency,
    10
  );
  const fixedConcurrency = integerSetting(
    schedulerOverrides.fixedConcurrency ?? process.env.LAYER2_FIXED_CONCURRENCY,
    LAYER2_DEFAULT_FIXED_CONCURRENCY,
    1,
    10
  );
  const deadlineBufferMs = integerSetting(
    schedulerOverrides.deadlineBufferMs ?? process.env.LAYER2_DEADLINE_BUFFER_MS,
    LAYER2_DEFAULT_DEADLINE_BUFFER_MS,
    0,
    15_000
  );
  const minStartBudgetMs = integerSetting(
    schedulerOverrides.minStartBudgetMs ?? process.env.LAYER2_MIN_START_BUDGET_MS,
    LAYER2_DEFAULT_MIN_START_BUDGET_MS,
    1_500,
    25_000
  );
  const reservedRoutes = integerSetting(
    schedulerOverrides.reservedRoutes ?? process.env.LAYER2_RESERVED_ROUTES,
    LAYER2_DEFAULT_RESERVED_ROUTES,
    0,
    5
  );
  const rampGroupSize = integerSetting(
    schedulerOverrides.rampGroupSize ?? process.env.LAYER2_RAMP_GROUP_SIZE,
    LAYER2_DEFAULT_RAMP_GROUP_SIZE,
    1,
    10
  );
  const rampIntervalMs = integerSetting(
    schedulerOverrides.rampIntervalMs ?? process.env.LAYER2_RAMP_INTERVAL_MS,
    LAYER2_DEFAULT_RAMP_INTERVAL_MS,
    0,
    1_000
  );
  let estimatedBatchMs = integerSetting(
    schedulerOverrides.estimatedBatchMs ?? process.env.LAYER2_ESTIMATED_BATCH_MS,
    LAYER2_DEFAULT_ESTIMATED_BATCH_MS,
    5_000,
    25_000
  );
  let availableRoutes = maxConcurrency;
  let routeCapacity = maxConcurrency;
  let initialConcurrency = 0;
  let peakConcurrency = 0;
  let skippedDeadlineBatches = 0;
  if (selected.length && (process.env.GEMINI_API_KEY || isRedisConfigured())) {
    if (Number.isFinite(Number(schedulerOverrides.routeCapacity))) {
      availableRoutes = integerSetting(schedulerOverrides.routeCapacity, maxConcurrency, 1, 200);
    } else if (!options.requestGeminiImpl) {
      try {
        const capacity = await (options.getGeminiRouteCapacityImpl || getGeminiRouteCapacity)({
          apiKey: process.env.GEMINI_API_KEY,
          redisFetchImpl: options.redisFetchImpl
        });
        availableRoutes = Math.max(1, Number(capacity.availableRoutes) || 1);
        if (Number(capacity.estimatedLatencyMs) > 0 && schedulerOverrides.estimatedBatchMs === undefined) {
          estimatedBatchMs = integerSetting(capacity.estimatedLatencyMs, estimatedBatchMs, 5_000, 25_000);
        }
      } catch (error) {
        availableRoutes = Math.max(1, baseConcurrency);
        warnings.push(`Không đọc được dung lượng Gemini pool; scheduler dùng giới hạn an toàn mặc định: ${error?.message || 'không rõ lỗi'}.`);
      }
    }
    routeCapacity = Math.max(1, Math.min(maxConcurrency, availableRoutes - Math.min(reservedRoutes, availableRoutes - 1)));
    const scheduled = await mapWithAdaptiveConcurrency(batches, {
      adaptive: adaptiveConcurrency,
      baseConcurrency,
      maxConcurrency,
      fixedConcurrency,
      routeCapacity,
      estimatedBatchMs,
      deadlineAt: options.geminiContext?.layer2DeadlineAt,
      deadlineBufferMs,
      minStartBudgetMs,
      skipFactory: () => ({
        labels: [],
        skippedReason: 'deadline',
        warning: 'Layer 2 bỏ qua batch chưa khởi chạy vì không còn đủ ngân sách thời gian.'
      }),
      errorFactory: (error) => {
        failedBatches += 1;
        return { labels: [], warning: error?.message || 'Layer 2 không phản hồi.' };
      },
      onState: (state) => {
        if (typeof options.onLayer2Progress !== 'function') return;
        try {
          options.onLayer2Progress({
            ...state,
            adaptive: adaptiveConcurrency,
            availableRoutes,
            routeCapacity
          });
        } catch {
          // Cập nhật tiến độ không được phép ảnh hưởng quyết định Layer 2.
        }
      }
    }, async (batch, batchIndex) => {
      try {
        const rampDelayMs = Math.floor(batchIndex / rampGroupSize) * rampIntervalMs;
        if (rampDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, rampDelayMs));
        const result = await classifyBatchWithGemini(batch, options.product, {
          fetchImpl: options.fetchImpl || fetch,
          deadlineAt: options.geminiContext?.layer2DeadlineAt,
          routeContext: options.geminiContext,
          signal: options.signal,
          redisFetchImpl: options.redisFetchImpl,
          requestGeminiImpl: options.requestGeminiImpl
        });
        succeededBatches += 1;
        const attemptedCount = result.retry?.attemptedModels?.length || 1;
        retryAttempts += Math.max(0, attemptedCount - 1);
        credentialSwitches += Math.max(0, (result.retry?.credentialAttempts || 1) - 1);
        reservationRejectCount += result.retry?.reservationRejects?.length || 0;
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
        const attemptedCount = error?.attemptedModels?.length || 0;
        retryAttempts += Math.max(0, attemptedCount - 1);
        credentialSwitches += Math.max(0, (error?.attemptedCredentialIds?.length || 0) - 1);
        reservationRejectCount += error?.reservationRejects?.length || 0;
        for (const attemptedModel of error?.attemptedModels || []) modelsUsed.add(attemptedModel);
        const warning = error?.message || 'Layer 2 không phản hồi.';
        if (process.env.VERCEL || options.logLayer2Errors) {
          (options.logger || console).error('[review-labeler] Layer 2 batch failed', {
            batch: batchIndex + 1,
            totalBatches: batches.length,
            reviewCount: batch.length,
            model,
            attemptedModels: error?.attemptedModels || [],
            attemptedRouteIds: error?.attemptedRouteIds || [],
            reservationRejects: error?.reservationRejects || [],
            credentialAttempts: error?.attemptedCredentialIds?.length || 0,
            error: warning
          });
        }
        return { labels: [], warning };
      }
    });
    const results = scheduled.results;
    initialConcurrency = scheduled.initialConcurrency;
    peakConcurrency = scheduled.peakConcurrency;
    skippedDeadlineBatches = scheduled.skippedDeadline;
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
    const duplicate = duplicateById.get(String(layer1.id));
    const safeLayer1Fallback = Boolean(selectedIds.has(String(layer1.id)) && !accepted && canUseConservativeFallback(layer1));
    const layer2Unavailable = Boolean(!duplicate && layer1.requires_llm && !accepted && !safeLayer1Fallback);
    const semanticFinal = accepted ? {
      is_seeding: layer2.is_seeding,
      is_low_value: layer2.is_low_value,
      is_vague: layer2.is_vague,
      is_off_topic: layer2.is_off_topic,
      relevance: layer2.relevance,
      information_value: layer2.information_value,
      has_defect: layer2.has_defect,
      defect_categories: layer2.defect_categories,
      defect_quote: layer2.defect_quote,
      confidence: layer2.confidence,
      reason_code: layer2.reason_code,
      layer2_unavailable: false,
      reviewed_by: 'gemini-layer2'
    } : {
      ...baseLabels(layer1),
      layer2_unavailable: layer2Unavailable,
      layer2_fallback_accepted: safeLayer1Fallback,
      reviewed_by: safeLayer1Fallback ? 'layer1-safe-fallback' : 'layer1'
    };
    const final = duplicate ? { ...semanticFinal, ...duplicate } : semanticFinal;
    return {
      ...review,
      labelId: layer1.id,
      labels: final,
      labeling: { layer1, layer2, final, pipelineVersion: REVIEW_PIPELINE_VERSION }
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
      skippedDeadlineBatches,
      retryAttempts,
      credentialSwitches,
      reservationRejectCount,
      batchDurationsMs,
      cacheHits,
      adaptiveConcurrency,
      initialConcurrency,
      peakConcurrency,
      availableRoutes,
      routeCapacity,
      rampGroupSize,
      rampIntervalMs,
      coverage: selected.length ? layer2ById.size / selected.length : 1
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
      layer2SkippedDeadlineBatches: skippedDeadlineBatches,
      layer2Concurrency: {
        adaptive: adaptiveConcurrency,
        initial: initialConcurrency,
        peak: peakConcurrency,
        availableRoutes,
        routeCapacity
      },
      layer2Coverage: selected.length ? layer2ById.size / selected.length : 1,
      layer2Retry: { retryAttempts, credentialSwitches, reservationRejectCount, modelsUsed: [...modelsUsed] },
      layer2DurationMs,
      layer2CacheHits: cacheHits,
      duplicateContentCount: duplicateAudit.duplicateCount,
      corrected,
      abstained,
      engine: layer2ById.size ? 'layer1+gemini-layer2' : 'layer1-only',
      rulesVersion: rulesDocument.version,
      promptVersion: layer2Document.version,
      pipelineVersion: REVIEW_PIPELINE_VERSION
    },
    warnings: [...new Set(warnings)]
  };
}

export { rulesDocument as LAYER1_RULES, layer2Document as LAYER2_PROMPT };
