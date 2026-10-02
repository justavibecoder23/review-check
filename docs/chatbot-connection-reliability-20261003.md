# Chatbot: ổn định kết nối, ngày 03/10/2026

## Trạng thái

Đã triển khai và kiểm thử local trên clone main có commit nền `a06b596`. Giữ nguyên phần nâng cấp định dạng ở đợt trước. Chưa commit, push hay deploy. Không thay website production, Actor, model hoặc cấu hình dịch vụ trả phí.

Đây là báo cáo nghiệm thu code, không phải bằng chứng đã khắc phục các lần lỗi production trước đây. Chưa có mẫu log production đủ để xác định nguyên nhân chính; chưa đo Gemini thật, p95 hoặc tỷ lệ lỗi trước/sau triển khai.

## 1. Trạng thái và thông báo

API thống nhất `status: answered | fallback | temporarily_unavailable`, `code`, `retryable`, `requestId`, `retryAfterMs`; có `generationId` khi đã tạo lượt trả lời. Response luôn `Cache-Control: private, no-store`, kèm `X-Request-Id` và `Retry-After` khi biết thời gian chờ.

Phân biệt timeout, quá tải, quota, pool/Redis, lỗi định dạng, rate limit, quyền truy cập và context chưa sẵn sàng/hết hạn. HTTP 200 chứa fallback không được tính là Gemini trả lời thành công.

Frontend giữ câu hỏi trong hội thoại, giữ nguyên snapshot messages/context khi thử lại và không thêm user bubble trùng. Có tối đa hai lần thử lại thủ công; chỉ tự kiểm tra lại context đang chuẩn bị hoặc request đang chạy, tối đa ba HTTP request trong cùng ngân sách chờ. Không tự gửi lại sau timeout mạng. Khi tài khoản hoặc phạm vi thay đổi, hủy lượt đang chờ, bỏ nút retry; đổi tài khoản cũng xóa hội thoại cũ khỏi giao diện để không đưa câu hỏi/báo cáo riêng tư sang tài khoản mới.

JSON HTTP hỏng hoặc response 200 không có `answer` hợp lệ là lỗi riêng, không hiển thị đáp án chung như thể request đã hoàn tất.

## 2. Deadline và pool hiện có

Các mốc khởi đầu, chưa phải kết quả đo p95:

- Deadline server tổng: **12 giây**, bắt đầu tại `/api/chat`, bao gồm context, idempotency, rate limit, chọn key, Gemini và công bố đáp án có thể replay.
- Context tối đa 2 giây; claim Redis tối đa 700 ms; rate limit tối đa 800 ms. Lệnh Redis tương ứng có timeout và signal riêng, không được vượt ngân sách còn lại.
- Phần trả lời tối đa 10 giây và phải kết thúc trước deadline tổng để chừa khoảng 700 ms chốt đáp án. Lượt chính vẫn tối đa 3,2 giây, dự phòng 5,5 giây, nhưng đều bị chặn bởi thời gian còn lại.
- Trình duyệt dùng **một signal 15 giây** cho cả chuỗi kiểm tra lại, không cộng 15 giây cho từng lần.

Ghi generation và cập nhật health dùng `waitUntil` trên Vercel; không chặn response để đợi các bản ghi phụ, không bỏ promise tùy ý. Các thao tác này có timeout Redis 700 ms. Trong local không có platform request context, handler giữ và đợi các tác vụ sau khi đã gửi response. Deadline phục vụ response không có nghĩa tổng thời gian hoạt động của Function luôn dưới 12 giây.

Giữ `gemini-3.5-flash-lite`, key/pool chatbot độc lập và health/cooldown có sẵn. Không mượn key pipeline phân tích review. **Tối đa hai lời gọi provider thực tế** trong một lượt xử lý. Key bị health loại trước khi gọi không tiêu một attempt; có regression cho primary cooldown chuyển sang backup khỏe.

Lỗi mạng, timeout, 408, 5xx hoặc đầu ra không hợp lệ được cân nhắc thử thêm một lần. Backoff có jitter 200–399 ms, lấy giá trị lớn hơn nếu provider có `Retry-After`/Google RetryInfo; chỉ chạy nếu còn ngân sách. Không thử lại 400/401/402/403/404 hay bất kỳ quota/429 nào trong lượt hiện tại. Vault hiện chưa có ánh xạ project đủ tin cậy: một key khác không được coi là quota độc lập. Đây là lựa chọn bảo thủ; muốn retry 429 theo project phải bổ sung và kiểm chứng mapping trước, không tự suy diễn.

Các thay đổi trong helper Gemini là tùy chọn cho chatbot. Caller phân tích review không truyền chính sách mới, giữ hành vi cũ; regression helper và pipeline đã chạy.

## 3. Idempotency và timeout mơ hồ

Dùng Redis hiện có, không thêm kho hay ngân sách riêng. Client tạo `clientRequestId` cho mỗi lượt và `clientSessionId` theo tab; retry giữ cùng ID, messages, ngôn ngữ và context. Redis key chứa hash phạm vi phiên/tài khoản/context, không chứa cookie hoặc capability plaintext. Báo cáo lịch sử luôn được xác thực tài khoản/quyền đọc trước khi trả cả đáp án đã cache; báo cáo hiện tại phải xác thực capability và context còn hợp lệ trước.

Một Lua script claim nguyên tử, lease **45 giây**, record TTL **15 phút**. Kết quả:

| Trạng thái | Hành vi |
| --- | --- |
| Chưa có record | Claim owner và xử lý một lần |
| Complete | Trả lại đáp án, không gọi provider, không tăng rate counter |
| Pending | 409 `CHAT_REQUEST_IN_PROGRESS`, không mở lượt AI song song |
| ID cũ nhưng nội dung khác | 409 `CHAT_REQUEST_ID_CONFLICT` |
| Lease đã hết mà chưa chốt | 409 `CHAT_REQUEST_OUTCOME_UNKNOWN`, không takeover |

Script chốt chỉ cho đúng owner/fingerprint. Response JSON được lưu nguyên chuỗi, không round-trip qua Lua cjson làm mảng rỗng biến thành object. Nếu chốt đã áp dụng nhưng REST timeout, retry đọc lại complete để khôi phục. Owner gốc có thể chốt muộn khi lease chuyển sang uncertain; request khác không được giành lại record.

Chỉ nhả claim có điều kiện owner khi chưa có provider call nào bắt đầu. Sau khi Gemini đã được gọi, timeout không chứng minh provider chưa xử lý: giữ record để tránh gọi lại mù quáng. Nếu Redis claim/rate limit không khả dụng, client mới không gọi AI thiếu bảo vệ; vẫn có thể nhận FAQ/template an toàn.

Giới hạn cần hiểu đúng:

- Không có transaction Redis–Gemini, không cam kết exactly-once tuyệt đối. Sau TTL 15 phút, cùng ID có thể được xử lý như request mới. Không tự động retry quá cửa sổ đó.
- Client cũ không gửi request ID vẫn được hỗ trợ, nhưng không có bảo đảm chống trùng durable. Khi triển khai cần xác nhận JS mới đã đến trình duyệt.
- Retry cùng ID đã hoàn tất **trả lại đáp án cũ, kể cả fallback**, không tạo thêm lần sinh AI. Sau một response replay, giao diện không tiếp tục thêm nút retry. Muốn yêu cầu AI diễn giải mới phải chủ động gửi lượt hỏi mới; không che việc này bằng âm thầm đổi ID.
- Không có cron/cơ chế takeover request uncertain trong đợt này. Sự đánh đổi là có thể từ chối tạm thời một lượt đã mất kết quả thay vì phát sinh usage không kiểm soát.

## 4. Đáp án dự phòng

FAQ khớp chính xác vẫn trả trực tiếp. Câu nhiều ý chỉ gom tối đa ba FAQ khớp chắc chắn, nêu rõ phần còn thiếu; không coi keyword trùng lẻ là căn cứ trả lời. Khi thiếu AI và không có nội dung phù hợp, gợi ý chủ đề chính thức, không tạo câu trả lời sản phẩm.

Template báo cáo dùng context đã xác thực, số liệu, ưu/nhược điểm và review có sẵn. Thiếu số liệu là chưa xác định, không đổi thành 0. So sánh nhiều báo cáo chỉ nêu trường đã biết và giới hạn mẫu; không giả thành đánh giá toàn diện hay khẳng định chất lượng sản phẩm.

Nếu context mất/hết hạn/lỗi quyền thì trả lỗi context; không chuyển sang câu trả lời website khiến người đọc tưởng đang diễn giải sản phẩm. Nội dung dự phòng được gắn nhãn dữ liệu RealView, không giả là Gemini đã trả lời thành công.

## 5. Logging và usage

Một JSON event `chat_request_completed` ghi request ID, client request ID/retry cause allowlist, loại context, HTTP/status/code, source, fallback reason, số lời gọi provider thực tế, outcome/status từng attempt, input/output/total tokens khi provider cung cấp, thời gian từng giai đoạn và tổng response, cờ replay. Không ghi câu hỏi/review thô, account/result/credential ID, cookie, access token hay lỗi provider nguyên văn.

Frontend timeout chỉ xuất hiện trong log server nếu client thử lại và gửi retry cause. Đợt này chưa có telemetry endpoint riêng để ghi cả các lần client bỏ cuộc; không suy ra tỷ lệ timeout frontend hoàn chỉnh từ server log. Retention log phụ thuộc cấu hình hosting hiện có, chưa có kho audit dài hạn mới.

Không thêm dịch vụ trả phí **không đồng nghĩa không tăng usage**:

- Lượt owner có ID mới thêm hai EVAL idempotency: claim và complete. Rate limit vẫn một EVAL; generation chỉ SET complete một lần, bỏ bản ghi pending.
- Replay có một EVAL kiểm tra và các đọc xác thực/context cần thiết, không thêm provider call/rate increment/generation write.
- Health/cooldown và pool vẫn có thao tác Redis theo kiến trúc cũ; nhả claim chưa gọi AI thêm một EVAL khi cần.
- Retry transient có thể dùng thêm một provider call trong trần hai lượt. Định dạng V2 từ đợt trước nâng trần output 1.024 lên 2.048 token; vẫn cần đo usage thật.

Tách chỉ số `engine=gemini` thành công khỏi FAQ/fallback hữu ích. Không dùng HTTP 200 hoặc tỷ lệ fallback để che lỗi provider.

## 6. Kiểm thử cuối

Lệnh bộ liên quan gồm reliability, UI, connection, latency, answer format, result context, site chatbot, Gemini helper, i18n và local-server route: **184/184 đạt**.

Regression toàn repo `node --test --test-concurrency=2 test/*.test.mjs`: **864 test, 860 đạt, 3 lỗi baseline, 1 skip**. Ba lỗi vẫn ở `test/blog-page.test.mjs`: hai kỳ vọng số bài/layout cũ 9 bài trong khi có 16 và sitemap kỳ vọng route động thay vì snapshot. Không sửa blog ngoài phạm vi.

Có kiểm thử: 20 request trùng đồng thời chỉ một lượt provider; khác payload bị 409; timeout đã gọi provider không nhả claim; claim/chốt owner và lease; REST chốt đã áp dụng rồi mất phản hồi; mảng rỗng qua Lua; auth/context trước replay; cách ly tài khoản; Redis lỗi; deadline; token/log redaction; quota/429/503/408; lỗi quyền/cấu hình không retry; primary cooldown; JSON provider và HTTP hỏng; retry giữ ID/snapshot; đổi tài khoản khi response đến muộn.

Lua chạy script thật trong harness Redis của test, không phải kiểm thử tích hợp Upstash production. Provider và phần lớn lỗi mạng được mock. Browser localhost đã kiểm tra FAQ bốn bước và lỗi thiếu Redis được phân loại, không âm thầm gọi AI không có claim. `git diff --check`, syntax và freshness `home-widgets.css` đạt.

## 7. Cổng nghiệm thu deployment còn lại

1. Triển khai preview với Redis/pool chatbot thực, xác nhận Lua `KEEPTTL`, claim/chốt/replay và hai tài khoản thực; không dùng token pipeline phân tích để thử chatbot.
2. Kiểm tra retry cùng ID, context hết hạn, timeout, JSON lỗi và các nhánh health trên preview có log request ID đầy đủ. Không cố tình gọi hàng loạt provider để tạo quota lỗi.
3. Thu mẫu baseline/canary cùng vùng/model, đo từng stage, p95, provider success, fallback hữu ích, token và Redis usage. Chọn lại timeout từ số đo; không coi 3,2 giây hay 12 giây là ngưỡng đã được chứng minh.
4. Giữ cổng chất lượng trả lời có cấu trúc của tài liệu đợt trước. Có thể thử `CHATBOT_STRUCTURED_ANSWERS=off` trước, bật V2 sau khi đạt; flag này không tắt lớp reliability. Rollback toàn bộ reliability cần revert code/redeploy, không có nút runtime mới.
5. So sánh production trước/sau khi được phép deploy, chưa tuyên bố nguyên nhân cũ hoặc hiệu quả thực tế chỉ từ unit test.

Tham chiếu chính thức: [Gemini troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting), [Gemini rate limits theo project](https://ai.google.dev/gemini-api/docs/rate-limits), [Vercel Functions API và waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package).
