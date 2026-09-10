# Review Thật?

Website độc lập (không extension) để lọc review nhiễu và tóm tắt nhược điểm lặp lại từ link sản phẩm Shopee/TikTok Shop.

## Chạy ngay

Yêu cầu Node.js 18 trở lên:

```bash
npm run start:local
```

Mở `http://localhost:3000`, dán một link sản phẩm. Không cần cài package nào.

## Nguồn dữ liệu thực tế

Với Shopee, ứng dụng gọi Actor Apify `zen-studio/shopee-product-reviews-scraper` từ backend. Mỗi lượt production cấp phát **năm tài khoản** và chạy song song năm Actor ở các tầng 5★/4★/3★/2★/1★. Mỗi request dùng `contentFilter: "with comments"` và lấy tối đa 20 review có nội dung viết, tổng tối đa 100 review. Kết quả được hậu kiểm đúng mức sao và chống trùng trước khi chuyển sang pipeline gắn nhãn và TrustScore.

Thiết kế này trả tối đa **100 review** theo năm tầng kiểm soát. Đây không phải phân bố sao tự nhiên của toàn bộ sản phẩm; TrustScore dùng thiết kế chuẩn 5 tầng 1★–5★ và không suy rộng tỷ lệ trong mẫu thành tỷ lệ tổng thể.

Backend chấp nhận cả link sản phẩm đầy đủ và link được chia sẻ/rút gọn từ Shopee, gồm `s.shopee.vn`, `vn.shp.ee` và `shope.ee`. Với link rút gọn, máy chủ sẽ:

1. Mở tối đa 5 bước chuyển hướng trong thời hạn 8 giây.
2. Chỉ cho phép chuyển hướng giữa các miền Shopee đã định nghĩa, nhằm tránh truy cập máy chủ ngoài ý muốn.
3. Đọc `shopId` và `itemId`, rồi chuẩn hóa thành URL `https://shopee.vn/product-i.<shopId>.<itemId>` trước khi gọi Apify.
4. Báo lỗi rõ ràng nếu link chia sẻ dẫn tới trang shop, danh mục hoặc nội dung không phải sản phẩm.

Nội dung sao chép từ ứng dụng có kèm mô tả và link cũng được hỗ trợ; backend tự tách URL trước khi xử lý.

### Cấu hình thu thập

Tại Vercel → **Settings → Environment Variables**, thêm biến:

```text
APIFY_ACTOR_ID=zen-studio/shopee-product-reviews-scraper
SHOPEE_REVIEWS_PER_STAR=20
APIFY_RUN_TIMEOUT_MS=70000
TIKTOK_USE_TEMPORARY_ACTOR=false
APIFY_TOKEN_VAULT_KEY=<base64 32 byte>
APIFY_ADMIN_KEY=<admin secret>
UPSTASH_REDIS_REST_URL=<Upstash REST URL>
UPSTASH_REDIS_REST_TOKEN=<Upstash REST token>
```

Shopee production luôn dùng 5 account song song cho 5 tầng 5★/4★/3★/2★/1★, tối đa 20 review mỗi account (tổng tối đa 100), kiểm tra đúng mức sao và khử trùng trước khi phân tích. Actor TikTok gốc vẫn là mặc định và dùng cùng chiến lược chia tầng. `TIKTOK_USE_TEMPORARY_ACTOR=true` chuyển toàn bộ lượt TikTok sang actor tạm thời lấy tối đa 100 review gần nhất bằng một account; `false` hoặc bỏ trống sẽ dùng actor gốc. Mẫu của actor tạm thời được gắn nhãn `most-recent-100` và `observed-sample`, không được diễn giải như phân bố đại diện của toàn bộ sản phẩm. Các Apify token không nằm trong environment của Vercel: chúng được cập nhật tập trung qua API quản trị và mã hóa trong Redis. Không đưa file chứa token vào GitHub hoặc JavaScript trình duyệt.

### Cấu hình và tự động xoay vòng Apify key

Pool vẫn được lưu theo nhóm 5 key để tương thích với file quản trị hiện có. Shopee và TikTok dùng chung token nhưng có bộ đếm riêng. Shopee production cấp đủ 5 key còn lượt và tăng bộ đếm lượt của từng key bằng một lệnh Redis nguyên tử; mỗi key được dùng tối đa 10 lượt. Khi một key đủ 10 lượt, trạng thái `used` chỉ áp dụng cho Shopee—key đó vẫn có thể phục vụ TikTok.

Shopee giữ hạn mức 10 lượt trọn đời trong bộ đếm v2 và không reset theo kỳ thanh toán. Chi phí thực tế của cả Shopee và TikTok được quản lý trong sổ cái v4 theo `billingAccountId` và `usageCycle.startAt` do API Apify trả về. Hệ thống không giả định ngày reset là ngày đầu tháng. Trước mỗi reservation, backend đọc chu kỳ hiện tại và tổng usage thực tế của từng tài khoản; số liệu Redis được nâng lên tối thiểu bằng số Apify báo cáo để bao gồm cả chi phí phát sinh ngoài RealView. Phần bảo lưu Shopee bằng số lượt trọn đời còn lại nhân với 79.800 micro USD. Khi đủ 10 lượt, phần bảo lưu bằng 0; chi phí Shopee đã phát sinh trong chu kỳ hiện tại vẫn được tính. Giá và actor được đóng băng trong reservation. Finalization theo operation ID chống cộng hai lần. Lỗi 402 chỉ đánh dấu hết ngân sách trong đúng billing cycle, 403 chỉ chặn actor tương ứng, 429 tạo cooldown 60 giây, còn timeout và 5xx giữ reservation để đối soát. Circuit breaker mở tạm thời sau ba lỗi hạ tầng liên tiếp. Blob fallback chỉ được dùng khi dataset khớp chính xác productId.

Để tạo nhanh file pool từ một danh sách dài API key, chạy `npm run generate:apify-pool`. Dán mỗi key trên một dòng, nhấn Enter ở dòng trống, chọn `replace` hoặc `append`, rồi nhập vị trí muốn lưu. Công cụ tự loại key trùng (giữ lần xuất hiện đầu tiên) và chia key thành từng nhóm 5★ → 1★. Nếu còn dư 1–4 key, backend mã hóa và lưu chúng ở trạng thái `pending`; chúng không được cấp phát cho đến khi một lần `append` sau bổ sung đủ nhóm 5. Chế độ `replace` mặc định dùng `config/apify-pool.local.json`; chế độ `append` luôn đề xuất một file mới có timestamp để không ghi đè file ban đầu. Các file này được tạo với quyền chỉ tài khoản hiện tại đọc/ghi và đã nằm trong `.gitignore`.

Sau khi tạo file, tool cho chọn **Push Redis** hoặc **Không push**. Nếu push, chế độ **Bổ sung** gửi `mode: "append"` để giữ pool cũ và nối key mới; chế độ **Replace** gửi `mode: "replace"` để thay pool hiện tại. Tool yêu cầu `APIFY_ADMIN_KEY` bằng trường nhập ẩn, chỉ báo thống kê không chứa token và vẫn giữ file JSON nếu upload thất bại.

1. Kết nối Upstash Redis từ Vercel Marketplace. Backend chấp nhận cả cặp `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` và cặp tương thích `KV_REST_API_URL` / `KV_REST_API_TOKEN` do integration cấp.
2. Tạo hai secret một lần và redeploy:

```bash
openssl rand -base64 32  # dùng kết quả cho APIFY_TOKEN_VAULT_KEY
openssl rand -hex 32     # dùng kết quả cho APIFY_ADMIN_KEY
```

3. Sao chép `config/apify-pool.example.json` thành `config/apify-pool.local.json`, điền token thật rồi cập nhật toàn bộ pool bằng một request, không redeploy:

```bash
curl -X PUT 'https://<domain>/api/apify-config' \
  -H 'Authorization: Bearer <APIFY_ADMIN_KEY>' \
  -H 'Content-Type: application/json' \
  --data-binary @config/apify-pool.local.json
```

`mode: "replace"` thay danh sách nhóm đang cấu hình. Để chỉ nối thêm nhóm dự phòng mà không chạm vào nhóm hiện có, gửi cùng cấu trúc với `mode: "append"`. Token đã có bộ đếm hoặc đã nằm trong lịch sử `used` sẽ bị từ chối khi nạp lại; hãy dùng token mới để không làm sai vòng đời 10 lượt.

Xem nhãn `active`, các nhóm `reserve`, danh sách `used`, bộ đếm và số lượt còn lại; API không bao giờ trả lại token:

```bash
curl 'https://<domain>/api/apify-config' \
  -H 'Authorization: Bearer <APIFY_ADMIN_KEY>'
```

Lượt sử dụng được cộng ngay khi cấp phát; vì vậy request đã gửi đi nhưng Apify lỗi vẫn được tính là một lượt dùng. Sau bước cấp phát, backend không chờ thêm lần ghi Redis nào mà phát ngay một request Apify để giữ độ trễ thấp.

TikTok Shop hiện vẫn dùng collector độc lập nếu đã cấu hình:

Bot nhận `POST /reviews` với JSON `{ "url": "...", "platform": "Shopee", "limit": 50 }` và trả `{ "reviews": [{ "rating": 1-5, "text": "...", "date": "...", "verified": true, "author": "..." }] }`.

## Cập nhật tiến độ bằng Server-Sent Events

Frontend gọi `POST /api/analyze-stream` và nhận luồng `text/event-stream`. Backend gửi các event:

- `ready`: kết nối streaming đã sẵn sàng.
- `progress`: bước xử lý thật, phần trăm và chi tiết từng run Apify.
- `heartbeat`: giữ kết nối qua proxy trong lúc Apify đang chạy.
- `result`: kết quả phân tích hoàn chỉnh.
- `error`: lỗi có thông báo và mã trạng thái tương ứng.

Endpoint JSON `POST /api/analyze` vẫn được giữ để tương thích với client cũ.

### Triển khai bot

Deploy riêng thư mục `bot/` lên một dịch vụ hỗ trợ Docker. Thiết lập biến môi trường `REVIEWS_BOT_TOKEN` là một chuỗi bí mật mạnh. Sau đó tại Vercel, thêm:

```text
REVIEWS_BOT_URL=https://<ten-bot-cua-ban>/reviews
REVIEWS_BOT_TOKEN=<cung-gia-tri-voi-bot>
```

Vercel sẽ gửi link sản phẩm sang bot; bot không trả review mô phỏng. Khi Shopee từ chối phiên thu thập, giao diện báo lỗi thay vì hiển thị review của sản phẩm khác.

TikTok Shop chưa có collector trong phiên bản này và sẽ báo rõ là chưa hỗ trợ nếu chưa cấu hình bot.

## TrustScore và phân tích Gemini

RealView dùng bộ máy thống kê xác định trong `src/trust-score-v31.mjs`:

- Fisher exact two-sided cho `seeding × 5 sao` và `khiếu nại mơ hồ × 1 sao`;
- hiệu chỉnh Haldane–Anscombe `+0,5` chỉ cho odds ratio, không sửa bảng Fisher;
- binomial exact cho 5 nhóm khuyết tật, cùng Bonferroni/Holm;
- điểm khuyết tật có trọng số, 5 thành phần TrustScore và hard gatekeeping;
- làm tròn đúng một lần sau khi áp dụng các giới hạn điểm.

Gemini, nếu được cấu hình, chỉ diễn giải ưu/nhược điểm và nguyên nhân; mô hình không được phép thay đổi TrustScore. Khóa chỉ được đặt trong biến môi trường máy chủ, tuyệt đối không đưa vào `public/` hoặc mã JavaScript chạy trên trình duyệt.

Tại Vercel → **Settings → Environment Variables**, thêm:

```text
GEMINI_API_KEY=<khóa Gemini của bạn>
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_API_KEY_VAULT_KEY=<kết quả openssl rand -base64 32>
GEMINI_ADMIN_KEY=<khóa quản trị; có thể bỏ trống để dùng APIFY_ADMIN_KEY>
GEMINI_HEALTH_SCORING_V2=true
```

Gemini pool được lưu mã hóa trong Upstash Redis và chỉ dùng `Gemini 3.5 Flash Lite`. Router tách riêng khả dụng (`available`, `busy`, `cooldown`, `rate_limited`, `used`), sức khỏe lỗi (`healthy`, `degraded`) và hiệu năng (`unknown`, `fast`, `normal`, `slow`). Độ trễ chỉ là ưu tiên mềm, giảm một nửa trọng số sau mỗi mười phút không hoạt động và không làm key mất khả dụng. Key lỗi hoặc chạm quota phút được đưa vào `pending`; key chạm 500 request/ngày hoặc Gemini xác nhận hết quota ngày được đưa vào `used`. Bộ đếm ngày và trạng thái `used` tự mở lại sau 00:00 `America/Los_Angeles`, không cần cron. Mỗi lần gọi có tối đa hai retry và mỗi retry bắt buộc dùng một API key khác. Các key phải thuộc Google Cloud project khác nhau nếu muốn có quota độc lập; nhiều key trong cùng project vẫn chia sẻ một quota. Đặt `GEMINI_HEALTH_SCORING_V2=false` để quay lại cách tính route score cũ mà không rollback code.

Nạp hoặc bổ sung key bằng:

```bash
npm run generate:gemini-pool
```

Nếu Gemini chưa được cấu hình hoặc tạm thời không phản hồi, website vẫn trả đầy đủ TrustScore thống kê để người dùng không bị kẹt. Giao diện hiển thị đúng nguồn phân tích của lượt chạy.

Các baseline `p0` mặc định là ví dụ trong tài liệu v3.1 nên giao diện ghi rõ “tham khảo”. Chỉ bật kết luận binomial khi `TRUST_BASELINES_JSON` chứa `calibrated: true` và baseline được xây dựng từ tập đối chứng phù hợp. Xem mẫu cấu hình trong `.env.example`.

## Pipeline gắn nhãn hai lớp

Mỗi lượt thu thập review chạy theo thứ tự:

1. `src/review-labeler.mjs` áp dụng labeling functions trong `src/layer1_rules.json`. Rule tách riêng `relevance` (mức liên quan) và `information_value` (giá trị thông tin), đồng thời có các nhãn độc lập cho `seeding`, `low_value`, `vague` và nhóm lỗi. Layer 1 chỉ tạo ứng viên off-topic, không tự loại review dựa trên từ khóa mơ hồ.
2. Backend khử trùng exact/near-duplicate trước Gemini để chỉ kiểm định bản đại diện. Khi có khóa môi trường hoặc Gemini pool khả dụng, Layer 2 kiểm tra các trường hợp chưa chắc chắn theo batch bằng schema trong `src/sample_ai_payload.json`. LLM chỉ được `confirm`, `correct` hoặc `abstain`; mọi lần sửa nhãn phải kèm trích dẫn nguyên văn. Nhãn off-topic còn phải trích đúng đoạn nêu một sản phẩm khác; kết quả sai ID, category lạ, quote không nguyên văn hoặc vi phạm bất biến sẽ bị backend từ chối.
3. Bộ lọc cuối dùng kết quả khử trùng và nhãn của labeler, không khử trùng lại sau Gemini. TrustScore v4.2 tổng hợp chất lượng bằng chứng, mức ít nhiễu và độ phủ kiểm định. Độ phủ bằng chứng điều chỉnh phần điểm trên 50; tầng thiếu đóng góp 0 vào độ phủ và không thể được bù bằng cách lấy dư tầng khác. `defectScore` được giữ riêng để mô tả nhược điểm, không trực tiếp làm giảm TrustScore.

Thiết kế hiện tại của cả Shopee và TikTok là 5 tầng 1★–5★, tối đa 20 review mỗi tầng. Endpoint chỉ chặn vì thiếu mẫu khi thu được dưới 20 review có nội dung chữ; từ 20 trở lên vẫn công bố điểm và trạng thái `limited`, `provisional` hoặc `valid`. Lỗi Layer 2 có fallback ghi rõ provenance. URL không hợp lệ hoặc nguồn thu thập thất bại vẫn trả lỗi kỹ thuật.

TrustScore là chỉ số tổng hợp theo thiết kế mẫu; không phải xác suất review thật hay tỷ lệ đại diện cho toàn bộ sản phẩm. Công thức, mẫu số, trạng thái và ví dụ được ghi tại [Thuật toán TrustScore v4.2](docs/trust-score-v4.2.md).

`LABELER_LLM_MODE=uncertain` là mặc định tiết kiệm: gửi ứng viên off-topic, review ngắn/low-value chưa chắc chắn, trường hợp xung đột hoặc độ tin cậy thấp; chuỗi rác, chỉ emoji và lặp ký tự chắc chắn vẫn bị Layer 1 chặn mà không tốn Gemini. `all` dùng để audit toàn bộ review; `off` tắt Layer 2.

Layer 2 mặc định chia 10 review mỗi batch (cấu hình được trong khoảng 8–12).
Bộ điều phối bắt đầu với ba batch đồng thời và chỉ tăng khi số lượng review,
thời gian còn lại và số route Gemini khỏe yêu cầu; giới hạn trên là mười batch.
Tắt nhanh bằng `LAYER2_ADAPTIVE_CONCURRENCY=false`; khi đó
`LAYER2_FIXED_CONCURRENCY=2` giữ hành vi scheduler cũ. Scheduler không thay đổi
tiêu chí `requires_llm`, prompt hoặc quyền xác nhận/sửa nhãn Layer 1 của Layer 2.
Mỗi batch dùng duy nhất model
`gemini-3.5-flash-lite`, thử tối đa hai route tuần tự; khi route đầu lỗi hoặc
timeout, route thứ hai ưu tiên API key khỏe và ít sử dụng hơn trong Redis. Timeout
không đánh dấu key là hết quota ngày. Kết quả trả `layer2Retry` gồm số retry, số
lần đổi key và model đã dùng để đối chiếu với runtime log.

## Lưu dataset

Mỗi lượt phân tích tạo đúng hai file có chung `runId`:

- `reviews.raw.json`: dữ liệu vừa thu thập, chưa gắn nhãn;
- `reviews.labeled.json`: dữ liệu kèm nhãn Layer 1, phản biện Layer 2, nhãn cuối, evidence, phiên bản pipeline, quyết định lọc cuối `included` và `exclusionReason`.

API phân biệt rõ `stats.included` (review được giữ làm bằng chứng hiển thị) với `stats.trustSample` (mẫu bằng chứng của TrustScore sau khi loại nội dung không đủ điều kiện). Trường cũ `genuine` và `algorithmSample` vẫn được giữ để tương thích client cũ.

Khi chạy local, file nằm trong `data/review-runs/YYYY/MM/DD/<product>/<runId>/`. Khi chạy trên Vercel, filesystem của Function không phải storage bền vững; ứng dụng lưu hai file vào **private Vercel Blob** tại `review-datasets/YYYY/MM/DD/<product>/<runId>/` nếu có `BLOB_READ_WRITE_TOKEN`. Kết nối một Blob Store trong Vercel Storage với project để Vercel cấp biến này, rồi redeploy. Nếu chưa nối Blob Store, lượt phân tích vẫn trả kết quả nhưng `dataset.saved=false` và có warning rõ ràng.
