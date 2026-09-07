# TrustScore v4.2

TrustScore mô tả mức hỗ trợ của tập review đã thu thập cho việc đọc và đối chiếu
bằng chứng. Đây là chỉ số tổng hợp 0–100 theo các quy tắc sản phẩm, không phải
xác suất một review là thật, khoảng tin cậy thống kê hay điểm chất lượng sản phẩm.

## 1. Điều kiện công bố điểm

- `N` là số bản ghi review có nội dung chữ sau bước thu thập và chuẩn hóa, trước
  bộ lọc nội dung. Không tính `null`, đối tượng rỗng hoặc chuỗi chỉ có khoảng trắng.
- `N < 20`: endpoint báo `INSUFFICIENT_REVIEWS` (422); hàm tính độc lập trả `score: null`.
- `N >= 20`: luôn tính điểm số, kể cả thiếu tầng sao, bằng chứng ít, toàn bộ review
  bị loại hoặc kiểm định AI không hoàn tất. Độ hạn chế đi kèm kết quả và diễn giải.

Cam kết này thuộc bước phân tích sau thu thập. Nó không tạo dữ liệu khi URL sai,
nguồn Apify thất bại, hết khóa khả dụng hoặc người dùng hủy yêu cầu.

## 2. Các tập dữ liệu và đơn vị đếm

`audit` chứa review chữ thuộc thiết kế lấy mẫu. `evidence` chứa các review của
`audit` vượt quyết định lọc cuối, không trùng, không seeding, không lạc đề và không
còn chờ kiểm định. Review tiêu cực có lỗi cụ thể vẫn là bằng chứng hợp lệ.

Với mẫu chia tầng, các tầng sao cấu hình được dùng làm mẫu số cố định. Hiện tại
Shopee và TikTok dùng 5 tầng 1–5, mục tiêu `m = 20` review mỗi tầng. Không coi số sao
thu được theo filter là phân bố tự nhiên và không suy ra tỷ lệ toàn sản phẩm.

Trong từng tầng, các dòng cùng `authorId` được lấy trung bình trước, rồi mới lấy
trung bình giữa người viết. Một người có nhiều dòng không được nhân trọng số trong
tầng đó. Với độ phủ toàn mẫu, mỗi `authorId` chỉ đóng góp tổng cộng một đơn vị;
nếu xuất hiện ở nhiều tầng, đóng góp được chia đều giữa các tầng đó. Đây là quy
ước đếm bảo thủ, không phải ước lượng cỡ mẫu hiệu dụng thống kê.

Review thiếu `authorId` được coi là các đơn vị mô tả riêng sau khử trùng nội dung.
Không thể xác nhận chúng thuộc những người khác nhau; không suy diễn độc lập xác
suất từ quy ước này. Tín hiệu xác minh mua hàng thiếu được giữ là `null`.

## 3. Ba thành phần chất lượng

Các thành phần đều nằm trong 0–100:

1. **Nội dung T**: mỗi bằng chứng nhận `100 × (0,625 × I + 0,375 × D)`.
   `I` ánh xạ nhãn `high=1`, `medium=0,75`, `low=0,35`, `none=0`;
   `D = min(độ dài nội dung chuẩn hóa / 80, 1)`. Khi nhãn thông tin chưa có,
   dùng `D` thay `I`. Lấy trung bình theo người viết trong mỗi tầng.
2. **Mức ít nhiễu A**: trung bình tỷ lệ review được dùng làm bằng chứng trong
   phần đã phân loại, cân bằng theo người viết. Review chưa kiểm định không được
   mặc định là sạch hay rác; chúng được loại khỏi mẫu số có điều kiện này.
3. **Độ phủ kiểm định L**: trung bình trạng thái đã có quyết định (`100`) hoặc
   chưa kiểm định được (`0`), cân bằng theo người viết. Quyết định chắc chắn của
   Layer 1 và phát hiện duplicate không cần gọi Gemini vẫn được tính đã phân loại.

Với mẫu chia tầng, mỗi thành phần lấy trung bình đều giữa các tầng đã quan sát.
Tầng chưa có review không được gán chất lượng giả. Tầng đã có review nhưng không
còn bằng chứng có `T = 0`; không được bỏ tầng đó rồi nâng điểm. Với `A`, tầng chưa
có quyết định phân loại không có tỷ lệ sạch xác định và không tham gia trung bình
có điều kiện; phần thiếu vẫn hiện ở `L`. Thành phần hoàn toàn không có dữ liệu
nhận giá trị bảo thủ `0` để vẫn xuất được chỉ số số học.

Mẫu không chia tầng dùng các trung bình theo người viết trên toàn mẫu quan sát.

Điểm chất lượng cơ sở:

```text
Q = (T + A + L) / 3
```

Các thành phần có thể tương quan; không giả định chúng độc lập và không nhân
chúng như các xác suất. Các trọng số là lựa chọn thiết kế, chưa phải hệ số được
hiệu chuẩn để dự đoán độ chính xác của bộ lọc.

## 4. Độ phủ bằng chứng và điểm cuối

Với `H` tầng sao cấu hình và `n_h` đơn vị người viết có bằng chứng trong tầng `h`:

```text
c_h = min(n_h / m, 1)
C   = (c_1 + ... + c_H) / H
```

Tầng không có bằng chứng nhận `c_h = 0`. Lấy quá mục tiêu ở một tầng không bù được
tầng thiếu. Review bị loại không lấp đầy độ phủ. `C` nằm trong `[0,1]`.

Với mẫu không chia tầng, `C = min(số đơn vị bằng chứng / 60, 1)`. Mốc 60 được giữ
cho nhánh này; không được gọi nó là cỡ mẫu bảo đảm đại diện cho tổng thể.

```text
Nếu Q <= 50: S = Q
Nếu Q > 50:  S = 50 + C × (Q - 50)
TrustScore = làm tròn S ở bước cuối
```

Không có cap 39. Độ phủ được áp dụng một lần trong phép ghép điểm, không cộng
thêm như thành phần thứ tư. Điểm thấp không được nâng lên vì thiếu mẫu. Với `Q`
cố định, tăng `C` không làm giảm điểm; với `C` cố định, tăng `Q` không làm giảm
điểm. Hàm liên tục tại 50 trước làm tròn.

Mốc 50 và cách co điểm là quy tắc bảo thủ của chỉ số, không phải trung bình quần
thể hay kết quả Bayes. Khi thêm review thực tế, cả chất lượng lẫn độ phủ có thể
đổi, nên điểm tổng có thể tăng hoặc giảm hợp lý. Không bảo đảm mọi review mới
đều làm tăng điểm.

Ví dụ giữ `Q = 80` và mục tiêu 5 × 20:

| Bằng chứng mỗi tầng 1–5 | C | Điểm cuối | Trạng thái |
| --- | ---: | ---: | --- |
| 20, 0, 0, 0, 0 | 0,20 | 56 | limited |
| 20, 20, 0, 0, 0 | 0,40 | 62 | limited |
| 20, 20, 20, 0, 0 | 0,60 | 68 | provisional |
| 20, 20, 20, 20, 0 | 0,80 | 74 | provisional |
| 20, 20, 20, 20, 20 | 1,00 | 80 | valid |

Đây là ví dụ công thức với chất lượng giữ nguyên, không phải điểm đo từ sản phẩm.

## 5. Trạng thái và cách diễn giải

- `insufficient`: dưới 20 review chữ.
- `limited`: từ 20 review nhưng `C < 0,5`.
- `provisional`: `C < 0,7` hoặc có tầng dưới 50% mục tiêu bằng chứng.
- `valid`: đạt các ngưỡng trên. Nhãn này chỉ mô tả mức đủ dùng theo quy tắc thiết
  kế; không chứng minh dữ liệu ngẫu nhiên hay kết quả đúng với toàn bộ sản phẩm.

Các ngưỡng trạng thái không chặn phân tích khi đã có ít nhất 20 review chữ.
Khi mẫu còn hạn chế, backend giữ phần kết luận theo quy tắc kèm cảnh báo;
Gemini chỉ diễn giải các mục chi tiết, không được viết đè kết luận này.
Nếu không còn bằng chứng hợp lệ, dùng kết luận từ backend và không gọi Gemini
diễn giải ưu/nhược điểm; điểm vẫn được trả khi đã có ít nhất 20 review chữ.

## 6. Khử trùng và kiểm định

Khử trùng chạy một lần trước Gemini, chọn đại diện theo thứ tự ổn định của nội
dung/metadata. Cụm trùng mâu thuẫn sao hoặc nhãn ngữ nghĩa bị loại khỏi bằng chứng
để tránh tùy tiện chọn một kết luận. Gemini chỉ kiểm định các bản đại diện;
backend giữ nguyên kết quả khử trùng tới bước lọc cuối. Bản sao bị bỏ qua có chủ
đích không được gắn nhầm là lỗi Gemini.

`defectScore` mô tả mức nhược điểm trong bằng chứng đã giữ và không tham gia
TrustScore. Khi thiếu tầng, thống kê này chỉ mô tả các tầng có bằng chứng;
metadata không tuyên bố khả năng so sánh với mẫu đầy đủ hay tỷ lệ lỗi tổng thể.

Fisher/binomial không dùng suy luận tổng thể cho các lượt Shopee/TikTok lấy theo
filter hoặc sắp xếp đề xuất. Nhánh kiểm định chỉ khả dụng khi nguồn được khai báo
ngẫu nhiên không chia tầng, không có duplicate, không lặp định danh người viết
và không thiếu định danh; kiểm định khuyết tật còn cần baseline hiệu chuẩn.
Đó là điều kiện kiểm tra trong code, không phải bằng chứng tự động rằng giả định
lấy mẫu ngẫu nhiên của nhà cung cấp là đúng.

Các trường cũ `effectiveSampleSize`, `balancedEvidenceSize`, `independentEvidenceSize`
được giữ cùng cờ deprecated để tương thích; không hiển thị chúng như cỡ mẫu hiệu
dụng hay số quan sát độc lập. Dùng `coverage`, `coveredSampleSlots` và các trường
`distinctContributor...` để xem đúng ý nghĩa mô tả.
