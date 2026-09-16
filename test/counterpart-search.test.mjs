import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  actorInputFor,
  buildSearchQueries,
  classifyCounterpartMatch,
  compareImageFingerprints,
  createImageFingerprint,
  findCounterpart,
  normalizeActorCandidates,
  parseMarketplaceCount,
  selectBestCandidate,
  targetPlatformFor
} from '../src/counterpart-search.mjs';
import { counterpartJobId } from '../src/counterpart-job-store.mjs';
import { normalizeGoogleLensResponse } from '../src/counterpart/google-lens-provider.mjs';
import { cosineSimilarity } from '../src/counterpart/vertex-image-embedding.mjs';
import { calculateCounterpartBudgetAvailability } from '../src/apify-credential-store.mjs';

test('xác định đúng sàn đối ứng và tạo truy vấn gọn từ tên sản phẩm', () => {
  assert.equal(targetPlatformFor('Shopee'), 'TikTok Shop');
  assert.equal(targetPlatformFor('TikTok Shop'), 'Shopee');
  const queries = buildSearchQueries('Kính cường lực nhũ kim tuyến bảo vệ Camera iPhone 15 Pro Max | Shopee Việt Nam');
  assert.ok(queries.length >= 1 && queries.length <= 2);
  assert.match(queries[0], /kinh cuong luc/);
  assert.doesNotMatch(queries[0], /shopee/);
});

test('input actor chỉ tìm metadata sản phẩm và không lấy review', () => {
  assert.deepEqual(actorInputFor('TikTok Shop', ['iphone 15']), {
    region: 'vn',
    scrapeType: 'search',
    searchKeywords: ['iphone 15'],
    maxItems: 30,
    includeReviews: false
  });
  assert.equal(actorInputFor('Shopee', ['iphone 15']).includeEnrichment, false);
});

test('chuẩn hóa candidate và các định dạng số review phổ biến', () => {
  assert.equal(parseMarketplaceCount('1,2K'), 1200);
  assert.equal(parseMarketplaceCount('2 triệu'), 2_000_000);
  const candidates = normalizeActorCandidates([{
    productId: '123',
    title: 'Ốp iPhone 15 Pro Max',
    productUrl: 'https://shop.tiktok.com/view/product/123',
    imageUrls: ['https://p16-oec-sg.ibyteimg.com/tos-alisg-i-aphluv4xwc/example.webp'],
    reviewCount: '1.2K',
    sellerName: 'Cửa hàng A'
  }], 'TikTok Shop');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reviewCount, 1200);
  assert.equal(candidates[0].shopName, 'Cửa hàng A');
});

test('Google Lens chỉ giữ kết quả của đúng sàn đích và ưu tiên exact match', () => {
  const candidates = normalizeGoogleLensResponse({
    exact_matches: [{
      title: 'Ốp iPhone 15 Pro Max',
      link: 'https://shop.tiktok.com/view/product/123',
      image: 'https://p16-oec-sg.ibyteimg.com/example.webp',
      reviews: 92
    }],
    visual_matches: [
      { title: 'Sai sàn', link: 'https://example.com/a', image: 'https://example.com/a.jpg' },
      { title: 'Ốp tương tự', link: 'https://shop.tiktok.com/view/product/456', thumbnail: 'https://encrypted-tbn0.gstatic.com/a.jpg' }
    ]
  }, 'TikTok Shop');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].lensExact, true);
  assert.equal(candidates[0].reviewCount, 92);
});

test('chỉ công nhận exact hoặc variant khi ảnh đủ gần và model không xung đột', () => {
  assert.equal(classifyCounterpartMatch({ title: 'Ốp iPhone 15pro', lensExact: true, imageScore: .8, textScore: .5 }, 'Ốp iPhone 15pro'), 'exact');
  assert.equal(classifyCounterpartMatch({ title: 'Ốp iPhone 14pro', imageScore: .9, textScore: .5 }, 'Ốp iPhone 15pro'), 'unverified');
  assert.equal(classifyCounterpartMatch({ title: 'Áo cotton màu đen', imageScore: .72, textScore: .4 }, 'Áo cotton tay dài'), 'variant');
});

test('ưu tiên candidate đủ 20 review; nếu không có thì vẫn trả candidate giống nhất', () => {
  const eligible = selectBestCandidate([
    { title: 'A', matchScore: .91, textScore: .8, imageScore: .9, reviewCount: 8 },
    { title: 'B', matchScore: .87, textScore: .76, imageScore: .86, reviewCount: 32 }
  ], 'Nguồn');
  assert.equal(eligible.title, 'B');
  assert.equal(eligible.hasEnoughReviews, true);

  const insufficient = selectBestCandidate([
    { title: 'A', matchScore: .91, textScore: .8, imageScore: .9, reviewCount: 8 },
    { title: 'B', matchScore: .82, textScore: .7, imageScore: .83, reviewCount: 4 }
  ], 'Nguồn');
  assert.equal(insufficient.title, 'A');
  assert.equal(insufficient.hasEnoughReviews, false);

  const unrelatedButEligible = selectBestCandidate([
    { title: 'A', matchScore: .91, textScore: .8, imageScore: .9, reviewCount: 8 },
    { title: 'B', matchScore: .54, textScore: .3, imageScore: .5, reviewCount: 500 }
  ], 'Nguồn');
  assert.equal(unrelatedButEligible.title, 'A');
});

test('fingerprint ảnh cho điểm giống nhau cao hơn ảnh khác nhau', async () => {
  const green = Buffer.from('<svg width="160" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="160" height="160" fill="#168d5d"/><circle cx="80" cy="80" r="44" fill="#fff"/></svg>');
  const orange = Buffer.from('<svg width="160" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="160" height="160" fill="#ff7018"/><path d="M0 0L160 160M160 0L0 160" stroke="#111" stroke-width="20"/></svg>');
  const first = await createImageFingerprint(green);
  const same = await createImageFingerprint(green);
  const different = await createImageFingerprint(orange);
  assert.ok(compareImageFingerprints(first, same) > compareImageFingerprints(first, different));
  assert.equal(compareImageFingerprints(first, same), 1);
});

test('tính năng tắt độc lập bằng feature flag', async () => {
  const result = await findCounterpart({ platform: 'Shopee', title: 'Sản phẩm', url: 'https://shopee.vn/product/1/2' }, { env: { COUNTERPART_SEARCH_ENABLED: 'false' } });
  assert.equal(result.status, 'disabled');
});

test('vẫn tìm sản phẩm đối ứng khi actor review của sàn đích đang bảo trì', async () => {
  let lensCalls = 0;
  let actorCalls = 0;
  const candidate = {
    title: 'Giày Oxford nam',
    url: 'https://shopee.vn/product/1/2',
    image: 'https://down-vn.img.susercontent.com/file/match',
    reviewCount: 25,
    discoveryMethod: 'google-lens-exact'
  };
  const result = await findCounterpart({
    platform: 'TikTok Shop',
    title: 'Giày Oxford nam',
    url: 'https://shop.tiktok.com/view/product/123',
    image: 'https://p16-oec-sg.ibyteimg.com/product.webp'
  }, {
    env: {
      COUNTERPART_SEARCH_ENABLED: 'true',
      SHOPEE_REVIEW_ENABLED: 'false',
      GOOGLE_LENS_SERPAPI_KEY: 'test'
    },
    searchGoogleLensImpl: async () => { lensCalls += 1; return [candidate]; },
    runSearchActorImpl: async () => { actorCalls += 1; return []; },
    rankCandidatesImpl: async (_source, candidates) => ({
      ...candidates[0], matchClass: 'exact', matchScore: .9, imageScore: .9, hasEnoughReviews: true
    })
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.targetPlatform, 'Shopee');
  assert.equal(result.candidate.url, candidate.url);
  assert.equal(lensCalls, 1);
  assert.equal(actorCalls, 0);
});

test('Lens dưới 20 review bắt buộc chạy actor rồi chấm lại toàn bộ ứng viên', async () => {
  let actorCalls = 0;
  let rankingCalls = 0;
  const lensCandidate = {
    title: 'Tai nghe ANC', url: 'https://shop.tiktok.com/view/product/8',
    image: 'https://p16-oec-sg.ibyteimg.com/lens.webp', reviewCount: 8,
    discoveryMethod: 'google-lens-visual'
  };
  const actorCandidate = {
    title: 'Tai nghe ANC', url: 'https://shop.tiktok.com/view/product/40',
    image: 'https://p16-oec-sg.ibyteimg.com/actor.webp', reviewCount: 40,
    discoveryMethod: 'actor-search'
  };
  const result = await findCounterpart({
    platform: 'Shopee', title: 'Tai nghe ANC', url: 'https://shopee.vn/product/1/2',
    image: 'https://down-vn.img.susercontent.com/file/source'
  }, {
    env: { COUNTERPART_SEARCH_ENABLED: 'true', GOOGLE_LENS_SERPAPI_KEY: 'test' },
    searchGoogleLensImpl: async () => [lensCandidate],
    runSearchActorImpl: async () => { actorCalls += 1; return [actorCandidate]; },
    rankCandidatesImpl: async (_source, candidates) => {
      rankingCalls += 1;
      const chosen = candidates.find((candidate) => Number(candidate.reviewCount) >= 20) || candidates[0];
      return { ...chosen, matchClass: 'exact', matchScore: .9, imageScore: .9, hasEnoughReviews: Number(chosen.reviewCount) >= 20 };
    }
  });
  assert.equal(actorCalls, 1);
  assert.equal(rankingCalls, 2);
  assert.equal(result.candidate.reviewCount, 40);
  assert.equal(result.discovery.provider, 'actor-fallback');
});

test('Lens đủ 20 review không tiêu một lượt actor fallback', async () => {
  let actorCalls = 0;
  const candidate = {
    title: 'Tai nghe ANC', url: 'https://shop.tiktok.com/view/product/25',
    image: 'https://p16-oec-sg.ibyteimg.com/lens.webp', reviewCount: 25,
    discoveryMethod: 'google-lens-exact'
  };
  const result = await findCounterpart({
    platform: 'Shopee', title: 'Tai nghe ANC', url: 'https://shopee.vn/product/1/2',
    image: 'https://down-vn.img.susercontent.com/file/source'
  }, {
    env: { COUNTERPART_SEARCH_ENABLED: 'true', GOOGLE_LENS_SERPAPI_KEY: 'test' },
    searchGoogleLensImpl: async () => [candidate],
    runSearchActorImpl: async () => { actorCalls += 1; return []; },
    rankCandidatesImpl: async (_source, candidates) => ({
      ...candidates[0], matchClass: 'exact', matchScore: .9, imageScore: .9, hasEnoughReviews: true
    })
  });
  assert.equal(actorCalls, 0);
  assert.equal(result.candidate.reviewCount, 25);
});

test('job id ổn định theo sản phẩm và budget không lấn phần dự trữ Shopee', () => {
  const source = { platform: 'Shopee', title: 'A', url: 'https://shopee.vn/product/1/2', itemId: '2' };
  assert.equal(counterpartJobId(source), counterpartJobId({ ...source, title: 'Tên mới' }));
  const safe = calculateCounterpartBudgetAvailability({ observedSpentMicroUsd: 2_000_000, shopeeLifetimeUsed: 10, plannedCostMicroUsd: 100_000 });
  assert.equal(safe.shopeeReservedMicroUsd, 878_000);
  assert.equal(safe.fits, true);
  const protectedBudget = calculateCounterpartBudgetAvailability({ observedSpentMicroUsd: 4_100_000, shopeeLifetimeUsed: 10, plannedCostMicroUsd: 100_000 });
  assert.equal(protectedBudget.fits, false);
});

test('cosine similarity phân biệt vector cùng hướng và khác hướng', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('section đối ứng ẩn mặc định và chỉ có module nền riêng', async () => {
  const root = new URL('../', import.meta.url);
  const html = await readFile(new URL('public/results.html', root), 'utf8');
  const loader = await readFile(new URL('public/counterpart-loader.js', root), 'utf8');
  const script = await readFile(new URL('public/counterpart-widget.js', root), 'utf8');
  const styles = await readFile(new URL('public/counterpart-widget.css', root), 'utf8');
  const resultsScript = await readFile(new URL('public/results.js', root), 'utf8');
  const resultsStyles = await readFile(new URL('public/results-v2.css', root), 'utf8');
  assert.match(html, /id="counterpart-section" class="counterpart-section hidden"/);
  assert.match(html, /id="counterpart-dock-button"[^>]+hidden/);
  assert.match(html, /id="counterpart-progress"[^>]+aria-controls="counterpart-section"[^>]+disabled hidden/);
  assert.match(html, /Đang tìm sản phẩm tương tự trên nền tảng khác/);
  assert.match(script, /requestIdleCallback/);
  assert.match(script, /showStatusToast/);
  assert.match(script, /analysisAvailability/);
  assert.equal((script.match(/method: 'POST'/g) || []).length, 1);
  assert.match(script, /method: 'GET'/);
  assert.match(script, /AbortController/);
  assert.match(script, /removeEventListener\('abort'/);
  assert.match(script, /trustIntroIsOpen/);
  assert.match(loader, /realview:analysis-result/);
  assert.match(loader, /import\('\.\/counterpart-widget\.js\?v=10'\)/);
  assert.match(html, /counterpart-loader\.js\?v=10/);
  assert.match(script, /counterpart-widget\.css\?v=10/);
  assert.match(html, /results-v2\.css\?v=2/);
  assert.match(html, /results\.js\?v=2/);
  assert.match(script, /showSearchProgress/);
  assert.match(script, /completeProgress/);
  assert.match(script, /function revealSection\(\)/);
  assert.match(script, /completeProgress\(platform\);\s+revealSection\(\);/);
  assert.match(script, /progressButton\?\.addEventListener\('click', showSection\)/);
  assert.doesNotMatch(html, /counterpart-section-close/);
  assert.doesNotMatch(script, /closeButton/);
  assert.doesNotMatch(styles, /counterpart-section-close/);
  assert.match(resultsScript, /titleElement\.title = title \|\| ''/);
  assert.match(resultsStyles, /\.analysis-product-copy h2:not\(\.skeleton-line\)[\s\S]*-webkit-line-clamp: 3/);
  assert.match(resultsStyles, /@media \(max-width: 620px\)[\s\S]*\.analysis-product-copy h2:not\(\.skeleton-line\)[^}]*-webkit-line-clamp: 2/);
  assert.match(script, /`Đối chiếu từ \$\{sourcePlatform\} sang \$\{targetPlatform\}`/);
  assert.equal((`${html}\n${script}`.match(/d="M4 6h16"/g) || []).length, 3);
  assert.doesNotMatch(`${html}\n${script}`, /M8 7h11|M5 8h14/);
  assert.match(script, /counterpart-facts--match/);
  assert.doesNotMatch(script, /fact\('Mức khớp'/);
  assert.match(styles, /\.counterpart-comparison \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*align-items: stretch;/);
  assert.match(styles, /\.counterpart-product-card \{[^}]*flex: 1 1 0;[^}]*align-self: stretch;/);
  assert.match(script, /counterpart-product-card--\$\{platformKey\}/);
  assert.match(script, /counterpart-platform-icon/);
  assert.match(script, /M8\.2 11\.5h15\.6l1\.3 15H6\.9l1\.3-15Z/);
  assert.match(script, /M14 4v10\.2a4\.2 4\.2 0 1 1-3\.4-4\.1/);
  assert.match(script, /counterpart-media-column[\s\S]*counterpart-platform-tag[\s\S]*counterpart-product-image/);
  assert.doesNotMatch(script, /Gian hàng:/);
  assert.match(styles, /\.counterpart-product-card--shopee \{[^}]*border-top: 4px solid #EE4D2D;[^}]*background-color: #FFF9F8;/);
  assert.match(styles, /\.counterpart-product-card--tiktok::before \{[^}]*height: 28px;[^}]*border-radius: 24px 24px 0 0;[^}]*linear-gradient\(90deg, #25F4EE, #000000, #FE2C55\)/);
  assert.match(styles, /\.counterpart-product-card--tiktok::after \{[^}]*top: 4px;[^}]*right: 1px;[^}]*left: 1px;[^}]*border-radius: 20px 20px 0 0;/);
  assert.match(styles, /\.counterpart-media-column \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*align-items: flex-start;[^}]*gap: 12px;/);
  assert.match(styles, /\.counterpart-platform-tag \{[^}]*width: fit-content;[^}]*padding: 4px 12px;[^}]*display: inline-flex;[^}]*border-radius: 99px;/);
  const platformTagRule = styles.match(/\.counterpart-platform-tag \{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(platformTagRule, /position:\s*absolute|top:|left:/);
  assert.match(styles, /\.counterpart-product-card h3 \{[^}]*font-weight: 600;[^}]*-webkit-line-clamp: 2;/);
  assert.match(styles, /\.counterpart-link \{[^}]*gap: 4px;/);
  assert.match(styles, /\.counterpart-facts--match \{ align-items: center; gap: 10px; \}/);
  assert.match(styles, /\.counterpart-bridge-icon \{[^}]*justify-self: center;/);
  assert.match(styles, /\.counterpart-actions \{[^}]*padding: 12px 24px;[^}]*display: flex;[^}]*justify-content: space-between;[^}]*background-color: #FEF3C7;/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.counterpart-actions \{[^}]*flex-direction: column;[^}]*align-items: stretch;/);
  assert.match(styles, /\.counterpart-heading h2 \{[^}]*max-width: none;[^}]*white-space: nowrap;/);
  assert.match(styles, /\.counterpart-analyze-button \{[^}]*width: min\(100%, 260px\);[^}]*border: 1\.5px solid #111827;[^}]*border-radius: 999px;[^}]*background: #fc781f;/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.action-bar-context \{ display: none !important; \}/);
  assert.doesNotMatch(html, /rel="stylesheet" href="\/counterpart-widget\.css"/);
  assert.match(script, /section\.scrollIntoView/);
  assert.match(script, /\/ket-qua\?url=/);
  assert.doesNotMatch(script, /\/api\/analyze(?:-stream)?['"]/);
});
