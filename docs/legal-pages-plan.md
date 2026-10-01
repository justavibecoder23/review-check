# Đề xuất triển khai trang pháp lý RealView

Trạng thái: bản đề xuất để duyệt thiết kế và nội dung, chưa triển khai production.

## 1. Vị trí và luồng giao diện

- Khuyến nghị: giữ nguyên các nhóm footer, bổ sung hai link dưới cột **Minh bạch**.
- Phương án thay thế: giữ các cột như cũ, đặt hai link ở hàng pháp lý cạnh bản quyền.
- Không đưa hai mục pháp lý lên navigation bar chính hoặc thêm banner gây phân tán.
- Mỗi link là thẻ `<a>` thật tới một trang riêng:
  - `/chinh-sach-bao-mat`
  - `/dieu-khoan-su-dung`
- Hai trang truy cập công khai, không cần đăng nhập, không chỉ nằm trong popup.
- Trang pháp lý dùng header/footer chung, breadcrumb, tiêu đề, ngày hiệu lực,
  phiên bản và mục lục có liên kết đến từng mục. Ngày hiệu lực chỉ điền khi duyệt
  nội dung; không tự lấy ngày dựng preview làm ngày ban hành.
- Mobile: xếp cột hợp lý, link có vùng chạm khoảng 44px, nội dung dễ đọc và
  không tràn ngang; không thêm ảnh lớn, thư viện hoặc hoạt ảnh chỉ để trang trí.

## 2. Nội dung Chính sách bảo mật

Đối chiếu từng điều với dữ liệu và cơ chế đang vận hành:

1. Đơn vị/người chịu trách nhiệm, phạm vi chính sách, email hoặc kênh hỗ trợ.
2. Dữ liệu tài khoản: tên, email, Google `sub`; mật khẩu được băm đối với tài
   khoản mật khẩu. Không mô tả ảnh Google là dữ liệu được lưu nếu hệ thống không lưu.
3. Lịch sử phân tích và dữ liệu kỹ thuật phục vụ phiên đăng nhập, chống lạm dụng;
   phân biệt dữ liệu người dùng với review sản phẩm công khai được thu thập.
4. Mục đích sử dụng; cookies phiên đăng nhập; việc đăng ký email cập nhật tách
   biệt với tạo tài khoản. Không tự hứa rằng website không thu dữ liệu kỹ thuật.
5. Nơi lưu, nhà cung cấp liên quan, dữ liệu được chia sẻ và phạm vi truy cập;
   rà soát Vercel/Redis/email/AI theo luồng dữ liệu thực tế trước khi công bố.
6. Thời hạn lưu, xoá và xử lý bản sao lưu. Không tự đặt mốc thời gian hoặc cam
   kết xoá tuyệt đối nếu chưa có cơ chế tương ứng.
7. Cách xem/sửa/yêu cầu xoá dữ liệu và xác minh người yêu cầu; cách ngừng email
   cập nhật. Không vẽ nút xoá tài khoản như tính năng đã có nếu chưa xây dựng.
8. Thông tin đăng nhập Google chỉ phục vụ xác thực; không yêu cầu Gmail/Drive
   trong phạm vi đăng nhập đang đề xuất. Cách cập nhật chính sách và thông báo.

## 3. Nội dung Điều khoản sử dụng

1. Đơn vị vận hành và phạm vi dịch vụ RealView.
2. Nguyên tắc dùng tài khoản, bảo vệ thông tin đăng nhập và liên hệ hỗ trợ.
3. Hành vi không được phép: gây gián đoạn hệ thống, lạm dụng truy cập hoặc nội dung.
4. Quyền sử dụng nội dung, review công khai và nội dung do người dùng cung cấp.
5. Kết quả phân tích mang tính tham khảo; giới hạn cỡ mẫu, thuật toán và nguồn
   dữ liệu. TrustScore là độ tin cậy của tập review, không phải điểm chất lượng
   sản phẩm hoặc xác nhận review thật/giả 100%.
6. Thay đổi dịch vụ, xử lý tài khoản, cập nhật điều khoản và kênh phản hồi;
   nội dung cần duyệt trước phát hành, không tự đưa cam kết pháp lý chưa xác nhận.

## 4. Các thông tin cần người phụ trách xác nhận

- Tên người/đơn vị chịu trách nhiệm; không tự ghi UEH là đơn vị vận hành pháp lý
  chỉ vì đây là dự án của sinh viên UEH.
- Email/kênh nhận yêu cầu quyền riêng tư đang hoạt động.
- Danh mục nhà cung cấp, mục đích và dữ liệu chia sẻ thực tế.
- Thời hạn lưu và quy trình yêu cầu xoá có thể thực hiện được.
- Có sử dụng dữ liệu tài khoản, lịch sử hoặc review cho nghiên cứu/huấn luyện AI
  hay không; phải phân biệt rõ loại dữ liệu và cơ chế áp dụng trước khi công bố.

## 5. Các bước triển khai sau khi duyệt

1. Chọn vị trí link footer và duyệt mẫu trang pháp lý.
2. Kiểm kê luồng dữ liệu, xác nhận các thông tin trên, soạn và duyệt nội dung đầy đủ.
3. Xây dựng hai trang trong dự án hiện có; nối link footer dùng chung và thêm
   link tương ứng vào giao diện đăng nhập/đăng ký sau khi thiết kế auth được duyệt.
   Không gộp chấp nhận điều khoản với đồng ý nhận email marketing.
4. Kiểm thử mở trực tiếp URL không đăng nhập; bàn phím, mobile/desktop,
   breadcrumb, mục lục, ngày hiệu lực và footer; đo lại hiệu suất.
5. Sau khi được phép phát hành: commit/push/deploy; xác nhận HTTP 200, HTTPS,
   hai link footer hoạt động trên production và không yêu cầu cookie đăng nhập.
6. Sau khi được phép sửa Google Cloud: khai báo Homepage/Privacy Policy/Terms
   URLs trong Branding, đối chiếu Authorized domains và trạng thái xác minh.
   Không coi việc có hai trang là bảo đảm Google sẽ tự động phê duyệt ứng dụng.

## Nguồn đối chiếu Google

- https://developers.google.com/identity/protocols/oauth2/policies
- https://developers.google.com/terms/api-services-user-data-policy
- https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid

## Bản duyệt

Preview tương tác: `realview-footer-legal.html` trong thư mục visualization của
cuộc trò chuyện. Hai trang trong preview là khung nội dung dự thảo để duyệt bố
cục, không phải văn bản pháp lý đã ban hành. Không thay file `public/` hoặc
cấu hình production trong lần đề xuất này.
