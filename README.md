# Review Thật?

Website độc lập (không extension) để lọc review nhiễu và tóm tắt nhược điểm lặp lại từ link sản phẩm Shopee/TikTok Shop.

## Chạy ngay

Yêu cầu Node.js 18 trở lên:

```bash
npm start
```

Mở `http://localhost:3000`, dán một link sản phẩm. Không cần cài package nào.

## Nguồn dữ liệu thực tế

Trình duyệt không được phép tự quét review Shopee/TikTok do CORS và cơ chế chống bot. Vì vậy việc lấy dữ liệu nằm ở server:

- Shopee: server thử lấy 50 review công khai bằng endpoint công khai khi URL có `shopId` và `itemId`.
- TikTok Shop hoặc trường hợp Shopee bị chặn: cấu hình một bot thu thập hợp lệ rồi gán `REVIEWS_BOT_URL` và (nếu có) `REVIEWS_BOT_TOKEN`.

Bot nhận `POST` JSON `{ "url": "...", "platform": "Shopee | TikTok Shop", "limit": 50 }` và cần trả `{ "reviews": [{ "rating": 1-5, "text": "...", "date": "...", "verified": true, "author": "..." }] }`.

Khi không có nguồn live, giao diện **luôn báo rõ** đang dùng dữ liệu mô phỏng. Đây là để demo được hoàn chỉnh mà không tạo ra nhận định sai về sản phẩm thật.

## Lọc chi phí thấp

Không gọi AI trong phiên bản mặc định. Bộ lọc quy tắc loại review nhận xu/seeding, review quá ngắn, và phản hồi chưa sử dụng; sau đó nhóm các cụm nhược điểm: chất liệu, form/size, sai mô tả, giao hàng, trải nghiệm sử dụng. Cách này cho phản hồi nhanh và không phát sinh chi phí API.
