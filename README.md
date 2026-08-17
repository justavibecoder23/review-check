# Review Thật?

Website độc lập (không extension) để lọc review nhiễu và tóm tắt nhược điểm lặp lại từ link sản phẩm Shopee/TikTok Shop.

## Chạy ngay

Yêu cầu Node.js 18 trở lên:

```bash
npm start
```

Mở `http://localhost:3000`, dán một link sản phẩm. Không cần cài package nào.

## Nguồn dữ liệu thực tế

Shopee bảo vệ endpoint review bằng chữ ký chống bot tạo trong phiên trình duyệt. Do đó ứng dụng Vercel **không gọi trực tiếp** API nội bộ Shopee. Thay vào đó, thư mục `bot/` chứa một collector độc lập chạy Chromium/Playwright; nó nhận link, lấy tối đa 50 review thật, cache 15 phút và trả về API JSON.

Bot nhận `POST /reviews` với JSON `{ "url": "...", "platform": "Shopee", "limit": 50 }` và trả `{ "reviews": [{ "rating": 1-5, "text": "...", "date": "...", "verified": true, "author": "..." }] }`.

### Triển khai bot

Deploy riêng thư mục `bot/` lên một dịch vụ hỗ trợ Docker. Thiết lập biến môi trường `REVIEWS_BOT_TOKEN` là một chuỗi bí mật mạnh. Sau đó tại Vercel, thêm:

```text
REVIEWS_BOT_URL=https://<ten-bot-cua-ban>/reviews
REVIEWS_BOT_TOKEN=<cung-gia-tri-voi-bot>
```

Vercel sẽ gửi link sản phẩm sang bot; bot không trả review mô phỏng. Khi Shopee từ chối phiên thu thập, giao diện báo lỗi thay vì hiển thị review của sản phẩm khác.

TikTok Shop chưa có collector trong phiên bản này và sẽ báo rõ là chưa hỗ trợ.

## Lọc chi phí thấp

Không gọi AI trong phiên bản mặc định. Bộ lọc quy tắc loại review nhận xu/seeding, review quá ngắn, và phản hồi chưa sử dụng; sau đó nhóm các cụm nhược điểm: chất liệu, form/size, sai mô tả, giao hàng, trải nghiệm sử dụng. Cách này cho phản hồi nhanh và không phát sinh chi phí API.
