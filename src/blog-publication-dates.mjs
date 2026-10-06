// Existing articles, oldest to newest. One article per day in Vietnam time.
export const BLOG_PUBLICATION_ORDER = Object.freeze([
  'trustscore-la-gi',
  'kiem-tra-do-tin-cay-review-truoc-khi-mua-hang',
  'cach-tim-shop-uy-tin-tren-shopee',
  'shopee-mall-la-gi-co-nen-mua-khong',
  'tiktok-shop-la-gi-mua-hang-tren-tiktok-co-an-toan-khong',
  'shopee-hay-tiktok-shop-mua-hang-o-dau-tot-hon',
  'review-san-pham-la-gi',
  'review-san-pham-co-dang-tin-khong',
  'review-gia-la-gi-dau-hieu-nhan-biet',
  'seeding-review-shopee-tiktok',
  'seeding-review-la-gi',
  'san-pham-nhieu-review-van-tiem-an-rui-ro',
  'check-review-la-gi-tai-sao-can-check-review-truoc-khi-dat-hang',
  'tips-kiem-tra-review-san-pham-checklist-truoc-khi-mua-hang',
  'vi-sao-realview-huu-ich',
  'realview-la-gi-cach-su-dung-realview-de-check-review-san-pham-shopee-va-tiktok-shop',
  'trang-check-review-uy-tin-5-cong-cu-dang-biet',
  'tieu-chi-danh-gia-cong-cu-check-review',
  'check-review-truoc-khi-mua-hang'
]);

export const BLOG_PUBLICATION_DATES = Object.freeze(Object.fromEntries(
  BLOG_PUBLICATION_ORDER.map((slug, index) => [slug,
    `${new Date(Date.UTC(2026, 8, 11 + index)).toISOString().slice(0, 10)}T08:00:00+07:00`
  ])
));

export function blogPublicationDate(slug, fallback = '') {
  return BLOG_PUBLICATION_DATES[slug] || fallback;
}
