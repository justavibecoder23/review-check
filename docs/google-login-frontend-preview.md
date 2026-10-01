# Bản duyệt frontend đăng nhập Google

Chỉ dựng prototype để duyệt giao diện. Chưa sửa `public/auth.js`,
`public/auth.css`, landing HTML hoặc backend/Google Cloud/Redis/production.

## Xem và chạy

- `node tools/google-login-preview-server.mjs`
- URL mặc định: `http://127.0.0.1:3145/`; chỉ bind loopback.
- Đổi cổng bằng `GOOGLE_PREVIEW_PORT` nếu cần.
- Toàn bộ bản duyệt ở `docs/previews/google-login/`, ngoài thư mục `public/`.
- Server chỉ có các file trong allowlist; không có API đăng nhập, không đọc env
  tài khoản hoặc Redis. Trang và HTTP header đều đánh dấu noindex/nofollow.
- Mọi tương tác mô phỏng chạy cục bộ: không gửi form, email hay thông tin cho
  Google/Redis. Không nhập mật khẩu thật. Giá trị form không lưu vào storage,
  reset khi chuyển trạng thái hoặc đóng cửa sổ.

## Thiết kế đề xuất

- Giữ luồng đăng nhập/đăng ký có sẵn. Google nằm trên form mật khẩu, ngăn cách
  bằng dòng “hoặc dùng tài khoản RealView”. Màu cam chỉ dùng cho hành động RealView.
- Logo G và Google Sans lấy từ Google; không tự vẽ hoặc đổi màu logo.
- Khi chờ, nút Google giữ nguyên nhãn và vô hiệu hoá; trạng thái/spinner nằm dưới
  nút. Không mô phỏng cửa sổ chọn tài khoản Google hoặc yêu cầu mật khẩu Google.
- Các màn hình liên kết tài khoản (`link_required`) và xác minh email
  (`email_required`) tương ứng contract backend đã có, không tự gộp tài khoản
  chỉ vì hai email trùng nhau.
- Marketing consent không chọn sẵn, không gộp với đăng nhập Google.
- Hai liên kết pháp lý độc lập trong phần cuối form.

## Nguồn tài nguyên

- Branding: https://developers.google.com/identity/branding-guidelines
- Logo chính thức: https://developers.google.com/static/identity/images/g-logo.png
- Google Sans: https://fonts.google.com/specimen/Google+Sans
- Font CSS: https://fonts.googleapis.com/css2?family=Google+Sans:wght@500&display=swap

Font TTF đầy đủ chỉ dùng cho bản duyệt offline. Sau khi được duyệt, dùng nút do
Google Identity Services render thay cho nút mô phỏng; SDK chỉ tải khi mở modal,
giữ sẵn chiều cao nút, không tải thêm tài nguyên Google ở lần tải landing đầu.
Không mang font TTF preview vào bundle production.

## Trước khi nối backend

Chờ người dùng duyệt thiết kế. Sau đó tích hợp GET config khi mở modal, challenge
nonce trong bộ nhớ, GIS callback, xác thực và pending flows theo
`docs/google-login-backend.md`. Không bật One Tap hoặc auto-select mặc định.
Prototype này không chứng minh Google login hay Redis E2E hoạt động.
