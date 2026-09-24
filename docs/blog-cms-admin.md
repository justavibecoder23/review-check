# Blog CMS RealView

## Phạm vi

- Trang quản trị: `/admin/blog`
- API quản trị: `/api/admin-blog`
- API danh sách bài public: `/api/blog-public`
- Hub blog render phía server: `/bai-viet`
- Bài viết động: `/bai-viet/:slug`
- Sitemap: `/sitemap.xml`
- RSS: `/bai-viet/rss.xml`

CMS dùng chung hệ thống tài khoản hiện tại. Quyền không lấy từ dữ liệu phía trình duyệt mà được xác định lại ở backend bằng allowlist:

- `BLOG_ADMIN_EMAILS` hoặc `BLOG_ADMIN_USER_IDS`: toàn bộ vòng đời bài viết và quản lý quyền admin/editor. Admin gốc trong cấu hình Vercel không thể bị sửa hoặc thu hồi từ giao diện.
- `BLOG_EDITOR_EMAILS` hoặc `BLOG_EDITOR_USER_IDS`: tạo, sửa, xem trước, lưu bản nháp, khôi phục revision, xuất bản, gỡ xuất bản và lưu trữ; không được quản lý quyền.

Các danh sách nhận nhiều giá trị, phân cách bằng dấu phẩy.

## Lưu trữ

- Redis lưu metadata, index bài, ánh xạ slug, redirect, revision pointer, audit log và khóa chống ghi đồng thời.
- Vercel Blob private lưu nội dung revision khi có `BLOB_READ_WRITE_TOKEN`; nếu chưa có token, revision được lưu trong Redis để hệ thống vẫn hoạt động.
- Vercel Blob public lưu ảnh đã được backend kiểm tra và chuyển sang WebP. Blog Media ưu tiên token riêng `BLOG_MEDIA_BLOB_TOKEN`, sau đó mới fallback về `BLOB_READ_WRITE_TOKEN` để tương thích ngược.
- `BLOG_MEDIA_BLOB_TOKEN` phải trỏ tới một Blob Store Public. Không thay token private dùng cho revision, dataset hoặc product cache bằng token của store ảnh blog.
- Mỗi lần lưu tạo revision bất biến mới. Khôi phục một revision cũ cũng tạo revision mới, không ghi đè lịch sử.
- Khi bài đã xuất bản được sửa tiếp, metadata public giữ một snapshot riêng của revision đã xuất bản. Tiêu đề, slug, ảnh và canonical nháp không xuất hiện trên hub, sitemap hoặc RSS trước khi admin bấm xuất bản lại.
- Ngày cập nhật public cũng thuộc snapshot đã xuất bản. Lưu nháp không làm thay đổi `dateModified`, ngày hiển thị, sitemap hoặc RSS.
- Danh sách bài được đọc theo trang thay vì giới hạn 100 record. Sitemap/RSS luôn quét hết tập bài trong giới hạn an toàn của CMS, vì vậy bài cũ không tự biến mất khi số lượng bài tăng.

## Quy trình biên tập

1. Đăng nhập bằng tài khoản có trong allowlist.
2. Tạo bài hoặc mở bài hiện có.
3. Soạn nội dung theo block; ảnh chỉ nhận JPEG, PNG, WebP hoặc AVIF tối đa 3 MB.
4. Dùng **Xem trước** và sửa các lỗi SEO bắt buộc.
5. Editor hoặc admin có thể lưu bản nháp và xuất bản. Chỉ admin được quản lý quyền truy cập.
6. Khi đổi slug của bài đã xuất bản, CMS giữ redirect 308 từ slug cũ.
7. Khi gỡ xuất bản/lưu trữ, bài bị loại khỏi route public, danh sách blog động, sitemap và RSS.

### Cấu hình kho ảnh Blog Studio

Tạo một Vercel Blob Store mới với access **Public**, sau đó gán token của store vào `BLOG_MEDIA_BLOB_TOKEN` ở cả Preview và Production. Store Private không thể nhận request upload có `access: 'public'`; khi cấu hình sai, API trả mã `BLOG_MEDIA_PUBLIC_STORE_REQUIRED` và không lưu dở một asset.

Token `BLOB_READ_WRITE_TOKEN` hiện hữu vẫn được giữ cho các Blob private khác. Sau khi cập nhật biến môi trường, cần redeploy môi trường tương ứng để function nhận token mới. Ảnh đã lưu ở URL public cũ không cần thay đổi; chỉ các URL private mới cần migrate sang store public.

### Dedup ảnh và kiểm soát Advanced Operations

- Ảnh mới được nhận dạng bằng SHA-256 của bytes nguồn cùng phiên bản quy tắc xử lý/profile kích thước. Khi upload lại cùng ảnh, Redis trả lại URL WebP đã có; alt text và người upload vẫn lấy từ lượt dùng hiện tại. Ảnh cũ và revision cũ không bị đổi URL.
- Trên Vercel, upload sẽ từ chối nếu chưa cấu hình Redis thay vì âm thầm bỏ dedup và phát sinh Put không kiểm soát. Chế độ local thiếu Redis vẫn giữ đường upload cũ để phát triển/test.
- Ba key `blog-media:dedup:v1:{hash}`, `blog-media:lock:v1:{hash}` và `blog-media:fence:v1:{hash}` dùng chung Redis hash tag. Script Lua cấp lock, gia hạn, công bố mapping và nhả lock theo owner/fence; mapping và nhả lock nằm trong cùng script nguyên tử. Thời gian chờ lock của yêu cầu thứ hai là 15 giây; hết hạn trả `BLOG_MEDIA_RETRY` với nút **Thử lại**, không tự upload lần hai.
- **Không đặt TTL hoặc dọn key fence.** Sau khi restore Redis từ backup cũ, phải tạm dừng upload và đổi namespace/rule-version sau khi kiểm tra, không tái dùng counter có thể đã lùi. Redis và Blob không có transaction chung: Put cũ hoàn tất sau khi mất lock có thể để lại object mồ côi, nhưng không được công bố mapping bởi chủ cũ.
- Pathname Blob mới cố định theo hash/profile/width và `allowOverwrite: false`. Nếu phản hồi Put không rõ, backend kiểm tra đúng pathname bằng `head()` (Simple Operation) rồi mới quyết định; không tự động Put lại với tên khác. Lượt đầu không HEAD phủ đầu. Nếu một lượt trước bỏ dở, lượt retry chỉ HEAD các pathname đã định để tái dùng biến thể đã lưu, rồi mới Put phần thiếu.
- Audit theo ngày tại `blog-media:audit:v1:YYYY-MM-DD`, lưu 30 ngày và tối đa 20.000 sự kiện/ngày, gồm `requestId`, hash, `put_attempted`, `put_confirmed`, `put_failed`, dedup hit và kết quả upload. Không ghi token hay bytes ảnh. Nếu audit sau Put bị lỗi, hệ thống ghi cảnh báo có cấu trúc vào function log; mapping đầy đủ vẫn là nguồn xác nhận cuối cùng.
- `BLOG_MEDIA_WIDTH_PROFILE=legacy` là mặc định (480/960/1600); `two` chỉ tạo 800/1600 cho upload mới. Chỉ bật `two` sau khi có baseline trên mobile 1×/2× và desktop, so screenshot từng viewport/DPR, đo KB/ảnh, tổng KB và LCP p75. Ngưỡng LCP: `LCP_mới − LCP_baseline ≤ min(10% × LCP_baseline, 200ms)`. Đổi lại `legacy` là rollback cho ảnh upload sau đó; URL cũ vẫn nguyên.
- Báo cáo orphan là thao tác **thủ công, chỉ đọc**: `node tools/report-blog-media-orphans.mjs --acknowledge-list-cost`. Nó quét toàn bộ bài và mọi revision, sau đó `list()` prefix ảnh v1, chỉ liệt kê object không còn được tham chiếu và đã trên 30 ngày. `list()` tốn Advanced Operations; báo cáo không xóa gì. Phải duyệt thủ công trước mọi thao tác dọn dẹp.

Khi xuất bản, mọi bài liên quan được chọn trong metadata hoặc block **Bài viết liên quan** phải tồn tại và đang public. Backend từ chối liên kết đến bài nháp, bài đã gỡ, slug sai hoặc chính bài đang chỉnh sửa. Các slug HTML legacy vẫn được chấp nhận trong giai đoạn migration.

## Cách hub và SEO được sinh

- `/bai-viet` được render phía server từ snapshot public. Card bài viết và `CollectionPage/ItemList` schema có ngay trong HTML đầu tiên; JavaScript chỉ đảm nhiệm tìm kiếm và lọc giao diện.
- Sitemap, RSS, hub, canonical, Open Graph, Twitter Card, `BlogPosting`, breadcrumb và FAQ đều dùng cùng một snapshot public để tránh lệch dữ liệu.
- Hub `/bai-viet` lấy `lastmod` theo bài public mới được cập nhật gần nhất. Sitemap không dùng thẻ mở rộng ảnh đã bị Google ngừng hỗ trợ.
- Tên tác giả xuất hiện trong schema và giao diện. Nếu nhập URL hồ sơ tác giả, tên tác giả trên bài sẽ liên kết bằng `rel="author"`. Email quản trị không bao giờ được trả qua API public.
- Ảnh social xuất kèm MIME type, kích thước (nếu đã biết) và alt text cho Open Graph/Twitter. CMS cảnh báo khi thiếu kích thước hoặc ảnh quá nhỏ.

Các route bài và danh sách public chỉ cache ngắn, không dùng `stale-while-revalidate`: tối đa khoảng 30 giây cho trang/hub và 60 giây cho sitemap/RSS. Redirect lịch sử được thu gọn về slug đang xuất bản; khi bài bị gỡ, cả slug hiện tại lẫn slug cũ đều trả trạng thái không public thay vì rơi về HTML legacy.

## Chuyển các bài HTML hiện hữu vào CMS

Luôn chạy kiểm tra trước:

```bash
npm run migrate:blog
```

Lệnh này đọc toàn bộ file `.html` trong `public/blog`, chuyển sang content model và kiểm tra điều kiện xuất bản. Nó không ghi Redis hoặc Blob.

Sau khi code CMS đã được deploy và môi trường production có Redis/Blob, nạp dữ liệu bằng một môi trường shell đã có các biến production:

```bash
npm run migrate:blog -- --apply
```

Migration là idempotent:

- slug đã xuất bản sẽ được bỏ qua;
- bản import dở ở trạng thái draft sẽ được xuất bản tiếp;
- thao tác tạo bài bình thường không thể chiếm một trong 6 slug legacy trước migration.

Route bài legacy có fallback về HTML cũ nếu chưa có record CMS hoặc kho CMS tạm thời chưa khả dụng. Vì vậy nên deploy code trước rồi mới chạy `--apply`; không có khoảng trống 404 trong quá trình chuyển đổi.

## Kiểm tra sau migration

```bash
curl -I https://www.realview.com.vn/bai-viet/trustscore-la-gi
curl -sS https://www.realview.com.vn/sitemap.xml
curl -sS https://www.realview.com.vn/bai-viet/rss.xml
```

Sau đó đăng nhập `/admin/blog`, xác nhận đủ số bài đang có trong `public/blog`, mở một bài, xem preview và kiểm tra lịch sử revision. Không chạy `--apply` bằng token/biến môi trường Preview nếu mục tiêu là production.

## An toàn xuất bản

- Bài public chỉ render từ revision đã xuất bản; các lần lưu sau đó không tự thay đổi nội dung đang hiển thị.
- Backend từ chối publish khi thiếu H1, SEO title, meta description, canonical đúng slug, ảnh/alt, tác giả hoặc H2.
- Backend từ chối block trùng ID và nhiều hơn một block bài liên quan để không sinh ID HTML trùng lặp.
- Nội dung không nhận HTML thô. Renderer escape dữ liệu và chỉ hỗ trợ inline Markdown giới hạn cho chữ đậm, chữ nghiêng và liên kết an toàn.
- Slug, canonical, OG/Twitter metadata, BlogPosting, Breadcrumb, FAQ schema, sitemap và RSS được sinh từ cùng một content model.
