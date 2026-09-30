# Tối ưu tải trang chủ trên điện thoại — 30/09/2026

Thực hiện trong bản clone `.codex-pagespeed-20260930`, dựa trên commit `cc6da6c`; không sửa checkout chính đang có thay đổi khác. Báo cáo ghi nhận phép kiểm chứng local trước khi triển khai production.

## Thay đổi

- Đưa khung mascot, nút trợ lý và nút tài khoản vào HTML ban đầu. JavaScript tái sử dụng chúng, không chèn thêm khung làm hero dịch chuyển.
- Dành sẵn chiều cao cho trạng thái số lượt dùng thử, kể cả khi API chưa trả lời; dự phòng hai dòng trên màn hình ≤380px.
- Chuyển atlas và khung chạy PNG sang WebP từ ảnh gốc; giữ nguyên PNG để có thể đối chiếu. Điện thoại ≤700px dùng các khung happy/default/running riêng, không tải cả atlas cho homepage. Desktop vẫn dùng atlas đầy đủ và giữ các biểu cảm/hoạt họa.
- Chỉ chặn render bằng CSS giao diện chính và CSS tiện ích phía trên màn hình trên mobile. CSS dialog/chat/history tải không chặn render, có fallback noscript. Desktop vẫn tải ba stylesheet đầy đủ theo cách blocking.
- Chỉ trên homepage ≤700px: truy vấn session, quota và lịch sử chờ `load`, hai frame render, rồi idle callback. Nút mở dialog/history vẫn hoạt động ngay; submit vẫn được kiểm tra quota phía server. Desktop và các trang khác không trì hoãn khởi tạo dữ liệu.
- Thêm MIME WebP cho server local và cache immutable cho sáu asset WebP đã có phiên bản. Không cache API hoặc HTML lâu dài.

## Kiểm chứng

So sánh bản gốc và bản sửa bằng cùng browser, không throttle CPU/mạng, cache tắt ở server thử nghiệm. GET session/quota được mô phỏng có độ trễ 550/650ms. Thu thập bằng PerformanceObserver; CLS dùng cửa sổ phiên và bỏ qua shift có recent input. Các số dưới đây là phép đo local, **không phải điểm PageSpeed Insights hoặc dữ liệu người dùng thực tế**.

| Chỉ số | Bản gốc | Bản sửa |
| --- | ---: | ---: |
| CLS mobile 390×844 | 0,05025 | 0 |
| Ảnh mascot được tải trong khoảng 3 giây sau load trên mobile | 1.666.839 byte | 81.084 byte |
| CLS desktop 1440×1000 | 0,07146 | 0 |
| Ảnh mascot trong cùng cửa sổ desktop | 1.666.839 byte | 237.316 byte |

Giảm khoảng 95% dữ liệu ảnh mascot ban đầu trên mobile. Khung default còn được tải khi nhân vật chuyển sang đứng yên; vì vậy 81KB không phải tổng dung lượng mọi trạng thái hoặc toàn trang.

CSS tiện ích cần chặn render trên mobile: `home-widgets.css` khoảng 14,5KB thay cho ba stylesheet auth/chatbot/history khoảng 49KB (kích thước chưa nén). Các stylesheet đầy đủ vẫn tải để bảo đảm thao tác mở dialog hoạt động.

Kiểm tra thủ công: màn hình 320px và 390px không tràn ngang; đăng nhập, menu, lịch sử dành cho khách, mascot mở chatbot và xác thực form trống đều hoạt động. Không gửi yêu cầu cào review trả phí. Trang desktop được kiểm tra lại, không có JS error trong phép đo.

`npm test`: 618 test, 614 đạt, 1 bỏ qua, 3 lỗi có sẵn thuộc Blog/sitemap. Chạy riêng test Blog trên snapshot nguyên bản của HEAD cũng gặp đúng ba lỗi đó (22 đạt, 3 lỗi). Các test PageSpeed/mascot/branding: 16/16 đạt. Kiểm tra cú pháp JavaScript, CSS sinh tự động và `git diff --check` đạt.

## Bảo trì và bước triển khai

`home-widgets.css` được sinh từ `auth.css` và `chatbot.css`; không sửa trực tiếp. Sau khi sửa CSS nguồn, chạy:

```sh
npm run build:home-css
node tools/build-home-widget-css.mjs --check
```

Test tự động sẽ phát hiện CSS sinh ra bị cũ. Asset WebP dùng immutable cache: khi thay nội dung ảnh, tăng phiên bản tên file.

Sau khi deploy, đo lại PageSpeed mobile ít nhất ba lần, kiểm tra LCP thực tế và so sánh desktop. Không suy luận điểm PSI production từ phép đo local. Dữ liệu trải nghiệm thực tế 28 ngày sẽ chưa phản ánh thay đổi ngay lập tức.
