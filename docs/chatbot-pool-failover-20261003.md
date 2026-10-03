# Chatbot: điều phối pool và thử lại có giới hạn

## Phạm vi

Thay đổi local trên main, dựa trên commit `a7f62ca`. Chưa commit, push, deploy hoặc thay biến môi trường từ xa. Không đổi blog, sitemap, model, prompt, định dạng câu trả lời hay pool phân tích review Layer 2.

Chủ website xác nhận từng key chatbot thuộc một Google project độc lập. Chính sách chuyển nguồn khi quota chỉ áp dụng cho chatbot theo xác nhận này; không tự tạo project/key, không tự mở khóa credential bị từ chối quyền.

## Luồng mới

1. Đọc pool chatbot một lần, gộp key riêng vào cùng danh sách. Dedup theo giá trị key, hợp nhất trạng thái exhausted của bản trùng; không coi bản sao là nguồn dự phòng mới.
2. Đọc health trong namespace chatbot. Loại permission-disabled, quota, cooldown hoặc busy. Đặt chỗ nguyên tử trước khi gọi provider; route bị từ chối đặt chỗ không tiêu provider attempt.
3. Tối đa hai lời gọi Google trong một HTTP request. Có nhiều nguồn khả dụng: lần đầu tối đa 4.000 ms. Chỉ một nguồn: tối đa 9.000 ms. Lần dự phòng: tối đa 5.500 ms, luôn rút ngắn theo deadline còn lại.
4. Ngân sách AI vẫn 10.000 ms; handler vẫn 12.000 ms; browser vẫn 15.000 ms. Chừa tối đa 500 ms trong AI cho kiểm tra response và 700 ms cuối handler cho hoàn tất. Chỉ mở lượt dự phòng khi đủ ít nhất 3.000 ms cho provider, ngoài backoff và phần chừa. Tính lại trước/sau đặt chỗ.
5. Timeout, lỗi mạng, 408, 5xx hoặc response sai schema có thể chuyển nguồn. Quota có thể chuyển sang project khác đã được xác nhận độc lập. 400/401/402/403/404 vẫn dừng; permission quarantine vẫn bền vững và chỉ được khôi phục qua thao tác admin có xác nhận.
6. Phần tải body nằm trong timeout của từng attempt, không chỉ thời gian nhận header. Một body treo không được chiếm cả ngân sách rồi ngăn failover.
7. 429 theo phút giữ cooldown ít nhất 60 giây và tôn trọng Retry-After của nguồn lỗi. Quota ngày giữ key tới mốc reset Pacific hiện có, bao gồm cả key riêng không có bản ghi trong vault. Không đổi cách reset/bộ đếm của Layer 2.

Các giá trị 4/9/5,5 giây là cấu hình ban đầu, không phải độ trễ đã đo của Google. Tối đa hai calls là giới hạn cho mỗi HTTP request mới, không phải cho toàn bộ hội thoại. Timeout không chứng minh provider chưa làm việc hoặc chưa tiêu quota.

## Retry phía browser

- Mất mạng, response lỗi định dạng hoặc trạng thái lưu chưa rõ: giữ nguyên request ID, session và messages để đối soát/replay. Không xóa lease hoặc tự tạo lượt AI mới.
- Backend trả lỗi tạm thời hoàn tất và xác nhận đã lưu: nút “Thử trả lời lại” chỉ tạo request ID mới khi người dùng chủ động thử, kèm `retryOfClientRequestId` để đối soát. Không tự retry bằng ID mới.
- Một failure replay đã xác nhận lưu cũng cho phép lần thử mới có chủ đích; mỗi turn vẫn chỉ có tối đa hai thao tác retry và chịu rate limit API.
- Giữ thời gian chờ trên nút và khi gõ lại câu hỏi; không đưa thông báo lỗi vô ích vào lịch sử AI. Câu trả lời hoàn chỉnh thay thế partial fallback trong lịch sử tiếp theo.

## Cách ly và rollback

Helper dùng chung chỉ nhận callback ngân sách động khi chatbot opt-in. Caller Layer 2 không truyền callback, vẫn dùng timeout 25 giây và quy tắc retry cũ. Health/quota Lua bổ sung chỉ được bật qua wrapper chatbot; các key Redis phân tích review không bị ghi.

- `CHATBOT_ADAPTIVE_ROUTING_ENABLED=false`: khôi phục nhánh chọn nguồn/timeout cũ, không gỡ permission quarantine.
- `CHATBOT_POOL_INDEPENDENT_PROJECTS=false`: tắt chuyển nguồn khi quota, vẫn giữ adaptive timeout và failover lỗi tạm thời.
- Cả hai mặc định bật trong deployment này theo quyết định của chủ website. Nếu nhập thêm key cùng project, phải tắt cờ independent-projects trước hoặc xây mapping project đã xác minh. Không suy ra project ID từ fingerprint.
- Cờ môi trường backend cần deployment mới để có hiệu lực; chúng chưa được thay đổi trên Vercel. Các cờ này không rollback thay đổi retry frontend; cần revert patch frontend nếu muốn quay lại hành vi đó.

## Đối soát

Log structured có số route khả dụng/loại, kết quả đặt chỗ, ngân sách mỗi attempt, thời gian nhận header/body, fingerprint một chiều, lỗi và ranh giới timeout. Không log key, prompt, nội dung chat hoặc raw provider error. Token chưa nhận được vẫn không được coi là 0; tổng token đã biết không chứng minh chi phí của lời gọi timeout bằng 0.

## Kiểm thử

Test dùng Redis Lua thực qua Fengari, mock provider và JSDOM; không dùng key thật hay tiêu quota Google.

- Primary quarantine + nhiều key khỏe: hai key pool được thử, primary không được gọi.
- Hai nguồn lỗi: không mở nguồn thứ ba; thiếu thời gian: không mở nguồn thứ hai.
- Nguồn duy nhất trả sau 8 giây: thành công; headers trả nhưng body treo: timeout khoảng 4 giây rồi failover.
- Daily/minute quota, exhausted key trùng với dedicated key, cờ rollback và opt-out quota.
- BUSY lúc đặt chỗ, pool đọc lỗi nhưng primary độc lập còn khỏe, permission denial và lưu quarantine lỗi.
- Layer 2 giữ timeout/cách chọn nguồn cũ; namespace/bộ đếm của pipeline không thay đổi.
- Replay, 20 request trùng đồng thời, retry mạng, retry lỗi hoàn tất, chờ retry và lịch sử câu trả lời.

Bộ test toàn repo trước đợt này đã có ba lỗi `blog-page.test.mjs`: blog hub count, blog library layout và sitemap/robots. Không sửa chúng trong phạm vi chatbot.

Kết quả sau patch: bộ test chatbot/Gemini liên quan đạt 205/205. Bộ toàn repo chạy 893 test: 889 pass, 3 lỗi blog cũ, 1 skip, 0 cancelled. `git diff --check` và kiểm tra cú pháp các module chính đạt. Test tích hợp API xác nhận hai lời gọi pool khi failover và zero provider calls khi replay. Không có thay đổi source/blog hoặc dữ liệu bài viết trong diff.

## Còn phải kiểm chứng trước production

Chưa chạy Gemini thật trên preview hoặc production cho patch này. Cần deployment preview riêng và tối đa năm câu thật để đo metadata routing, attempts, timeout và kết quả; không dùng HTTP 200 đơn thuần làm tiêu chí AI thành công. Mẫu nhỏ không chứng minh tỷ lệ ổn định dài hạn. Không bảo đảm exactly-once tuyệt đối tại Google khi network timeout.
