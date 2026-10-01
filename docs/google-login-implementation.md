# Google + mật khẩu RealView — tích hợp

## Hành vi đã triển khai

- Nút Google chính thức (Google Identity Services) ở cả tab đăng nhập/đăng ký,
  theo bố cục đã duyệt. Không tự mở One Tap, không tự chọn tài khoản.
- Google mới không phải đặt mật khẩu RealView. Lựa chọn marketing không được
  gửi trong yêu cầu Google; lời mời marketing riêng có thể bỏ qua.
- Đăng nhập mật khẩu nhận `identifier` (email hoặc username), không phân biệt
  hoa/thường và loại bỏ khoảng trắng ở đầu/cuối. `username` cũ vẫn được hỗ trợ.
- Quên mật khẩu cho phép tài khoản chỉ có Google thêm mật khẩu lần đầu sau
  OTP gửi đến email đã lưu. Người đã có mật khẩu dùng cùng luồng để đặt lại.
- Menu tài khoản dùng `hasPassword`: chưa có → “Thêm mật khẩu RealView”; đã có
  → “Đổi mật khẩu”. Email của luồng cài đặt do server chọn từ phiên đăng nhập,
  không lấy email tùy ý từ request.
- ID, lịch sử, Google subject/link, quyền và lựa chọn marketing không bị ghi đè.
  Khi email Google trùng một tài khoản mật khẩu, phải xác nhận mật khẩu của
  tài khoản đó; không tự gộp chỉ vì trùng email.
- RealView không đọc, thay đổi hay khôi phục mật khẩu Google. Nếu không còn
  truy cập mailbox, cần khôi phục Google/email trước.

## OTP và phiên đăng nhập

Mã 6 số, sống tối đa 10 phút, băm với salt riêng trong Redis. Mỗi mã tối đa 5
lần thử, mỗi email tối đa 5 lần gửi/giờ, cách nhau ít nhất 60 giây; API còn có
giới hạn theo IP. Gửi lại vô hiệu mã cũ. Lua xử lý nguyên tử việc đếm thử,
so mã, tiêu thụ proof và cập nhật mật khẩu; không có cửa sổ chạy đồng thời
cho phép dùng cùng mã hai lần. Proof gắn ID/email và trạng thái mật khẩu lúc
gửi, không dùng được khi dữ liệu tài khoản đã thay đổi.

Mật khẩu tiếp tục dùng scrypt. Sau cập nhật, tăng `sessionVersion` để vô hiệu
tất cả phiên cũ, kể cả phiên Google. Luồng hiện có cấp một phiên mới sau OTP
hợp lệ; không dùng phiên cũ để xác minh thay đổi. Việc cấp phiên mới kiểm tra
nguyên tử phiên bản từ snapshot xác thực, tránh cấp lại phiên từ mật khẩu cũ
đã được kiểm tra trước một yêu cầu đổi mật khẩu đồng thời.

Phiên trước phiên bản này (Redis lưu trực tiếp user ID) vẫn được đọc với
version 0, không cần migrate dữ liệu/hủy phiên hàng loạt. Proof reset cũ chỉ
sống 10 phút; nếu không phù hợp format mới, người dùng yêu cầu một mã mới.
Cookie phiên HttpOnly/SameSite=Lax, Secure ở HTTPS. POST đòi Origin đúng
host/scheme; credential, password và OTP không được lưu vào browser storage.
Phản hồi quên mật khẩu không công bố email có tồn tại hay không; thời gian
gửi mail đồng bộ vẫn phụ thuộc nhà cung cấp (chưa có hàng đợi email độc lập).

## Hiệu năng và giao diện

Không sửa HTML/bố cục landing page. Google module, cấu hình, nonce và SDK chỉ
tải khi người dùng mở form tài khoản. Không tải file font 1,8 MB của prototype.
Nút do Google SDK render; hình đại diện/text cá nhân hóa do Google quyết định.
ResizeObserver chỉnh độ rộng nút khi đổi kích thước/màn hình. Form có spinner,
lỗi/thử lại, liên kết/OTP, hiện/ẩn mật khẩu, tab bàn phím, Escape và chính sách
pháp lý. Đóng modal xóa dữ liệu mật khẩu/mã đang nhập và pending UI.

## Cấu hình chạy thật

Giữ Redis/email giao dịch hiện có; cấu hình `GOOGLE_CLIENT_ID` và bật
`GOOGLE_LOGIN_ENABLED=true`. Google Console cần authorized JavaScript origins
đúng URL truy cập: production root/www; local dùng `localhost` với đúng port,
không thay bằng `127.0.0.1` khi origin đó chưa được cho phép. Không cần Client
Secret hay redirect URI cho callback popup này.

Không có thay đổi Google Cloud, biến Vercel hay deploy trong bước tích hợp.
Email thực/đăng nhập Google thực vẫn cần kiểm tra trên môi trường triển khai
với người dùng thao tác chọn tài khoản Google. Không coi kiểm thử mô phỏng là
Google/Redis/email thật.

## Kiểm thử

`test/google-login-ui.test.mjs` chạy DOM thật bằng jsdom, frontend thật và các
handler/storage/Lua thật. Google dùng JWT ký RSA/certificate thử nghiệm, Redis
và mailbox giả lập. Bao phủ Google-only → OTP → thêm mật khẩu → đăng nhập email;
liên kết tài khoản cũ với mật khẩu sai/đúng; OTP email ngoài Google; lỗi Google
vẫn giữ đăng nhập mật khẩu; giữ lịch sử/ID và không lưu credential trên browser.
Các suite account/API/Google/password kiểm tra cạnh tranh, hết hạn, replay,
CSRF, cooldown, rate limit và vô hiệu phiên cũ.

Kết quả tại bước tích hợp: 73/73 kiểm thử liên quan tài khoản đạt, 0 bỏ qua.
Do thư viện trong checkout có file iCloud/dataless không đọc được, các suite
được chạy với dependency loader trỏ thư viện npm cùng phiên bản trong thư mục
tạm độc lập. Không thay node_modules hiện có của người dùng.

Server `tools/account-ui-integration.mjs` là công cụ QA chỉ trong `tools/`,
không có endpoint tương ứng trong production. Bind loopback, host `localhost`
chính xác; Redis/mail chỉ trong bộ nhớ và mất khi dừng. Chạy:

```sh
node tools/account-ui-integration.mjs --mock-google
# http://localhost:3146 — Google mô phỏng, xác minh bằng cert test
ACCOUNT_UI_TEST_PORT=3137 node tools/account-ui-integration.mjs
# SDK Google chính thức, Redis/mail vẫn giả lập
```

SDK chính thức đã hiển thị ở local; kiểm tra trực quan desktop và mobile
390/320 px, không tràn ngang. Đăng nhập với Google thật chưa được thực hiện
trong lần kiểm tra này. Chỉ suite liên quan auth được xác nhận; kiểm thử toàn
dự án bị gián đoạn bởi file iCloud/dataless lỗi đọc `ETIMEDOUT`.

Tham khảo kỹ thuật: [Google GIS](https://developers.google.com/identity/gsi/web/reference/js-reference),
[OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
Luồng cấp phiên sau OTP được giữ theo ứng dụng hiện có; không phải khẳng định
đã áp dụng mọi khuyến nghị của OWASP.
