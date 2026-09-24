# Khôi phục blog công khai (24/09/2026)

## Trạng thái và phạm vi

- 17 bài đã xuất bản, trang `/bai-viet` và `/sitemap.xml` được chụp từ HTML công khai hiện tại. Các route công khai trỏ tới file tĩnh trong `public/blog/snapshots/`, không đọc Redis hoặc Vercel Blob khi người đọc mở trang.
- 334 URL ảnh Blob được tham chiếu bởi các trang này đã được lưu nguyên bytes trong `public/assets/blog-recovered/`. HTML chỉ đổi host/đường dẫn URL ảnh, không viết lại nội dung, markup, CSS, ngày hay metadata SEO. `snapshot-manifest.json` lưu SHA-256 để kiểm tra.
- 9 bài HTML gốc trong `public/blog/` vẫn giữ nguyên. Các ảnh gốc của chúng trong `public/assets/blog/` cũng giữ nguyên.
- Đây là bản cố định tại thời điểm xuất. Nó không tự đồng bộ với bản nháp/revision mới. API quản trị tạm trả `409 BLOG_PUBLIC_SNAPSHOT_FROZEN` cho xuất bản, gỡ đăng, lưu trữ và nhập bài cũ để tránh báo thành công sai. Lưu bản nháp và xem trước chưa thay đổi trang công khai.

## Kiểm tra trước khi hạ gói Vercel

1. Chạy `node --test test/blog-snapshots.test.mjs`: đối chiếu HTML sau khi đảo URL ảnh với SHA-256 HTML gốc; kiểm tra hash của 334 file ảnh và toàn bộ rewrite.
2. Sau khi deploy, GET đủ 17 URL `/bai-viet/:slug`, `/bai-viet`, `/sitemap.xml`, một số ảnh `/assets/blog-recovered/...`; xác nhận 200 và nội dung/ảnh hiển thị. Không chỉ dựa vào trạng thái build Ready.
3. Kiểm tra Blog Studio hiển thị cảnh báo và từ chối xuất bản. Không hạ gói trước khi các bước trên đạt.

## Giới hạn

Khôi phục này chỉ cách ly **trang blog công khai đã xuất bản và ảnh mà chúng tham chiếu**. Dữ liệu revision/bản nháp và upload ảnh mới trong Blog Studio vẫn phụ thuộc Blob; dữ liệu review/product, ảnh mirror ở luồng phân tích và các tính năng khác chưa được di chuyển. Hạ gói có thể khiến các luồng đó ngừng hoạt động nếu Blob chạm hạn mức Hobby. Không xoá Blob store hoặc token trước khi hoàn tất di chuyển toàn bộ dữ liệu cần giữ.

## Rollback

Nếu file tĩnh có lỗi, bỏ các rewrite snapshot trong `vercel.json` và đặt `BLOG_PUBLIC_SNAPSHOT=off` để dùng lại CMS/Blob, **chỉ khi Blob còn truy cập được**. Có thể tái xuất bản tĩnh bằng `node tools/snapshot-published-blog.mjs`, nhưng script không ghi đè bản đã có; cần chủ động quản lý manifest và file cũ khi muốn cập nhật nội dung.
