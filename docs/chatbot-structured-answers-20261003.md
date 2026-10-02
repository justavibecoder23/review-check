# Chatbot: nâng cấp nội dung và định dạng, ngày 03/10/2026

> Báo cáo này ghi nhận đợt nâng cấp định dạng ban đầu. Đợt triển khai reliability tiếp theo đã bổ sung deadline tổng, retry và idempotency; trạng thái cùng số liệu kiểm thử mới nằm ở [báo cáo ổn định kết nối](chatbot-connection-reliability-20261003.md). Các kết quả bên dưới là số liệu tại thời điểm đợt đầu, không phải tổng test cuối.

## Trạng thái và phạm vi

Đã triển khai local trên clone main tại commit nền `a06b596`. Chưa commit, push, tạo preview deployment hay deploy production. Website production chưa đổi.

Đây là đợt nâng cấp theo đề xuất trả lời có cấu trúc. Tại thời điểm đợt này: không thay model, pool credential, Actor, storage, phân quyền lịch sử, thời hạn context hay thuật toán phân tích review; kiến trúc retry/idempotency được triển khai ở đợt tiếp theo nêu trên.

## Những thay đổi đã có

- Contract `answerDocument.version = 2.0`: `summary`, `sections`, bằng chứng theo từng ý, `limitations` và action whitelist. `answer` văn bản được tạo từ contract để giao diện cũ và lưu hội thoại vẫn đọc được.
- FAQ, Gemini và dự phòng đều dùng formatter chung. FAQ tiếp tục trả trực tiếp, không gọi Gemini/Redis để định dạng.
- Prompt trả lời trực tiếp trước, giải thích từng ý, nêu phần thiếu, phân biệt TrustScore với chất lượng sản phẩm và review mẫu với toàn bộ đánh giá trên sàn.
- Đồng bộ thông tin vận hành dùng chung; email hỗ trợ là `realviewueh@gmail.com`. Kiểm thử toàn bộ tiêu đề/biến thể của 90 FAQ, vẫn giữ nguyên ID.
- Bỏ cắt câu trả lời ở 1.200 ký tự. Validator từ chối đầu ra quá giới hạn hoặc `MAX_TOKENS`; không hiển thị một câu trả lời AI bị cắt như thể đã hoàn tất.
- Giữ tin assistant gần nhất tối đa 7.000 ký tự; lịch sử tối đa 8 tin và 14.000 ký tự tổng. Khi cần giảm context, bỏ tin cũ nguyên vẹn hoặc giữ câu hoàn chỉnh, không cắt giữa câu trả lời. Giới hạn câu hỏi user 500 ký tự giữ nguyên.
- Dữ liệu số thiếu/rỗng/boolean không trở thành 0; 0 thật vẫn được giữ. Có guard cho cách viết điểm `/100`, `TrustScore: ...` và một số mẫu số lượng review rõ ràng.
- Mã trích dẫn AI chỉ lấy từ các review thực sự được cung cấp cho model. Nội dung bằng chứng lấy từ context đã xác thực ở server, không dùng đoạn review do model tự viết.
- Giao diện có tiêu đề, bullet/bước đánh số, lưu ý riêng, `<details>` mở bằng chứng tại nhận định và action cố định cùng website. Dữ liệu AI dùng `textContent`, không đưa vào `innerHTML`.
- Không kéo xuống cuối khi người đọc đang xem tin cũ. Phân biệt lỗi quyền/context/hết hạn/rate limit/timeout; nhãn dự phòng phân biệt quota, AI bận, kết nối và đầu ra chưa hoàn tất.
- API chat trả `Cache-Control: private, no-store` để response báo cáo không vào shared cache.

## Feature flag và rollback

`CHATBOT_STRUCTURED_ANSWERS=off` trả contract văn bản cũ; giao diện tự dùng nhánh plain text. V2 đang mặc định bật trong code mới, nhưng chưa được deploy. Nếu triển khai preview, bật/test V2 ở preview trước. Khi triển khai production nên bắt đầu với flag `off`, xác nhận môi trường, sau đó bật có kiểm soát. Đổi biến môi trường Vercel có thể cần redeploy để có hiệu lực; đây không phải nút rollback tức thời trong Studio.

Rollback định dạng không hoàn tác những sửa an toàn độc lập: email liên hệ đúng, số thiếu không thành 0 và header private/no-store.

## Chi phí và độ trễ

Model vẫn là `gemini-3.5-flash-lite`; đợt định dạng giữ ngân sách phần trả lời AI 10 giây và số lần thử provider như trước. Đợt reliability sau bổ sung deadline tổng 12 giây và trần hai provider call. Không thêm lượt AI chỉ để format/validate.

V2 nâng `maxOutputTokens` từ 1.024 lên 2.048. Đây là trần, không phải số token luôn dùng; đầu ra và lịch sử dài hơn vẫn có thể tăng token, reservation và độ trễ. Không có bằng chứng để coi nâng cấp là miễn phí hoặc p95 không đổi.

## Kết quả kiểm thử

1. Bộ test liên quan chatbot: **133/133 đạt**. Có 60 FAQ độc lập và các trường hợp nhiều ý, lịch sử, so sánh nhiều báo cáo khi AI gián đoạn, hỏi tiếp, số thiếu, sai điểm/số lượng, trích dẫn không tồn tại, dữ liệu HTML độc hại, đầu ra dài trên 1.200 ký tự, `MAX_TOKENS`, tương thích cũ và tắt flag. Các test provider dùng mock, không phải Gemini thật.
2. Regression toàn repo, `node --test --test-concurrency=2 test/*.test.mjs`: **833 test, 829 đạt, 3 lỗi, 1 skip**. Ba lỗi đã có ở baseline, trong `test/blog-page.test.mjs`: kỳ vọng 9 bài trong khi có 16; hai test liên quan số bài/layout; sitemap test kỳ vọng route động trong khi đang dùng snapshot. Không sửa các phần blog này trong đợt chatbot.
3. Một lượt regression với concurrency mặc định còn gặp test deadline 40 ms nhạy với tải CPU (provider chưa kịp được gọi trước deadline). Bộ liên quan riêng và lượt concurrency 2 đạt. Không dùng thời gian unit test để suy ra p95 production.
4. Browser localhost: mở Trợ lý, gửi FAQ “RealView hoạt động thế nào?”, xác nhận hướng dẫn 4 bước và lưu ý TrustScore. Tại 320/375/390/430/1280 CSS px, log không tràn ngang (`scrollWidth == clientWidth`). Đã reset viewport sau kiểm tra. Chưa chứng nhận mọi tổ hợp phóng to/font hay mọi báo cáo bằng kiểm tra trực quan.
5. `git diff --check` và kiểm tra freshness `home-widgets.css` đạt.

## Các cổng nghiệm thu còn lại trước production

- Chạy ít nhất 60 tình huống hỗn hợp trên preview có Gemini thật và review thủ công: đáp án trực tiếp, đủ từng ý, đúng nguồn, giới hạn rõ, ngôn ngữ dễ hiểu; cần đạt ít nhất 95%. Kiểm thử schema/FAQ không thay thế đánh giá chất lượng AI.
- Đo baseline và V2 trong cùng vùng/mạng/model, ghi input/output tokens, số request và p95. Điều kiện p95: `p95_mới - p95_baseline <= min(0.10 * p95_baseline, 200 ms)`.
- Kiểm thử hai tài khoản thật và context hết hạn để xác nhận không rò báo cáo; các test quyền hiện có vẫn được chạy nhưng không thay kiểm thử end-to-end tài khoản thật.
- Mở bằng chứng của báo cáo thật trên mobile và kiểm tra phóng to. Bằng chứng là trích đoạn từ context compact, không phải toàn bộ review trên sàn.
- Kiểm thử bật/tắt flag trên deployment. Sau đó mới quyết định bật production.

Validator số liệu hiện là lớp bảo vệ mẫu phát biểu rõ ràng, không chứng minh mọi cách diễn đạt đều đúng hoặc mọi nhận định thật sự được review hỗ trợ. Với nhiều sản phẩm, kiểm tra tập điểm hợp lệ chưa bảo đảm model gán đúng điểm cho từng sản phẩm. Đây là lý do phải giữ cổng đánh giá nội dung, không tuyên bố đã loại bỏ hallucination.
