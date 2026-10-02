# Kiểm thử chatbot trên Vercel Preview, 03/10/2026

## Deployment được kiểm tra

- URL: https://realview-amtiq0wmu-tnt-s-projects1.vercel.app
- ID: `dpl_B1ELW2eb7dxDZe6qtNzCootCbyB9`.
- `vercel inspect` xác nhận `target: preview`, `Ready`; không deploy/promote production.
- Commit nền main `a06b596`; áp dụng đúng các file chatbot chưa commit từ folder backup. Hash API/client/site-chatbot khớp bản đã nghiệm thu local trước đó. Clone tạm cũ không còn, đã khôi phục clone mới từ main.
- Không commit/push Git. Không sửa HTML/ảnh bài cũ, `public/blog.html` hoặc `vercel.json`; diff các đường dẫn này bằng 0. Không chạy Actor/phân tích review.
- Bật `CHATBOT_STRUCTURED_ANSWERS=on` chỉ cho deployment này, không đổi biến project production.

## Kết quả API thực

Chạy `tools/chatbot-preview-probe.mjs` qua `vercel curl`, dùng xác thực Vercel hiện có, không tắt Deployment Protection. Chín kiểm tra assert đạt, không có assert thất bại. Thêm một request quan sát câu hỏi mở, tổng 10 POST. Câu hỏi và context đều là dữ liệu kiểm thử công khai/giả; không lấy báo cáo người dùng.

| Kiểm tra | Kết quả |
| --- | --- |
| FAQ “RealView hoạt động thế nào?” | 200, `answered`, `knowledge-base`, document `2.0`; idempotency protected/stored |
| Gửi lại nguyên cùng ID/messages/context | 200 replay; cùng đáp án/generation, request ID mới |
| Cùng ID nhưng đổi câu hỏi | 409 `CHAT_REQUEST_ID_CONFLICT`, không retryable |
| Hai POST đồng thời cùng ID | Một owner, một replay; đều 200. Kiểm tra lại vẫn replay |
| Request `messages: []` | 400 `INVALID_CHAT_BODY` |
| Hỏi history khi chưa đăng nhập | 401 `AUTH_REQUIRED`, không fallback sang website |
| Result capability giả | 403 `RESULT_CONTEXT_FORBIDDEN`, không fallback sang website |

Headers của response FAQ: `Cache-Control: private, no-store`, request ID có trong header/body. Cơ chế Lua hoạt động trên Redis thực của preview, không chỉ harness local.

## Log và thời gian

Đối soát runtime log đúng deployment bằng `vercel logs --environment preview`. Các event `chat_request_completed` có stage timings, source, status/code và số provider attempts. Không có câu hỏi/review thô hoặc secret trong các event kiểm tra.

- FAQ đầu: server `totalMs=83`; HTTP curl 764 ms.
- Replay FAQ: server 7 ms; HTTP curl 505 ms.
- Owner của hai request đồng thời: server 26 ms; HTTP curl 294 ms. Request còn lại là replay: server 5 ms; HTTP curl 267 ms.
- Câu hỏi mở: server 58 ms, HTTP curl 310 ms, `providerAttempts=0`.

Thời gian curl chỉ là thời gian HTTP quan sát tại máy kiểm thử, không phải tổng thời gian lệnh CLI (còn xác thực/tra cứu deployment). Mẫu rất nhỏ, không đủ kết luận p75/p95 hoặc cải thiện so với production. Đây không phải số đo độ trễ Gemini.

## Cập nhật kiểm tra trong Chrome riêng

Người dùng đã chấp thuận thử có giới hạn bằng cấu hình chatbot hiện có và yêu cầu dùng Chrome thay vì trình duyệt tích hợp. Chrome dùng phiên Vercel đã đăng nhập, mở được preview mà không tắt Deployment Protection. FAQ thực hiển thị summary, mục “Cách thực hiện”, bốn bước, lưu ý TrustScore và CTA; nhãn nguồn là “Kho dữ liệu RealView”. Câu hỏi mở trả thông báo gián đoạn và nhãn “AI chưa khả dụng”, không giả nhận là câu trả lời AI. Input mở lại sau response. Đã lưu screenshot trong thư mục kiểm thử ngoài repo.

Tạo thêm preview riêng `https://realview-jwm79osy3-tnt-s-projects1.vercel.app`, ID `dpl_C6uY9bTSwX9u16atpxWk8WHM2ADT`, bằng CLI `--target preview`, Ready. Dùng đúng một key từ file pool chatbot local đã có qua biến môi trường của process và `--env CHATBOT_GEMINI_API_KEY` chỉ ở deployment; không đưa giá trị vào argv, file repo hoặc output. Không đổi môi trường project production, không mượn key phân tích. Chín assert API chạy lại đều đạt. Câu hỏi mở của probe vẫn có `providerAttempted=false`; log 0 attempts, tokenUsage=null, server 37 ms, HTTP 312 ms. Một câu hỏi mở khác gửi từ Chrome cũng chưa có đáp án AI. Không thử thêm key hoặc tiêu quota hàng loạt.

Viewport override của Chrome không phản ánh thay đổi trong kích thước DOM quan sát (vẫn 1680px), đã reset. Chỉ xác nhận desktop; chưa đánh dấu mobile đạt.

## Gemini thật: chưa nghiệm thu

`vercel env ls preview` không có `CHATBOT_GEMINI_API_KEY`, `CHATBOT_GEMINI_API_KEY_VAULT_KEY` hay `GEMINI_API_KEY_VAULT_KEY`; `env ls production` có các biến này. Hai biến chatbot production là Secret write-only: Vercel UI không cho reveal/copy. Đã hủy panel edit, không thay biến production. Đọc đúng cấu hình chatbot local theo chấp thuận để thử key riêng trên deployment thứ hai; không tìm thấy vault key trong hai folder config local được kiểm tra. Preview chưa có đầy đủ cấu hình giải mã pool dự phòng. Chưa đủ bằng chứng xác định tại sao route primary không mở provider trên preview thứ hai (có thể bị bỏ qua trước provider rồi đi vào pool thiếu vault); không coi giả thuyết đó là kết luận log.

Câu hỏi mở trả HTTP 200 nhưng `status=temporarily_unavailable`, `engine=rules`, `code=AI_CONNECTION_FAILED`. Log xác nhận **0 provider attempt**, không có token usage. Không được coi đây là Gemini timeout, lỗi mạng Gemini hay Gemini trả lời thành công.

Điểm còn thiếu phát hiện qua preview: lỗi đọc/giải mã pool do cấu hình chưa đầy đủ vẫn có thể rơi vào mã chung `AI_CONNECTION_FAILED` thay vì mã cấu hình riêng. Cần phân loại lỗi vault rõ hơn trong một đợt sửa; chưa sửa chức năng này trong lượt chỉ kiểm tra. Khi cấu hình được cấp, cần vài câu Gemini thật và replay để đo provider count/tokens/thời gian.

## Giao diện và các cổng chưa chạy

Trình duyệt tích hợp không có phiên đăng nhập nên bị chuyển sang Vercel sign-in; chuyển sang Chrome riêng theo yêu cầu và dùng phiên đăng nhập sẵn. Không bypass bảo vệ, không thay cấu hình security.

Chưa nghiệm thu end-to-end: Gemini thật, mobile, báo cáo thực, hai tài khoản, context hết hạn thực và lỗi provider 429/503/timeout thật. Desktop FAQ/fallback đã kiểm chứng. Các lỗi provider có unit/mock test nhưng không được đánh dấu đã thử thật trên deployment.

Bộ test local liên quan chạy lại sau khôi phục workspace: **184/184 đạt**, `git diff --check` đạt. Không dùng kết quả này thay cho cổng Gemini/UI thật.

## Tiếp tục

1. Cấp cấu hình vault chatbot từ nguồn gốc an toàn cho đúng preview thử nghiệm. Không yêu cầu gửi secret trong chat, không đổi phạm vi các Secret production write-only khi chưa được chấp thuận riêng.
2. Khi cấu hình đầy đủ, kiểm tra lý do route primary bị bỏ qua và chạy Gemini/replay, đối soát logs/tokens. Không gây quota exhaustion hay flood provider để mô phỏng lỗi.
3. Thử report thật có quyền nếu được cung cấp tài khoản/context; bổ sung kiểm thử mobile bằng công cụ có viewport hiệu lực.

File probe chỉ phục vụ kiểm thử, không ghi nội dung blog, không gọi `/api/analyze` hoặc Actor. Các record request/generation kiểm thử dùng namespace hiện có và TTL, không quét/xóa dữ liệu Redis chung.
