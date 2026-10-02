# Blog Cloudflare preview: kiểm kê và import thử

## Trạng thái ngày 02/10/2026

Không cutover production, không đổi DNS, không push main. Không đọc/ghi Blob và không ghi Redis. Nội dung HTML, ảnh và format bài hiện tại không bị chỉnh sửa.

Kiểm kê đọc các index Redis hiện có: 18 bài, 54 con trỏ revision, 6 grant, 135 record. Cả 54 revision đều trỏ tới Blob bị khóa; không có document inline. Không thể gọi bản này là backup đầy đủ lịch sử revision. Kiểm tra lại index/meta không thấy thay đổi trong lúc đọc, nhưng đây không phải snapshot giao dịch hay export cutover đã khóa ghi.

Local: 460 file, 35.999.890 byte; 19 HTML snapshot có canonical bài viết. Backup bao gồm byte của file local và record Redis, được mã hóa AES-256-GCM, khóa phiên bọc bằng RSA-OAEP-SHA256. RSA 4096 bit tạo local, private key không đưa lên Git/Cloudflare. Đã kiểm tra giải mã và hash 460 object + 135 record.

D1 mới `realview-blog-preview`, ID `e71ba88a-6bd6-4b7d-975f-b9df1650cdcd`. Staging chỉ lưu manifest file, record gốc và reserved slug; chưa lưu byte ảnh trong D1, chưa kích hoạt grant, draft, published pointer hay API Studio. Import 614 câu lệnh, Cloudflare báo 1.228 rows written, dung lượng DB 466.944 byte. INSERT OR IGNORE cho phép chạy lại cùng bản; verifier phải đối chiếu hash và từ chối nghiệm thu nếu bản khác xung đột key.

Worker preview chỉ công khai `/health`; mọi route khác trả 404. Không sửa Worker Minecraft hoặc Worker review cache. R2 ban đầu trả code 10042; sau khi người dùng xác nhận điều khoản và overage, đã kích hoạt và kiểm chứng qua API: `wrangler r2 bucket list --config cloudflare/blog-preview/wrangler.jsonc` trả exit 0, danh sách trống, không còn 10042. Nguồn xác nhận là API thực tế, không phải nhận định của một trợ lý. Bucket private preview đã tạo trong lượt 02–03/10 như báo cáo bên dưới.

## Điều kiện trước khi triển khai publish/gỡ đăng

Generation lấy từ published pointer D1 bằng truy vấn theo slug có index khi cache miss; kiểm lại pointer sau khi lấy body, trước khi trả response. Tối đa hai truy vấn point-read/lượt bình thường; nếu generation đổi, thử lại một lần, sau đó trả 503 no-store. Đây không phải cam kết chỉ hai billed rows: index/JOIN và số liệu D1 thực tế cần đo. CDN hit không gọi D1. Không loại bỏ được race sau lần kiểm cuối.

Gỡ đăng: commit pointer/tombstone trong D1 trước, purge sau, kiểm chứng cuối. Dự kiến tối đa ba lượt purge tại 0, 3, 10 giây, có backoff theo Retry-After nếu 429; vượt budget giữ trạng thái pending, không báo thành công. Tombstone giữ ownership slug, không fallback snapshot. Chỉ triển khai sau khi xác minh quota CDN purge; giới hạn Remote Cache purge trong tài liệu Vercel là build cache, không được dùng làm quota CDN.

Canary: phân biệt baseline production, test preview và canary thực. Ngưỡng ban đầu đề xuất 500 request thực, 50 origin miss quan sát được và hai địa điểm trong tối đa 7 ngày. Nếu thiếu mẫu, báo thiếu mẫu; dùng test giả lập có giới hạn cùng mở rộng 25/50/100% có kiểm soát, không coi synthetic là traffic thực. Các mốc này chưa được đo/đạt. Load test cùng vùng và phương pháp với baseline; tải mục tiêu ít nhất 20 request/s hoặc ba lần peak đo được, cần chốt budget trước khi chạy. Không load-test production trong bước này.

Replay chỉ ghi cho request quản trị ký HMAC, không cho public page view. Trước bật cron, đo tốc độ sinh replay/idempotency và bảo đảm công suất dọn ít nhất gấp hai tốc độ sinh; tính cả index writes. Cờ D1 có thẩm quyền khóa ghi, Vercel chỉ chặn sớm. Chờ job/lease và đối soát kết quả trước export, không coi lease hết hạn là thao tác thất bại.

## Backup và việc còn thiếu

Backup local mã hóa là bản ngoài Cloudflare đầu tiên, không phải lịch backup tự động. Cần sao chép private key sang nơi độc lập, không cùng nơi backup và không đưa lên Git/Cloudflare. Trước cutover phải test giải mã bằng bản sao khóa; mất khóa sẽ mất khả năng phục hồi. Chưa bật lịch hay gửi cảnh báo: cần chốt nơi chạy export và kênh nhận cảnh báo.

Đính chính sau rà soát: backup hiện ngoài hạ tầng Cloudflare nhưng vẫn chỉ có một máy, chưa đạt yêu cầu bản dự phòng độc lập thiết bị. Private key ban đầu nằm trong workspace Documents có liên kết iCloud và hiện untracked trong Git; không đủ bằng chứng kết luận nó chưa từng đồng bộ. Đã chuyển bản khóa tới `/Users/macbook/.local/share/realview-backup-keys/20261002/private.pem`, chmod 0600, thư mục 0700, thử giải mã bằng bản sao và xóa đúng private key cũ trong workspace. Public key vẫn giữ được trong workspace. Đã thêm ignore ở workspace gốc và checkout. Thao tác xóa local không bảo đảm xóa bản iCloud/version history. Nếu xác nhận khóa từng đồng bộ tới nơi không chấp nhận được, cần tạo khóa mới và mã hóa lại backup; không thể thu hồi bản backup/khóa đã bị sao chép. Không có bảo đảm zeroization trên SSD.

## Phạm vi khi không khôi phục revision cũ

Chỉ chuyển backend cho bài và revision tạo mới. Không áp dụng tiêu chí giữ nguyên ID/số revision/100% nội dung revision cho 54 con trỏ Blob cũ. Không dựng revision từ HTML, không tuyên bố Blob cũ đã di chuyển.

54 con trỏ vẫn giữ nguyên trong `blog_import_records`. Migration 0004 đã phân loại riêng cả 54 trong `blog_legacy_state` thành `legacy_unrecoverable` (nghĩa là không khôi phục trong đợt này vì nguồn đang bị khóa, không phải chứng minh mất vĩnh viễn). API Studio mới phải loại chúng khỏi revision mới. Record gốc/hash không đổi, đã verifier lại remote. Nếu nguồn mở lại, khôi phục là quy trình riêng có kiểm chứng.

18 record CMS gồm 17 slug có snapshot và một bài `t` archived không có snapshot. Có thêm hai snapshot không nằm trong index: `check-review-truoc-khi-mua-hang` và `tieu-chi-danh-gia-cong-cu-check-review`. Cả hai được whitelist trong `src/blog-post-route.mjs` và có manifest snapshot, không phải canonical trùng. Tổng cộng 19 canonical snapshot riêng biệt. Các bài công khai cũ tiếp tục bằng HTML/snapshot, không được sửa trong Studio mới. Muốn sửa phải import HTML riêng, giữ nguồn/ownership và kiểm chứng content/format. Slug `t` cần dự trữ theo policy archived khi hoàn thiện registry: staging hiện chỉ có 19 slug snapshot, chưa đủ registry toàn CMS/alias.

Đợt đầu bỏ nhánh đưa revision lớn sang R2 và quét orphan của revision cũ. Đặt giới hạn kích thước payload bài mới có kiểm tra byte; đo và chốt ngưỡng trước khi viết API. Revision mới trong D1 phải có transaction, optimistic concurrency và idempotency; snapshot cũ không trở thành fallback khi slug Studio có tombstone.

Verifier đã chạy lại trên remote D1: `blog_import_files` 460, `blog_import_records` 135, `blog_slugs` 19, `blog_migration_settings` 1; bảng hệ thống `d1_migrations` 1. 460/460 object byte local trong backup khớp hash; 460/460 manifest D1 khớp; 135/135 raw record D1 khớp SHA256 backup. Con số này không chứng minh nội dung 54 Blob revision đã backup, và không phải kiểm chứng byte ảnh trên R2.

6 grant đã ánh xạ account ID bằng tra cứu tài khoản thật, chưa kích hoạt. Công cụ kiểm grant nguồn chưa đổi, email index trả UUID, bản ghi user khớp ID/email, username index trỏ ngược cùng ID; từ chối trùng ID hoặc tài khoản có dấu hiệu disabled/deleted trong record. Kết quả thực tế: 6 mapped, 0 unresolved, 24 Redis GET, 0 Redis write. Mapping chỉ lưu mã hóa local, không chứa password hash/raw account/email. Trước bật quyền phải kiểm tra lại mapping/quyền vì đây là kết quả tại một thời điểm; không fallback tên/email do client cung cấp. Worker phải kiểm grant D1 mỗi thao tác và lúc commit.

## Rủi ro staging và dữ liệu nhạy cảm

135 raw record ở D1 có dữ liệu grant/audit/meta và được lưu plaintext ở tầng ứng dụng, khác với backup local mã hóa. Worker preview chỉ có healthcheck, nhưng người có quyền quản trị D1/Cloudflare vẫn đọc được. Không tự xóa trong lượt rà soát này. Khuyến nghị đợt sau chỉ giữ hash + metadata cần đối chiếu, 54 pointer tối thiểu và số liệu grant; dữ liệu chi tiết còn trong backup mã hóa. Muốn scrub/drop raw record cần thao tác được duyệt riêng và verifier tương thích redacted schema. D1 Time Travel Paid giữ lịch sử đến 30 ngày, DELETE không phải bảo đảm xóa tức thời khỏi lịch sử: https://developers.cloudflare.com/d1/reference/time-travel/.

Đã kiểm tra `.zsh_history`: không có dòng SQL import, block private key hay tên file SQL tạm. Không còn `preview-import.sql` trong checkout/temp repo và thư mục backup đã biết; các file SQL còn lại là schema migration. Đây là kiểm tra có phạm vi, không chứng minh mọi cache hệ điều hành/log của nhà cung cấp đều sạch.

Trước cutover: export lại ở chế độ khóa ghi vì bản 02/10 là ảnh chụp một lần; test khôi phục dữ liệu mới trên môi trường riêng; lưu backup và bản sao khóa trên thiết bị/nơi độc lập. R2 đã kích hoạt, cảnh báo usage đã tạo như ghi bên dưới. Có thể phát triển/test bằng fixture local, nhưng chưa tạo dữ liệu Studio thật khi backup độc lập chưa đạt. Quota CDN purge Hobby và kênh nhận cảnh báo cron vẫn chưa chốt.

Nội dung 54 revision bị khóa vẫn chưa khôi phục. Chưa triển khai auth/replay/grant vào Worker, save/publish, purge, backup định kỳ, sitemap hợp nhất hay cutover. Phases 1–3 hiện chỉ hoàn tất kiểm kê/backup local và import staging D1; chưa import media lên R2.

## Chốt trước tạo bucket và điều kiện preview

Đã tạo `realview-blog-media-preview` qua Wrangler: Standard storage, **không jurisdiction**, location hint **`apac`**. API xác nhận r2.dev disabled và không có custom domain. APAC là best effort, không bảo đảm vị trí vật lý. Jurisdiction không thể đổi sau tạo; hint chỉ được áp dụng lần đầu một tên bucket được tạo, xóa rồi tạo lại cùng tên không đổi vị trí. Nguồn: https://developers.cloudflare.com/r2/reference/data-location/. Rule abort multipart dở sau 1 ngày đã bật; rule mặc định 7 ngày vẫn giữ nguyên, không có rule expire object hoàn chỉnh. Chưa upload media. Binding BLOG_MEDIA chỉ đã thêm vào config local; chưa deploy lại Worker.

Budget Alert `RealView account usage alert USD 1` đã lưu trên dashboard Cloudflare và danh sách Notifications hiển thị Enabled, phương thức Email tới địa chỉ billing hiện có. Alert ID `46df08d543d545b1b75c541538055e45`. Đây là ngưỡng **tổng chi tiêu usage-based của tài khoản**, không phải hard cap hay cảnh báo phần trăm allowance R2/D1. Có thể gửi trễ, không chặn chi tiêu: https://developers.cloudflare.com/billing/manage/budget-alerts/. Không thay đổi default alert auto-created. Trình duyệt bị người dùng chuyển sang thao tác khác trước khi lưu screenshot kết quả, nên chưa có screenshot chứng minh cấu hình đã lưu.

Baseline dashboard R2 lúc kiểm tra: Class A 0, Class B 0, storage 0 B, billable usage $0; kỳ hiển thị 25/09–25/10. Số dashboard có độ trễ và số 0 không chứng minh API list không tính operation. Trước/sau mỗi đợt test phải ghi UTC, cửa sổ analytics, bucket/Worker/D1 ID, Class A/B, byte storage, rows read/write, Worker request/CPU; tách preview khỏi usage account/Minecraft/review. Đối chiếu cả D1 response `meta.rows_read/rows_written` của từng truy vấn và analytics sau khi cập nhật; không suy số billed rows từ số câu SQL. Chưa có đợt test upload hay cache miss mới để đo chênh lệch.

### HMAC dùng chung, chưa mở endpoint

Đã thêm `cloudflare/blog-preview/request-auth.mjs` dùng WebCrypto và test local. Envelope gồm version, environment, method, canonical path/query, timestamp, request ID, actor ID, idempotency key, content type và SHA256 byte body. Chuẩn hóa bằng cùng module hai phía: UTF-8/RFC3986, uppercase percent-encoding, sort tên query, `+` tương đương `%20`; từ chối query trùng tên, encoding lỗi, dot segment, encoded slash/backslash, double slash và trailing slash không phải root. Router sau này bắt buộc dispatch từ cùng canonical target, không parse theo quy tắc khác. Giới hạn URL 2.048 ký tự, chỉ HTTPS. Host không nằm trong envelope: bridge phải dùng một Worker URL cấu hình cố định và secret riêng từng service/môi trường, không nhận đích từ client hoặc follow redirect.

Xác minh chữ ký bằng `crypto.subtle.verify`, tính lại body hash từ byte nhận được; không dùng `===` để so chữ ký. Cửa sổ ban đầu 300 giây quá khứ/30 giây tương lai, cần đồng hồ đồng bộ; đây không phải chống replay. Unit test đối chiếu chữ ký với Node HMAC độc lập, từ chối sửa body/actor/method/query/content type/môi trường và request quá hạn. Test local đạt; chưa kiểm chứng runtime Worker hay route production.

Đã có schema grant/replay/idempotency trong D1 preview và module `access-guard.mjs`; **chưa tích hợp vào route HTTP hay tạo endpoint ghi**. Replay reservation kiểm grant, role, thời điểm bắt đầu/hết hạn và cờ read-only ngay trong cùng INSERT với UNIQUE `(environment, requestId)`. Retry thao tác giữ idempotency key nhưng ký envelope mới với request ID mới. Bảng idempotency đã tạo nhưng chưa có logic reserve/finalize/recovery; save sau này phải lưu actor+operation+payload hash và trả 409 khi reuse với payload khác. Actor ID do Vercel lấy từ session tài khoản thật, không do client tự khai. Mọi commit nội dung/media/publish phải dùng predicate quyền nguyên tử riêng, không coi replay reservation là quyền commit. Unit test thu hồi grant hoặc bật read-only giữa xử lý và commit đạt 0 row nội dung ghi. Chưa kích hoạt 6 grant legacy.

## Kết quả lượt tiếp tục 02–03/10/2026

Theo yêu cầu người dùng và xác nhận rõ về rủi ro iCloud, đã sao chép vào Documents/secret:

- Backup mã hóa: `/Users/macbook/Documents/secret/realview-blog-backup-20261002/blog-backup.encrypted.json`.
- Mapping grant mã hóa: `/Users/macbook/Documents/secret/realview-blog-backup-20261002/grant-mapping-20261003.encrypted.json`.
- Bản sao khóa: `/Users/macbook/Documents/secret/realview-blog-keys-20261002/private.pem` và `public.pem`.

Thư mục con mode 0700, file 0600; không in key, không đưa lên Git/Cloudflare, không xóa bản khóa local ngoài Documents. Hai thư mục riêng dưới cùng secret **không** đạt độc lập thiết bị/nơi lưu. Người dùng đã chấp nhận khả năng private key đồng bộ iCloud; không diễn giải thành backup tách failure domain. Một lần verifier gặp read rỗng; filesystem báo backup `dataless`. Sau khi đọc đủ 64.539.322 byte, JSON và giải mã lại đạt. Không kết luận backup hỏng; vẫn cần giữ bản tải sẵn/offline và kiểm tra trước khi phục hồi.

Verifier sau migration, dùng chính khóa bản sao trong secret: 460/460 byte object backup, 460/460 manifest D1, 135/135 raw record/hash D1 khớp. DB có 4 migration, 54 legacy pointer, 20 slug (19 snapshot + `t` legacy_reserved), không đổi ownership snapshot. Đã dự trữ slug/publishedSlug/managedSlugs từ metadata; alias ngoài tập nguồn này vẫn cần inventory riêng trước cutover. Phần mô tả 19 slug/migration 1 bên trên là kết quả trước migration 0004, không phải trạng thái hiện tại.

D1 xác minh grant=0, replay=0, idempotency=0, `studio_read_only=true`. Đây là schema rỗng, không tự cấp quyền cho 6 mapping. DB sau migration 524.288 byte. Các truy vấn đối soát count đã quan sát rows_read 4, 670 và 40; đây là 714 billed rows read riêng các truy vấn đó, **không phải tổng usage của đợt** (không bao gồm verifier, migration hay account services khác). CLI migration không trả tổng rows write của cả đợt trong output đã thu được; không tự ước lượng thành số thực tế. R2 có các management call tạo bucket/rule/kiểm access; chưa có upload/HEAD/GET object, chưa có analytics delta mới để chốt billed Class A/B.

18/18 test local đạt: HMAC vectors/negative cases; replay độc nhất; editor không vào admin operation; grant inactive/scheduled/expired; revocation/read-only tại commit; mapping tài khoản; legacy registry/hash; backup encryption. Test concurrent dùng SQLite adapter local, không phải tải đồng thời remote D1. Smoke test local 5 đường ghi draft/media/publish/access/admin đều 404; Worker deployed vẫn health-only. Không gọi Blob, không ghi Redis, không thêm secret vào Worker/Vercel, chưa deploy/cutover/push main.

Bước tiếp theo còn phải thực hiện: nối auth guard vào dispatcher preview; idempotency và optimistic concurrency cho save; kiểm grant lại tại commit; upload R2 pending/ready và HEAD đối soát; Vercel preview bridge với secret riêng/Deployment Protection; kiểm negative cases và usage thật. Production hiện tại chưa bị thay đổi bởi các thao tác này. Backup độc lập thiết bị, baseline byte toàn production và canary vẫn là điều kiện trước cutover, chưa đạt chỉ từ việc lưu secret.

### Kích thước upload và bằng chứng âm

Luồng hiện tại `public/admin-blog.js` gửi base64 trong JSON, giới hạn file 3 MiB = 3.145.728 byte. Đo JSON mẫu đúng các trường action/fileName/contentType/data/alt: base64 4.194.304 byte, toàn body 4.194.422 byte, còn 305.578 byte so với mốc thận trọng 4.500.000. Đây là phép đo serialization với metadata mẫu, không phải upload ảnh thành công lên Vercel hay chứng minh mọi input hợp lệ đều đạt. Header không thuộc JSON body. Vercel giới hạn body 4,5 MB trên Functions: https://vercel.com/docs/functions/limitations/. Không kết luận ảnh sát 3 MiB chắc chắn vượt giới hạn.

Preview sẽ giữ cap ảnh 3 MiB; giới hạn filename 200 ký tự/alt 300 ký tự **trước serialization**, kiểm `TextEncoder(JSON.stringify(payload)).byteLength <= 4.300.000` ở client và server để chừa dư. Bộ HMAC đã từ chối body vượt 4.300.000 byte; preflight UI/server chưa tích hợp. Test sát 3 MiB, metadata Unicode, JSON escaping và đúng wire payload; nếu không đạt, chuyển route upload sang binary thay vì âm thầm giảm cap. Kiểm magic bytes, MIME decode, cap 40 triệu pixel và kích thước biến thể qua sharp trước R2. HMAC ký đúng dữ liệu gửi Worker, không hash phiên bản JSON đã parse rồi serialize khác.

Preview không có Blob token và stub Blob SDK phải ghi nhận 0 call (kể cả lỗi bị catch). Redis test ghi nhật ký mọi write command, kể cả EXPIRE/session refresh; content flow kỳ vọng 0 write, session refresh phải được tách hoặc tắt riêng trong test chứ không bỏ qua. Test riêng branch URL và deployment URL không đăng nhập phải bị Deployment Protection chặn. Các bước này chưa chạy và không được đánh dấu đạt chỉ từ unit test HMAC.

Chỉ scrub staging bằng migration đánh số sau verifier và ánh xạ grant hoàn tất; giữ hash/metadata tối thiểu và 54 pointer legacy. Time Travel Paid vẫn giữ lịch sử tối đa 30 ngày. Backup độc lập phải lưu ciphertext và private key tách nơi; có bản sao khóa thứ hai và giải mã thử bằng bản sao đó, không chỉ kiểm file tồn tại. Hiện chưa có điểm lưu ngoài máy này nên chưa đạt.

Trước/sau đợt preview: lập manifest URL production đầy đủ từ registry/sitemap và local manifest, băm byte response HTML/ảnh/sitemap, ghi status/canonical/redirect. Nếu có URL lỗi hoặc response biến động phải báo rõ, không coi subset là 100% hay normalize nội dung để giấu khác biệt. Đo D1 rows thực tế cho cache miss; test mới phải chứng minh không thay URL/nội dung/sitemap production. Chưa có baseline network toàn production và không tuyên bố so sánh đã đạt.

Người dùng xác nhận dự án học tập phi thương mại; phù hợp mục đích Hobby hiện tại. Nếu phát sinh affiliate/quảng cáo/thu phí, cần đánh giá lại điều khoản hosting.

## Triển khai preview ngày 03/10/2026

Phần trạng thái health-only/schema-only bên trên là lịch sử. Trạng thái mới:

- Migration `0005_drafts_media.sql` đã áp dụng **chỉ vào D1 preview**. Lưu nháp/revision mới, registry slug và idempotency chạy trong D1 batch nguyên tử. Assertion quyền/read-only/CAS nằm trong batch trước mọi content write. Request sau timeout tra kết quả idempotency trước, không tạo thêm revision. Edit ID không tồn tại và slug snapshot/tombstone trả 409.
- Worker preview đã deploy phiên bản `00b90af1-998a-4bd1-9c16-2adf12cd328a`, với D1 và R2 riêng. Có POST `/v1/read`, `/v1/save`, `/v1/media/upload`, `/v1/media/read`; mọi route đều HMAC + replay + grant. **Không có publish/unpublish, quản lý quyền hay route bài công khai.** GET health không đọc dữ liệu.
- R2 upload dùng rule `r2-webp-v1-q84-480-960-1600`, không đổi profile ảnh ở đợt này. Node sharp kiểm MIME/decode/pixel, tạo tối đa 3 WebP; ảnh nhỏ không bị phóng lớn và gộp các width trùng nhau. Hash gồm source SHA-256, rule và manifest biến thể. Path cố định `blog/<rule>/<hash>/<width>w.webp`; conditional PUT `If-None-Match:*`. Không lưu ảnh ở Blob.
- D1 media có owner/fence/lease 90 giây, heartbeat 10 giây, kiểm lại quyền/fence ở mỗi PUT và commit. Không reset fence trong các đường cleanup ứng dụng. Lease không xác nhận được thì dừng mở thêm PUT; PUT đang chạy có thể hoàn tất nhưng không được công bố mapping khi mất lease. HEAD cùng key khi PUT mơ hồ, khi tiếp tục lease cũ và trước commit để kiểm đủ biến thể. HEAD là operation có chi phí, không miễn phí. Chỉ state ready được đọc. Không bảo đảm exactly-once hay transaction chung D1/R2.
- Media **preview** yêu cầu session + grant, `private, no-store`, WebP/nosniff. Không bật public immutable CDN ở route draft. R2 object có metadata immutable cho bước phục vụ công khai tương lai nhưng chưa bật public URL.
- Bridge Vercel lấy actor ID từ tài khoản thật bằng 2 Redis GET (session/user), không đọc quyền CMS Redis. Lưu nội dung không gọi CMS cũ. Preview giữ giao diện Studio, ẩn publish/quản lý quyền/bỏ nháp/restore chưa triển khai; save/upload bị disable khi authoritative read-only bật. UI giữ idempotency key khi retry cùng payload.
- Runtime bridge chỉ hoạt động khi `BLOG_STORAGE_BACKEND=cloudflare-preview` và `VERCEL_ENV=preview`; fail-closed nếu có bất kỳ token Blob trong ba biến đã biết. HMAC secret preview riêng lưu ở Documents/secret, không Git, gửi bằng stdin khi cài Worker. Deployment Vercel dùng child process environment, không đưa secret vào command argv hay log.

### Vercel deployment và cách ly

Deployment mới nhất: `dpl_3P2DhKxB3Zs36xCf9gKijiQH3yfk`, READY, preview (target null), URL:
`https://realview-j5le27w14-tnt-s-projects1.vercel.app`.

Branch local chưa push nên Vercel từ chối tạo branch-specific env (`branch_not_found`); **không** chuyển sang sửa env chung hay push main. Thay vào đó đặt các biến riêng trên deployment, override ba Blob token bằng chuỗi rỗng. Guard runtime đã kiểm chứng: truy cập API qua Vercel protection nhưng không có app session trả 401 `AUTH_REQUIRED` cùng `X-Blog-Storage-Backend: cloudflare-preview`, không trả lỗi isolation. Secret không có trong file deploy. `.vercelignore` loại env, `.vercel`, `.blog-migration-private`, private.pem/import SQL và Wrangler cache.

Project có `ssoProtection.deploymentType=all_except_custom_domains`. Request không đăng nhập vào deployment URL trả 302 đến Vercel SSO. **Chưa có branch alias và chưa kiểm chứng branch URL**; không coi protection của deployment URL là bằng chứng cho URL chưa tạo.

Production target trước đợt Vercel preview này là `dpl_8qdWyVMCvosbjbu2EHTTgv2XSmRw`; kiểm lại sau đợt **vẫn đúng deployment này**. Không chạy `--prod`, không push/merge main, không chỉnh nameserver hay binding của Minecraft/review Worker. `public/blog.html`, snapshot HTML, ảnh blog và `vercel.json` không có diff so với base. Đây là bằng chứng source/deployment isolation, **không thay thế** manifest byte toàn production trước/sau; manifest network đầy đủ vẫn là gate trước cutover.

### Kết quả kiểm thử

32/32 test liên quan preview đạt: HMAC vectors và negative cases, replay, grant validity/revocation/read-only, batch rollback, CAS hai tab, idempotency sau commit mơ hồ, bảo vệ slug/tombstone, R2 dedup, PUT timeout, partial upload, fencing/heartbeat và private media, MIME/payload cap, bridge env/origin và UI permissions/retry.

Lượt `node --test` toàn repo trước test UI cuối: 723 pass, 4 fail, 1 skip. Ba assertion của `blog-page.test.mjs` vẫn kỳ vọng 9 card nhưng base hiện có 16 và kỳ vọng rewrite sitemap động trong khi base đang dùng snapshot; các file dữ liệu/rewrite/test đó không bị đợt này sửa. Lỗi thứ tư là script HTTP Google login bị auto-discovery gọi localhost:3137 không sẵn sàng/bị sandbox chặn. Không sửa chúng để làm xanh test ngoài phạm vi và không tuyên bố toàn repo đã xanh.

Lượt regression cuối `node --test test/*.test.mjs`: 725 pass, 3 fail, 1 skip (729 test tổng); đúng ba assertion stale của blog-page ở trên, không còn auto-run script Google login. Verifier cuối dùng key copy Documents/secret tiếp tục đạt 460/460 object, 135/135 record, remote hash khớp; D1 có 5 migration, 460 file manifest, 135 staging record, 20 slug. Không đổi các hash dữ liệu legacy khi thêm schema hay chạy probe.

Dedicated loader stub Blob SDK: 11/11 storage/bridge test đạt, 0 SDK invocation được ghi nhận; network trap bắt mọi storage request ngoài Worker/Redis GET. Test actual session resolution ghi 2 GET và 0 Redis write. Đây là bằng chứng test local, không phải account-wide audit production. Wire JSON sát 3 MiB với filename/alt Unicode mẫu dưới 4.300.000 byte. Chưa upload file sát cap trên Vercel thật và chưa load-test 20 request/giây.

Remote probe dùng **một actor ID test tạm**, một nháp, một ảnh tổng hợp 80×40 (1 biến thể); không cấp quyền legacy. Kết quả:

| Phép đo | Số quan sát |
| --- | ---: |
| API Worker trong probe | 15 (ngoài ra 1 health) |
| D1 rows read qua Worker | 70 |
| D1 rows written qua Worker | 55 |
| D1 rows read truy vấn CLI đối soát/cleanup | 50 |
| D1 rows written truy vấn CLI fixture/cleanup | 22 |
| R2 PUT attempted/confirmed | 1 / 1 |
| R2 HEAD / GET | 1 / 1 |
| R2 delete object test | 1 |
| PUT ở lượt upload ảnh trùng | 0 |

HTTP observed: sai chữ ký 401, thiếu grant 403, save/retry/update/upload/read 200, stale revision 409, khóa save/upload 503, grant revoked 403, publish/unpublish/sitemap Worker 404. Remote CAS thử tuần tự với expected revision cũ; concurrency/race thực sự được test bằng adapter SQLite local, chưa phải load test remote. Remote auth replay/expired riêng cũng chưa chạy. Số rows là metadata SDK/query nhận được, không tổng analytics tài khoản; không gồm migration/deploy/các service khác, không suy ra bill cuối từ những số này.

Probe đã xóa đúng object test R2; chỉ xóa row thuộc actor test và hash ảnh test. Cuối probe: grants=0, drafts=0, revisions=0, media=0, replay=0, idempotency=0, `studio_read_only=true`. Không tự khôi phục hay ghi đè 54 pointer legacy. Local revision test giữ nội dung mới; không tuyên bố khôi phục 54 revision Blob cũ.

Worker bật Observability và structured events `put_attempted`, `put_confirmed`, `put_outcome_unknown`, `request_finished` có requestId, route, status, duration và D1/R2 counters. Không log body/secret/account record. **Chưa có sink audit bảo đảm 30 ngày**, cron dọn replay/idempotency, kênh cảnh báo cron hoặc backup định kỳ; phải hoàn thiện trước production, không coi console logging là đã đáp ứng retention.

### Các gate còn giữ

Không bật publish/cutover. 6 mapping vẫn chưa activated. Bước tiếp theo là quyết định quyền test preview cho tài khoản thật, xác nhận signed Studio flow end-to-end (hiện positive remote test mới qua Worker và local bridge), rồi canary/publish implementation. Chưa sửa bài HTML cũ trong Studio; muốn sửa cần import riêng được duyệt. Staging raw plaintext chưa scrub và Time Travel vẫn giữ lịch sử; backup ở Documents/secret cùng máy/iCloud chưa độc lập thiết bị. Còn baseline production đầy đủ, branch protection, file sát cap thật, tải đồng thời, audit/cron/backup lâu dài và cache/purge/unpublish gates trước cutover. **Không gọi đợt này là hoàn tất migration production.**

## Lượt tiếp tục: audit bền vững và quyền đọc preview

Các mục "chưa có audit/cron" và "grant=0" phía trên là trạng thái trước lượt này.

Migration `0006_operation_audit.sql` đã áp dụng trên D1 preview. Worker version mới
`37909fc0-8f6c-49e5-bc88-72e7d60a9918`, lịch Cron `17 * * * *` (mỗi giờ phút 17 UTC).
Cron là handler riêng, không mở endpoint bảo trì công khai. Chưa quan sát lần Cron
remote tự chạy đầu tiên trong cửa sổ kiểm thử; không coi cấu hình đã deploy là bằng
chứng Cron đã chạy. Handler và cleanup được kiểm thử local.

### Audit và chi phí phát sinh

`blog_operation_audit` giữ request ID, actor ID ổn định, loại save/upload, body hash,
trạng thái, HTTP status, mã lỗi, thời gian và số operation quan sát. Không sao chép
nội dung nháp, email, cookie, secret hoặc ảnh base64. Chỉ các mutation đã xác thực
và được phép qua gate đầu request mới có durable audit; read/denial vẫn structured
log, không tạo durable audit cho mỗi lần mở menu tài khoản.

`blog_media_put_audit` ghi intent **trước PUT**, rồi riêng kết quả `confirmed`,
`condition-not-met` hoặc `unknown`. `attempted` chưa có kết quả là trường hợp cần
đối soát, không phải bằng chứng storage đã nhận PUT: tiến trình có thể chết sau ghi
intent và trước lời gọi R2. `unknown` có thể được HEAD kiểm chứng để upload tiếp
nhưng không bị đổi thành `confirmed` giả. Khi audit start/attempt/confirmation
không xác nhận được, dừng mở PUT mới và không công bố ready. Object có thể đã lưu
nhưng còn pending; retry dùng lại key/fence/HEAD, không sinh UUID ảnh mới.

Nếu audit finish lỗi sau content commit, API trả 503 `BLOG_AUDIT_UNAVAILABLE`;
retry save giữ logical idempotency key, envelope mới, không tạo revision thứ hai.
Audit của request replay không ghi đè audit thành công trước đó. TTL audit tối thiểu
30 ngày tính từ lúc bắt đầu, dọn sau hết hạn; record started không bị đoán là lỗi
hay tự xác nhận thành công. Audit là D1 mới có chi phí, không gọi là miễn phí.
Metrics trong audit exclude UPDATE finish của chính nó; response headers include
UPDATE đó nếu SDK trả metadata. Counter vẫn là observed, không thay billing analytics.

Cron mỗi lượt xóa tối đa 500 replay (epoch seconds), 500 idempotency (epoch ms),
200 audit parent hết hạn, cascade tối đa 600 PUT audit child tương ứng. Chỉ query
expiry index và bounded subset; không scan toàn bộ bảng để COUNT. Công suất danh
nghĩa/ngày: 12.000 replay + 12.000 idempotency + 4.800 audit parent, tối đa 14.400
PUT child, **không** đồng nghĩa cùng số billed rows write vì còn index/cascade/settings.
Không xóa content, grant, legacy pointer, pending media, object R2 hay fencing state.
Sau dọn ghi `maintenance_status`; còn backlog hoặc hơn 3 giờ không có lần thành
công thì Studio hiện cảnh báo. Console/Studio là kênh hiện có, **chưa** có thông báo
email/Telegram khi người dùng không mở Studio. Trước production cần đo birth-rate
thực theo cửa sổ, yêu cầu công suất dọn ≥2 lần birth-rate; preview nhỏ và local test
không chứng minh điều kiện này cho production.

### Quyền tài khoản được kiểm lại, không nâng quyền

`tools/blog-preview-grants.mjs` decrypt backup trong RAM, kiểm lại grant/account/
email index/reverse username index bằng **24 GET, 0 Redis write**. Kết quả 6 mapped,
0 unresolved; giữ nguyên 2 admin + 4 editor, không active grant revoked/expired/
scheduled và không đoán ID từ client. Bằng chứng mới mã hóa:
`/Users/macbook/Documents/secret/realview-blog-backup-20261002/grant-validation-20261003-preview-readonly.encrypted.json`.
Không ghi credential Redis hay SQL grant plaintext vào repo. Env/SQL temp ở thư mục
0700 đã xóa đúng file sau chạy. Không sửa session/permission Redis production.

Importer đầu tiên fail trước activation do parser: Wrangler remote `--file` in
progress trước JSON và trả thống kê import, không trả SELECT rows. Đã xác minh
thực, sửa parser, dùng `--command` chỉ cho aggregate SELECT không chứa tài khoản,
giữ SQL grant trong temp private. Hai lần thất bại không tạo grant, không ghi đè
bằng chứng; lần thành công fresh verify lại. Grant import metadata quan sát:
20 rows read / 12 rows written; không cộng những lượt diagnostic thành tổng usage.

6 grant hiện active **chỉ ở D1 preview**, `studio_read_only=true`. Role có thể đọc
Studio nhưng save/upload bị khóa; publish/manageAccess vẫn disabled. D1 preview là
nguồn quyền riêng: thu hồi trong production Redis không tự đồng bộ ngược preview;
cần cập nhật/thu hồi preview khi thay đổi quyền trước khi mở thử rộng hơn.
Chưa tạo bài Studio thật khi backup độc lập thiết bị chưa đạt.

Probe signed Worker cho cả 6 account ID: 16 request, 48 observed rows read / 21
rows written (replay reservation/index), roles 2 admin + 4 editor. Mỗi tài khoản
read access 200, save khi locked 503; cùng envelope 409; hết hạn 401; publish 404.
Đây **không** phải browser-session end-to-end test, không đăng nhập thay người dùng.
Đã yêu cầu người dùng đăng nhập preview để kiểm giao diện với session thật.

### Deploy và kiểm thử mới

Vercel preview READY `dpl_3nMwmqwARc8u1RBHjJxXctVC6K3N`:
`https://realview-i53nn9wl2-tnt-s-projects1.vercel.app/admin/blog`.
Env override chỉ deployment; secret truyền bằng child process env, không argv.
Ba Blob token empty. Signed-out page 302 Vercel SSO; vượt protection bằng CLI nhưng
không có app session: 401 `AUTH_REQUIRED`, `X-Blog-Storage-Backend: cloudflare-preview`.
Production trước/sau vẫn `dpl_8qdWyVMCvosbjbu2EHTTgv2XSmRw`. Không push/main/production
deploy, không sửa DNS hay Minecraft/review Worker. Không có diff bài HTML, ảnh cũ
hoặc sitemap/rewrite trong đợt này; chưa thay thế gate network baseline toàn site.

39/39 targeted tests đạt (bổ sung test UI cảnh báo maintenance). 15/15 storage/audit test dưới Blob SDK spy đạt, không gọi
Blob và không Redis write trong content flow. Regression 736 tổng: 732 pass, 3 fail
(cùng ba assertion blog-page stale trước đó), 1 skip; không tuyên bố toàn repo xanh.

Remote mutation probe mới: 15 API Worker + 1 health; 79 rows read / 82 rows written
qua Worker; CLI fixture/cleanup 50 read / 22 write. R2 1 PUT attempted/confirmed,
1 HEAD, 1 GET, 1 delete fixture; upload trùng 0 PUT. Audit remote đối soát thực:
6 finished operation (2 upload 200, 3 save 200, 1 save 409), 1 PUT confirmed. Fixture
draft/revision/media/actor đã xóa, **audit giữ 30 ngày**, không xóa audit để làm giảm
con số. Sau grant import: grants 6, draft/revision/media đều 0, legacy pointer 54,
migrations 6, khóa ghi true. Usage trên không bao gồm toàn bộ migration/deploy,
diagnostic/grant/probe thứ hai/analytics tài khoản; không suy bill toàn đợt.

Vẫn còn: session thật end-to-end, backup/export định kỳ và độc lập thiết bị, scrub
staging được duyệt riêng, cảnh báo ngoài Studio, first Cron remote, gần cap upload
Vercel, load test/baseline/canary, publish/unpublish/generation/purge và sitemap gộp.
Không bật production hoặc ghi nội dung thật chỉ từ việc test preview đã đạt.

Verifier cuối lượt, dùng key copy trong Documents/secret: 460/460 object backup,
135/135 record, remote file/record hash khớp. Không khôi phục byte 54 Blob revision.
File SQL diagnostic chỉ SELECT aggregate đã xóa; không xóa dữ liệu người dùng.

## Kiểm tra phiên đăng nhập thật và editor thử nghiệm

Phiên Chrome của `nhantriet1674` trên preview ban đầu trả
`BLOG_ACCESS_DENIED`: tài khoản không thuộc 6 grant đã chuyển và không khớp owner
cấu hình. Việc thấy khung giao diện trước đó không chứng minh có quyền; API đã
từ chối đúng, không trả dữ liệu blog. Đã sửa giao diện để sidebar và điều hướng
posts/editor/guide chỉ mở sau khi xác nhận quyền, đồng thời dùng layout một cột
khi bị từ chối. Trạng thái khóa ghi không bị dòng "Chưa có thay đổi" ghi đè khi
mở editor. Banner preview phân biệt D1/R2 thử nghiệm với snapshot production.

Sau khi người dùng **đồng ý cấp editor chỉ trên preview**, xác minh lại ID ổn định
qua username index, account record và email index: 3 Redis GET, 0 Redis write.
Tạo grant editor giới hạn 24 giờ, hết hạn `2026-10-03T18:42:29.000Z` UTC
(04/10/2026 01:42:29 giờ Việt Nam), chỉ khi D1 vẫn khóa ghi. Không nâng quyền
admin, không cấp publish/manageAccess, không sửa grant production. Tổng grant
preview hiện là 7 (2 admin, 5 editor, gồm 1 editor thử nghiệm có hạn).
Bằng chứng phê duyệt và actor ID được mã hóa ngoài repo:
`/Users/macbook/Documents/secret/realview-blog-backup-20261002/preview-editor-approval-20261003.encrypted.json`.
SQL grant tạm private đã xóa sau khi xác minh SELECT.

Kiểm chứng trực tiếp phiên Chrome trên **host preview ban đầu**:

- Danh sách tải thành công, 0 bài; không hiện panel từ chối quyền.
- Menu tài khoản có "Quản trị bài viết", không có "Quyền truy cập".
- Mở editor trắng để quan sát: "Lưu bản nháp" và "Chọn ảnh" disabled; không có
  nút xuất bản. Không nhập nội dung, không lưu, không chọn/tải file.
- Trả lại danh sách sau kiểm tra. Đây là kiểm thử quyền đọc và trạng thái khóa,
  **không** phải kiểm thử save/upload thành công qua phiên browser.

Vercel preview mới chứa bản sửa UI READY:
`https://realview-57pn5mlt5-tnt-s-projects1.vercel.app/admin/blog`,
deployment `dpl_6698RVmbaNx2zuouam6SGFc6KKdq`. Env override chỉ deployment,
ba Blob token empty. Production trước/sau vẫn
`dpl_8qdWyVMCvosbjbu2EHTTgv2XSmRw`, không push hoặc deploy main.
Phiên RealView trên host ban đầu không được sao chép sang host mới; cần người dùng
đăng nhập host mới nếu muốn kiểm chứng bản sửa UI bằng chính phiên tài khoản đó.

41/41 targeted preview tests đạt. Regression cuối lượt: 738 tổng, 734 pass,
3 fail (ba assertion blog-page stale đã biết), 1 skip. Test mới kiểm tra denied/
rechecking không mở editor qua điều hướng, sidebar ẩn và trạng thái preview khóa
ghi được giữ khi mở editor. `git diff --check` đạt. Vẫn chưa mở khóa ghi,
publish/cutover, khôi phục revision cũ hoặc thay URL/nội dung/sitemap production.
