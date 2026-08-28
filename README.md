# Review Thật?

Website độc lập (không extension) để lọc review nhiễu và tóm tắt nhược điểm lặp lại từ link sản phẩm Shopee/TikTok Shop.

## Chạy ngay

Yêu cầu Node.js 18 trở lên:

```bash
npm start
```

Mở `http://localhost:3000`, dán một link sản phẩm. Không cần cài package nào.

## Nguồn dữ liệu thực tế

Với Shopee, ứng dụng gọi Actor Apify `zen-studio/shopee-product-reviews-scraper` từ backend. Mỗi lượt phân tích cấp phát một **nhóm 5 tài khoản** rồi khởi động đồng thời năm Actor runs: key 5★ chỉ chạy `starFilter: 5`, key 4★ chỉ chạy `starFilter: 4`, tiếp tục đến key 1★. Cả năm đều dùng `contentFilter: "with comments"` và tối đa 20 review/mức sao. Kết quả được kiểm tra lại rating, chống trùng theo `reviewId` (hoặc fingerprint nội dung khi thiếu ID), rồi mới chuyển sang pipeline gắn nhãn và TrustScore.

Thiết kế này trả tối đa **100 review**, không cam kết luôn đủ 100: sản phẩm có thể không có 20 review viết chữ ở từng mức sao. Năm run được khởi động trước khi chờ kết quả nên thời gian thường gần run chậm nhất, cộng thêm một round-trip Redis ngắn để cấp phát key. Concurrency thực tế vẫn phụ thuộc Apify plan của từng tài khoản.

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
APIFY_TOKEN_VAULT_KEY=<base64 32 byte>
APIFY_ADMIN_KEY=<admin secret>
UPSTASH_REDIS_REST_URL=<Upstash REST URL>
UPSTASH_REDIS_REST_TOKEN=<Upstash REST token>
```

`SHOPEE_REVIEWS_PER_STAR` được giới hạn từ 1–20. Các Apify token không nằm trong environment của Vercel: chúng được cập nhật tập trung qua API quản trị và mã hóa trong Redis. Không đưa file chứa token vào GitHub hoặc JavaScript trình duyệt.

### Cấu hình và tự động xoay vòng 5 Apify key

Pool được chia thành các nhóm, mỗi nhóm có đúng 5 key theo thứ tự 5★ → 1★. Trước mỗi lượt phân tích, Redis dùng một lệnh nguyên tử để chọn nhóm active và cộng **1** vào bộ đếm của từng key. Khi nhóm hoàn tất lượt thứ 10, cả 5 key được ghi vào `used`; lượt phân tích kế tiếp tự lấy nhóm dự phòng đầu tiên. Cách cấp phát nguyên tử ngăn hai request đồng thời cùng chiếm lượt cuối.

Để tạo nhanh file pool từ một danh sách dài API key, chạy `npm run generate:apify-pool`. Dán mỗi key trên một dòng, nhấn Enter ở dòng trống, chọn `replace` hoặc `append`, rồi nhập vị trí muốn lưu. Công cụ tự chia key thành từng nhóm 5★ → 1★ và kiểm tra key trùng. Nếu còn dư 1–4 key, backend mã hóa và lưu chúng ở trạng thái `pending`; chúng không được cấp phát cho đến khi một lần `append` sau bổ sung đủ nhóm 5. File mặc định là `config/apify-pool.local.json`, được tạo với quyền chỉ tài khoản hiện tại đọc/ghi và đã nằm trong `.gitignore`.

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

Lượt sử dụng được cộng ngay khi cấp phát; vì vậy request đã gửi đi nhưng Apify lỗi vẫn được tính là một lượt dùng. Sau bước cấp phát, backend không chờ thêm lần ghi Redis nào mà phát ngay 5 request Apify song song để giữ độ trễ thấp.

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
GEMINI_MODEL=gemini-3.5-flash
```

Nếu Gemini chưa được cấu hình hoặc tạm thời không phản hồi, website vẫn trả đầy đủ TrustScore thống kê để người dùng không bị kẹt. Giao diện hiển thị đúng nguồn phân tích của lượt chạy.

Các baseline `p0` mặc định là ví dụ trong tài liệu v3.1 nên giao diện ghi rõ “tham khảo”. Chỉ bật kết luận binomial khi `TRUST_BASELINES_JSON` chứa `calibrated: true` và baseline được xây dựng từ tập đối chứng phù hợp. Xem mẫu cấu hình trong `.env.example`.

## Pipeline gắn nhãn hai lớp

Mỗi lượt thu thập review chạy theo thứ tự:

1. `src/review-labeler.mjs` áp dụng labeling functions trong `src/layer1_rules.json`. Rule có thể gắn `seeding`, `low_value`, `vague`, nhiều nhóm lỗi hoặc đánh dấu mơ hồ để Layer 2 kiểm tra.
2. Nếu có `GEMINI_API_KEY`, Layer 2 kiểm tra review theo batch bằng schema trong `src/sample_ai_payload.json`. LLM chỉ được `confirm`, `correct` hoặc `abstain`; mọi lần sửa nhãn phải kèm trích dẫn nguyên văn. Kết quả sai ID, category lạ, quote không phải chuỗi con nguyên văn hoặc vi phạm bất biến sẽ bị backend từ chối.
3. TrustScore v3.1 đọc nhãn cuối cùng. Nếu Layer 2 lỗi hoặc không có khóa, hệ thống vẫn chạy bằng Layer 1 và ghi rõ provenance.

`LABELER_LLM_MODE=all` kiểm tra toàn bộ review; `uncertain` chỉ gửi các trường hợp xung đột/độ tin cậy thấp; `off` tắt Layer 2.

## Lưu dataset

Mỗi lượt phân tích tạo đúng hai file có chung `runId`:

- `reviews.raw.json`: dữ liệu vừa thu thập, chưa gắn nhãn;
- `reviews.labeled.json`: dữ liệu kèm nhãn Layer 1, phản biện Layer 2, nhãn cuối, evidence, phiên bản pipeline, quyết định lọc cuối `included` và `exclusionReason`.

API phân biệt rõ `stats.included` (review được giữ làm bằng chứng hiển thị) với `stats.trustSample` (mẫu `N_genuine` của TrustScore sau khi loại seeding theo tài liệu v3.1). Trường cũ `genuine` và `algorithmSample` vẫn được giữ để tương thích client cũ.

Khi chạy local, file nằm trong `data/review-runs/YYYY/MM/DD/<product>/<runId>/`. Khi chạy trên Vercel, filesystem của Function không phải storage bền vững; ứng dụng lưu hai file vào **private Vercel Blob** tại `review-datasets/YYYY/MM/DD/<product>/<runId>/` nếu có `BLOB_READ_WRITE_TOKEN`. Kết nối một Blob Store trong Vercel Storage với project để Vercel cấp biến này, rồi redeploy. Nếu chưa nối Blob Store, lượt phân tích vẫn trả kết quả nhưng `dataset.saved=false` và có warning rõ ràng.
