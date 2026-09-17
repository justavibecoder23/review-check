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
- Vercel Blob public lưu ảnh đã được backend kiểm tra và chuyển sang WebP.
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
