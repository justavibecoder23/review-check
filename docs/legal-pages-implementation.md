# Triển khai trang pháp lý RealView

## Phạm vi

- Bổ sung đúng hai liên kết trong hàng `footer-legal`, bên dưới hàng bản quyền
  landing page. Không sửa header, hero, section, các cột footer hoặc nội dung cũ.
- Hai trang công khai: `/chinh-sach-bao-mat`, `/dieu-khoan-su-dung`.
- Nội dung trả về trong HTML, không phụ thuộc JavaScript, tài khoản hoặc API.
- `legal.css` chỉ tải trên hai trang mới. `legal.js` chỉ bổ sung highlight mục lục;
  nếu tắt JavaScript, mục lục và navigation vẫn dùng được.
- Canonical, title/description riêng, WebPage/BreadcrumbList, sitemap tĩnh và
  sitemap động đều chứa hai URL. Các URL `.html` redirect 308 trên Vercel tới URL
  chuẩn; local server cung cấp nội dung tại cả URL chuẩn và tên file.

## Nguồn và build

- Nội dung: `src/legal-content.mjs`.
- Bộ dựng: `tools/build-legal-pages.mjs`.
- HTML xuất sẵn: `public/privacy.html`, `public/terms.html`.
- Chạy `npm run build:legal` sau khi sửa copy hoặc footer. Bộ dựng sao chép
  footer landing hiện có để hai trang mới không phát sinh một phiên bản footer khác.
- Chạy `node --test test/legal-pages.test.mjs` để kiểm tra nội dung, mục lục,
  metadata, tài nguyên, sitemap và tính tái lập của HTML đã xuất.

## Format tài liệu (điều chỉnh theo yêu cầu mới)

- Đối chiếu [Apple Privacy Policy](https://www.apple.com/legal/privacy/en-ww/),
  [Microsoft Services Agreement](https://www.microsoft.com/en-us/servicesagreement)
  và [Chính sách quyền riêng tư Google](https://policies.google.com/privacy?hl=vi).
  Học cách phân cấp văn bản, metadata và mục lục, không sao chép nội dung pháp lý.
- Một cột văn bản trên nền trắng; bỏ card bo tròn, nhãn trang trí, màu cam ở nội dung
  và mục lục bên cạnh. Heading chính 1–8, tiểu mục có nhãn chuyển thành 2.1., 2.2.,…;
  các điều khoản không có nhãn dùng danh sách a., b.,….
- Mục lục dùng đúng tên các heading. Chữ thân bài 16px, canh trái, dòng 1.75;
  bảng nhà cung cấp chuyển sang các hàng dọc trên màn hình hẹp.
- Thêm CSS in tài liệu: bỏ header/footer ứng dụng, giữ mục lục và văn bản, giữ
  heading với đoạn tiếp theo, lặp đầu bảng. Chưa kiểm thử bản in/PDF thực tế.
- Không thay `src/legal-content.mjs`, HTML landing hoặc stylesheet landing trong
  lần sửa format này. Thông tin nguồn và ngày cập nhật nội dung không thay đổi.
- Test riêng về hierarchy và bảo toàn từng đoạn/tiêu chí/bảng, ngoài test crawl
  và tính tái lập build đã có.

## Nội dung cần rà soát trước công bố

Copy bám theo mã nguồn hiện tại: tài khoản/password hash, phiên 30 ngày,
xác minh tạm thời 10 phút, lịch sử tối đa 50 mục, review raw/labeled lưu riêng
qua Vercel Blob, Google/Gemini, email Gmail/Resend, GA và Vercel analytics.
Tên liên hệ/email lấy từ trang liên hệ hiện có; không gán UEH là bên vận hành.

Không hứa xoá tức thì, không khẳng định không có analytics hoặc đã có cookie
consent, không ghi tài khoản Google được dùng huấn luyện AI, không bảo đảm
Google phê duyệt hoặc TrustScore xác nhận thật/giả 100%.

Trước deploy, người phụ trách cần duyệt nội dung và đối chiếu nhà cung cấp thực
tế/retention/khả năng xử lý yêu cầu xoá. Đây là triển khai kỹ thuật và bản nội dung
đề xuất, không phải chứng nhận tuân thủ pháp luật. Lần này chưa deploy, chưa sửa
Branding trong Google Cloud và chưa thay giao diện đăng nhập.

## Nguồn đối chiếu crawl / Google OAuth

- https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- https://developers.google.com/identity/protocols/oauth2/policies

HTTP 200 + robots cho phép + sitemap giúp đủ điều kiện crawl; không bảo đảm
thời điểm Google crawl/index. Xác nhận URL public và Google Search Console sau
khi được phép phát hành.

## Kiểm thử thực hiện

- Test trang pháp lý + snapshot sau sửa format: 12/12 đạt.
- HTTP local với User-Agent Googlebot, không cookie: cả hai trang và sitemap
  trả 200, văn bản nằm trong HTML gốc. Không phải xác nhận Google đã crawl.
- Browser: mở link từ footer landing → bảo mật → điều khoản; mục lục neo và
  highlight hoạt động. Kiểm tra 320/390/736/1280px, không tràn ngang ở hai trang.
- Kiểm tra lại format tài liệu ở cả bốn kích thước; bảng 320px rộng 281px, không
  tràn ngang. Khi navigation xuống hai hàng ở 320px, tăng offset neo mục lục:
  mép trên section 174px, thấp hơn mép dưới header 155px nên không che heading.
- SHA-256 của copy chính sách, HTML landing và CSS landing giống trước/sau lần
  sửa format; không thay nội dung, bố cục hoặc hàng pháp lý đã có ở footer.
- Đối chiếu `git show HEAD:public/index.html`: sau khi bỏ hàng `footer-legal`
  mới, HTML landing giống hệt bản trước. Grid/footer cũ không bị sửa.
- Chừa vùng bên phải hàng pháp lý để nút lên đầu trang hiện có không che link.
- Unit regression `node --test test/*.test.mjs`: 653 đạt, 3 lỗi, 1 bỏ qua.
  Ba lỗi thuộc `test/blog-page.test.mjs`, đã có từ bản HEAD: hai test đòi 9 bài
  trong khi bản cũ đã có 16; một test đòi sitemap API trong khi HEAD đã dùng
  snapshot tĩnh. Không sửa Blog để làm xanh các giả định cũ.
- `npm test` còn tự tìm helper `tools/google-login-http-test.mjs` của công việc
  Google trước đó; helper yêu cầu kết nối server 3137 và bị sandbox chặn. Lần
  triển khai pháp lý không dùng kết quả đó để tuyên bố Google E2E đã đạt.

Ảnh kiểm tra nằm trong `docs/previews/`. Preview local trên cổng 3144; chưa
commit, push hoặc deploy các thay đổi này.
