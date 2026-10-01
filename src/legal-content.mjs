// Public copy kept separate from rendering. Audit this against deployed data flows
// before publication; do not infer provider retention or Google approval from code.
export const LEGAL_UPDATED = '2026-10-01';
export const LEGAL_VERSION = '1.0';
export const LEGAL_CONTACT = 'realviewueh@gmail.com';

export const LEGAL_PAGES = Object.freeze([
  {
    key: 'privacy', file: 'privacy.html', path: '/chinh-sach-bao-mat', title: 'Chính sách bảo mật',
    description: 'Tìm hiểu cách RealView sử dụng thông tin tài khoản, lịch sử phân tích, review công khai, cookies và cách yêu cầu hỗ trợ về dữ liệu.',
    lead: 'Thông tin của bạn cần được sử dụng rõ ràng, đúng mục đích. Chính sách này giải thích dữ liệu RealView xử lý và những lựa chọn bạn có khi sử dụng dịch vụ.',
    summary: [
      'Thông tin tài khoản giúp xác thực và lưu lịch sử. Review sản phẩm công khai là một nguồn dữ liệu riêng, không phải dữ liệu đăng nhập của bạn.',
      'Dịch vụ sử dụng nhà cung cấp hạ tầng, phân tích truy cập và AI. Phần dưới giải thích vai trò của từng nhóm nhà cung cấp.',
      'Bạn có thể xoá lịch sử đã lưu hoặc gửi yêu cầu về thông tin cá nhân qua kênh hỗ trợ của RealView.'
    ],
    sections: [
      {
        id: 'pham-vi', short: 'Phạm vi & liên hệ', title: 'Phạm vi và nhóm phụ trách',
        paragraphs: [
          'Chính sách áp dụng cho website RealView tại realview.com.vn và các tính năng tài khoản, phân tích đánh giá, trợ lý AI, lịch sử và liên hệ do nhóm dự án RealView vận hành.',
          'RealView là dự án học thuật của nhóm sinh viên UEH. Nhóm dự án là đầu mối hỗ trợ của website; mô tả này không xác định UEH là bên vận hành hoặc bên bảo đảm cho dịch vụ.',
          'Chính sách không thay thế chính sách của Shopee, TikTok Shop, Google hoặc website khác mà bạn truy cập từ RealView. Khi mở liên kết bên ngoài, hãy đọc chính sách của dịch vụ đó.'
        ], contact: true
      },
      {
        id: 'du-lieu', short: 'Dữ liệu được xử lý', title: 'Những thông tin được xử lý',
        paragraphs: ['RealView xử lý thông tin tương ứng với tính năng bạn sử dụng; không phải mọi lần truy cập đều yêu cầu tạo tài khoản.'],
        bullets: [
          { label: 'Tài khoản RealView', text: 'Tên đăng nhập, email, thời điểm tạo tài khoản và lựa chọn nhận email. Với đăng nhập bằng mật khẩu, hệ thống lưu bản băm mật khẩu, không lưu mật khẩu ở dạng văn bản thuần.' },
          { label: 'Đăng nhập Google', text: 'Khi tính năng được cung cấp và bạn chọn sử dụng, RealView xử lý tên, email và mã định danh tài khoản Google để xác thực hoặc liên kết tài khoản. Luồng đăng nhập này không yêu cầu quyền đọc Gmail hay Google Drive.' },
          { label: 'Sử dụng dịch vụ', text: 'Link sản phẩm, kết quả và lịch sử phân tích bạn lưu. Nếu hỏi trợ lý AI, nội dung câu hỏi, các tin nhắn liên quan và ngữ cảnh kết quả có thể được xử lý để trả lời.' },
          { label: 'Liên hệ và email', text: 'Họ tên, email, nội dung bạn gửi qua biểu mẫu và thông tin cần thiết để xác minh, phản hồi yêu cầu. Không gửi mật khẩu, mã xác minh hoặc thông tin tài chính vào biểu mẫu hay cuộc trò chuyện.' },
          { label: 'Dữ liệu kỹ thuật', text: 'Thông tin phiên đăng nhập, địa chỉ IP dùng cho giới hạn truy cập, thông tin thiết bị/trình duyệt, lượt truy cập, sự kiện sử dụng, hiệu suất và nhật ký lỗi cần cho vận hành hoặc chẩn đoán.' },
          { label: 'Review công khai', text: 'Nội dung đánh giá, số sao, ngày đánh giá và thông tin người viết do nguồn cung cấp trả về, như tên hiển thị hoặc mã định danh. Việc dữ liệu được công khai không có nghĩa người viết mất quyền đối với thông tin của mình.' }
        ]
      },
      {
        id: 'muc-dich', short: 'Mục đích sử dụng', title: 'Dữ liệu được dùng để làm gì?',
        bullets: [
          { label: 'Cung cấp tính năng', text: 'Xác thực tài khoản, lưu và hiển thị lịch sử, thu thập review theo link sản phẩm, phân loại review, tính TrustScore và trả lời câu hỏi của bạn.' },
          { label: 'Hỗ trợ và bảo vệ dịch vụ', text: 'Gửi mã xác minh, thông báo liên quan tài khoản, phản hồi liên hệ, giới hạn lạm dụng và xử lý lỗi.' },
          { label: 'Đo lường và cải thiện', text: 'Hiểu tính năng được sử dụng, đo tốc độ tải và cải thiện trải nghiệm. Các sự kiện phân tích tuỳ chỉnh giới hạn ở thông tin như nền tảng mua sắm, phương thức thao tác hoặc loại lỗi; không chủ đích gửi mật khẩu hay nội dung biểu mẫu liên hệ vào các sự kiện này.' },
          { label: 'Email cập nhật', text: 'Lựa chọn nhận email cập nhật được ghi nhận riêng với việc tạo tài khoản. Bạn có thể yêu cầu ngừng nhận loại email này; email xác minh hoặc hỗ trợ được dùng cho mục đích vận hành, không phải đăng ký marketing.' },
          { label: 'Bộ dữ liệu review', text: 'Review thô và review đã gắn nhãn có thể được lưu để đối chiếu kết quả, tái sử dụng dữ liệu và xây dựng bộ dữ liệu nghiên cứu. Lưu bộ dữ liệu không đồng nghĩa mô hình đã được huấn luyện trên bộ dữ liệu đó. Việc sử dụng cho huấn luyện cần được xem xét riêng về quyền dữ liệu và mục đích xử lý.' }
        ]
      },
      {
        id: 'cookies', short: 'Cookies & lưu trên máy', title: 'Cookies và dữ liệu trên thiết bị',
        paragraphs: [
          'Cookie phiên đăng nhập giúp website nhận biết tài khoản giữa các lần truy cập. Luồng đăng nhập Google, khi được sử dụng, có thể tạo cookie và thông tin xác thực tạm thời để kiểm tra đúng phiên đăng nhập.',
          'Website có thể dùng bộ nhớ phiên của trình duyệt để giữ kết quả phân tích gần nhất hoặc trạng thái giao diện. Xoá dữ liệu trình duyệt có thể làm mất trạng thái này hoặc đăng xuất; thao tác đó không tự xoá tài khoản và dữ liệu đã lưu trên máy chủ.',
          'Landing page hiện tích hợp Google Analytics và công cụ đo truy cập/hiệu suất của Vercel. Google Analytics có thể đặt cookie phân tích và xử lý dữ liệu truy cập theo cấu hình dịch vụ. Website hiện chưa có bảng lựa chọn cookies theo từng nhóm; không nên hiểu rằng các cookie phân tích chỉ được tải sau khi bạn bấm đồng ý.',
          'Bạn có thể điều chỉnh hoặc chặn cookie trong trình duyệt. Một số tính năng, đặc biệt là đăng nhập, có thể không hoạt động khi cookie cần thiết bị chặn.'
        ]
      },
      {
        id: 'nha-cung-cap', short: 'Nhà cung cấp & chia sẻ', title: 'Nơi xử lý dữ liệu và nhà cung cấp',
        paragraphs: ['RealView sử dụng dịch vụ bên ngoài để vận hành các tính năng. Dữ liệu được truyền tuỳ theo chức năng và cấu hình đang hoạt động; nhà cung cấp có chính sách lưu trữ, bảo mật và xử lý riêng.'],
        table: {
          caption: 'Nhà cung cấp theo chức năng', columns: ['Dịch vụ', 'Vai trò và dữ liệu liên quan'],
          rows: [
            ['Vercel', 'Phân phối website, chạy API và đo hiệu suất/truy cập. Vercel Blob có thể lưu bộ dữ liệu review trong vùng lưu trữ riêng tư khi được cấu hình.'],
            ['Dịch vụ Redis', 'Lưu tài khoản, phiên đăng nhập, lịch sử, yêu cầu liên hệ, thông tin xác minh tạm thời và bộ đếm vận hành.'],
            ['Apify / nguồn review', 'Nhận link hoặc định danh sản phẩm và tham số thu thập để trả về đánh giá công khai.'],
            ['Google / Gemini', 'Xác thực khi bạn chọn đăng nhập Google; xử lý nội dung review hoặc câu hỏi/ngữ cảnh khi tính năng AI sử dụng Gemini; đo truy cập qua Google Analytics. Đây là các chức năng riêng biệt.'],
            ['Gmail SMTP hoặc Resend', 'Gửi email xác minh, khôi phục tài khoản và phản hồi theo nhà cung cấp email đang được cấu hình.']
          ]
        },
        paragraphsAfter: [
          'Hạ tầng của các nhà cung cấp có thể xử lý hoặc lưu dữ liệu ngoài Việt Nam. Không nên hiểu vị trí chạy một API là vị trí duy nhất lưu tất cả dữ liệu.',
          'Đối với đăng nhập Google, thông tin xác thực được dùng cho xác thực và liên kết tài khoản, không phải đầu vào của bộ phân loại review. Nội dung bạn tự nhập vào trợ lý vẫn có thể được chuyển tới nhà cung cấp AI; hãy tránh đưa thông tin cá nhân nhạy cảm vào câu hỏi.',
          'Dữ liệu có thể được cung cấp khi cần xử lý yêu cầu hợp lệ của cơ quan có thẩm quyền hoặc bảo vệ an toàn dịch vụ, trong phạm vi nghĩa vụ áp dụng. Nhóm giới hạn việc sử dụng dữ liệu theo các mục đích được mô tả trong chính sách này.'
        ]
      },
      {
        id: 'luu-tru', short: 'Thời hạn lưu & bảo vệ', title: 'Lưu trữ, xoá và bảo vệ dữ liệu',
        paragraphs: [
          'Một số dữ liệu tạm thời có thời hạn kỹ thuật: phiên tài khoản hiện có thời hạn tối đa 30 ngày; mã và yêu cầu xác minh/khôi phục thường có thời hạn 10 phút. Đăng xuất làm hết hiệu lực phiên đang sử dụng, không xoá tài khoản.',
          'Lịch sử tài khoản hiện giữ tối đa 50 kết quả; kết quả cũ có thể được thay thế khi vượt giới hạn. Bạn có thể xoá lịch sử bằng chức năng hiện có. Việc xoá một mục lịch sử không đồng thời xoá bộ dữ liệu review công khai hoặc dữ liệu nguồn ở nền tảng khác.',
          'Hồ sơ tài khoản, yêu cầu liên hệ và bộ dữ liệu review chưa có một lịch tự động xoá chung theo số ngày trong hệ thống hiện tại. Các dữ liệu này có thể tiếp tục được lưu cho mục đích đã nêu cho đến khi được xử lý hoặc xoá theo yêu cầu phù hợp. Thời hạn lưu của nhật ký và bản sao lưu còn phụ thuộc nhà cung cấp; nhóm không cam kết xoá tức thời mọi bản sao.',
          'Hệ thống sử dụng bản băm mật khẩu, kiểm tra phiên, xác minh email và kiểm soát truy cập ở những chức năng tương ứng. Không có biện pháp kỹ thuật nào bảo đảm an toàn tuyệt đối. Bạn nên dùng mật khẩu riêng, giữ kín mã xác minh và thông báo khi phát hiện truy cập bất thường.'
        ]
      },
      {
        id: 'quyen-cua-ban', short: 'Lựa chọn & yêu cầu dữ liệu', title: 'Lựa chọn của bạn và cách gửi yêu cầu',
        paragraphs: [
          'Bạn có thể xoá các mục lịch sử bằng giao diện lịch sử, đăng xuất tài khoản, xoá bộ nhớ trình duyệt hoặc kiểm soát cookie tại thiết bị của mình. Nếu đã đăng ký email cập nhật, bạn có thể gửi yêu cầu ngừng nhận qua email hỗ trợ.',
          'Để yêu cầu xem, sửa hoặc xoá thông tin tài khoản, hoặc phản ánh thông tin cá nhân xuất hiện trong một review, hãy gửi email nêu rõ dữ liệu/tài khoản liên quan và phạm vi yêu cầu. Website chưa có nút xoá tài khoản tự phục vụ; yêu cầu xoá tài khoản được tiếp nhận qua hỗ trợ.',
          'Nhóm có thể cần xác minh bạn là người liên quan trước khi thực hiện yêu cầu. Không gửi mật khẩu hoặc mã xác minh trong email. Nhóm sẽ thông báo về phạm vi có thể xử lý, các giới hạn kỹ thuật và nghĩa vụ lưu giữ nếu có; không bảo đảm xoá được dữ liệu do nền tảng bên ngoài kiểm soát.'
        ], contact: true
      },
      {
        id: 'cap-nhat', short: 'Thay đổi chính sách', title: 'Cập nhật chính sách',
        paragraphs: [
          'Phiên bản và ngày cập nhật được hiển thị ở đầu trang. Khi dữ liệu được sử dụng cho mục đích mới hoặc có thay đổi quan trọng, nhóm sẽ cập nhật nội dung và cung cấp thông báo phù hợp với tính năng hoặc nghĩa vụ áp dụng.',
          'Chính sách này giải thích việc xử lý dữ liệu; nó không thay thế việc xin phép riêng khi một chức năng cần sự đồng ý của bạn. Hãy liên hệ nếu bạn có câu hỏi trước khi cung cấp thông tin.'
        ]
      }
    ]
  },
  {
    key: 'terms', file: 'terms.html', path: '/dieu-khoan-su-dung', title: 'Điều khoản sử dụng',
    description: 'Điều khoản sử dụng RealView: phạm vi dịch vụ, trách nhiệm tài khoản, giới hạn TrustScore, nội dung đánh giá và cách liên hệ hỗ trợ.',
    lead: 'Một góc nhìn rõ ràng trước khi sử dụng RealView. Những điều khoản dưới đây giúp bạn hiểu phạm vi dịch vụ, trách nhiệm của mình và giới hạn của kết quả phân tích.',
    summary: [
      'RealView hỗ trợ đọc và phân tích review. Kết quả giúp tham khảo, không thay bạn đưa ra quyết định mua hàng.',
      'TrustScore là tín hiệu về độ tin cậy của tập review được phân tích, không phải điểm chất lượng sản phẩm hay chứng nhận review thật/giả.',
      'Bạn chịu trách nhiệm với thông tin tài khoản và nội dung gửi lên. Các vấn đề về dữ liệu được giải thích riêng trong Chính sách bảo mật.'
    ],
    sections: [
      {
        id: 'dich-vu', short: 'Phạm vi dịch vụ', title: 'RealView cung cấp dịch vụ gì?',
        paragraphs: [
          'RealView là website hỗ trợ tổng hợp và phân tích các đánh giá sản phẩm công khai, giảm nhiễu từ phản hồi ít thông tin và trình bày những điểm cần cân nhắc trước khi mua sắm. Website có thể cung cấp lịch sử, nội dung hướng dẫn và trợ lý AI.',
          'Dịch vụ do nhóm dự án RealView vận hành trong bối cảnh dự án học thuật của sinh viên UEH. Việc nhắc đến UEH không có nghĩa trường là bên vận hành, xác nhận sản phẩm hoặc bảo đảm kết quả phân tích.',
          'RealView không phải sàn thương mại điện tử, không phải bên bán và không thay mặt Shopee, TikTok Shop hay người bán xử lý đơn hàng, thanh toán, hoàn tiền hoặc bảo hành.'
        ]
      },
      {
        id: 'su-dung', short: 'Sử dụng & tài khoản', title: 'Sử dụng dịch vụ và bảo vệ tài khoản',
        paragraphs: [
          'Trước khi dùng dịch vụ, hãy đọc các điều khoản này và Chính sách bảo mật. Nếu không đồng ý với điều khoản sử dụng, bạn có thể ngừng sử dụng và liên hệ để hỏi về thông tin hoặc dữ liệu đã cung cấp.',
          'Khi đăng ký, bạn cần cung cấp thông tin phù hợp và có quyền sử dụng địa chỉ email hoặc tài khoản Google được chọn. Đăng nhập Google chỉ được cung cấp khi tính năng đã được triển khai; liên kết tài khoản có thể yêu cầu xác nhận bổ sung.',
          'Bạn chịu trách nhiệm giữ kín mật khẩu và mã xác minh, bảo vệ thiết bị, đăng xuất trên thiết bị dùng chung và thông báo khi nghi ngờ tài khoản bị truy cập trái phép. Không dùng danh tính của người khác hoặc chia sẻ thông tin đăng nhập để lạm dụng dịch vụ.',
          'Nếu chưa đủ tuổi tự quyết định việc sử dụng dịch vụ theo quy định áp dụng, hãy sử dụng với sự hướng dẫn hoặc chấp thuận phù hợp của cha mẹ hay người giám hộ.'
        ]
      },
      {
        id: 'gioi-han-ket-qua', short: 'Giới hạn kết quả', title: 'Hiểu đúng TrustScore và kết quả phân tích',
        bullets: [
          { label: 'Điểm số không phải chứng nhận', text: 'TrustScore phản ánh độ tin cậy của tập review theo mô hình và dữ liệu đã xử lý, không phải điểm chất lượng sản phẩm, xác nhận người bán uy tín hay kết luận một review là thật/giả 100%.' },
          { label: 'Cỡ mẫu và thời điểm có ảnh hưởng', text: 'Kết quả phụ thuộc số review lấy được, bộ lọc, nguồn dữ liệu và thời điểm thu thập. Mẫu nhỏ, thiếu nhóm đánh giá hoặc lấy theo số sao có thể không đại diện cho toàn bộ người mua.' },
          { label: 'Thuật toán và AI có thể sai', text: 'Việc gắn nhãn, tóm tắt, phân tích ngôn ngữ hoặc kiểm định có thể bỏ sót hay diễn giải nhầm. Tín hiệu thống kê không tự chứng minh nguyên nhân, hành vi gian lận hoặc trải nghiệm thực tế của mọi người mua.' },
          { label: 'Giữ lại hay loại bỏ không khẳng định thật/giả', text: 'Review được giữ lại là review đáp ứng tiêu chí sử dụng trong phép phân tích. Review bị tách riêng có thể ít thông tin, trùng lặp hoặc mang tín hiệu cần xem xét; không vì thế được khẳng định là giả.' },
          { label: 'Bạn vẫn cần kiểm tra thông tin sản phẩm', text: 'Hãy đối chiếu mô tả, giá, người bán, chính sách đổi trả và các review gốc. Không dùng điểm số làm căn cứ duy nhất để mua hàng hoặc công khai cáo buộc một cá nhân hay tổ chức.' }
        ]
      },
      {
        id: 'noi-dung', short: 'Nội dung & liên kết', title: 'Nội dung, quyền sử dụng và liên kết ngoài',
        paragraphs: [
          'Review gốc, hình ảnh và thông tin sản phẩm có thể thuộc người viết, người bán hoặc nền tảng nguồn. RealView trình bày thông tin phục vụ tham khảo; việc xuất hiện trên website không đồng nghĩa mọi nội dung đó thuộc sở hữu RealView.',
          'Bạn cần có quyền phù hợp đối với nội dung tự gửi và không đưa lên thông tin cá nhân của người khác khi không có căn cứ phù hợp. Nội dung được xử lý để cung cấp dịch vụ theo Chính sách bảo mật, không phải một sự chuyển giao vô điều kiện mọi quyền sở hữu cho nhóm dự án.',
          'Liên kết “Mở sản phẩm” và các liên kết ngoài đưa bạn sang dịch vụ khác. Giá, tình trạng hàng, thông tin và chính sách ở nguồn có thể thay đổi. RealView không kiểm soát nội dung hoặc giao dịch trên các dịch vụ đó.',
          'Nếu bạn cho rằng một nội dung ảnh hưởng đến quyền của mình, hãy gửi link liên quan và thông tin mô tả qua kênh hỗ trợ để nhóm xem xét.'
        ]
      },
      {
        id: 'hanh-vi', short: 'Hành vi không phù hợp', title: 'Những hành vi không được phép',
        paragraphs: ['Để bảo vệ người dùng và khả năng hoạt động của hệ thống, không sử dụng RealView để:'],
        bullets: [
          { text: 'Mạo danh, chiếm đoạt tài khoản, truy cập trái phép dữ liệu hoặc chức năng không được cấp quyền.' },
          { text: 'Gửi mã độc, spam, nội dung vi phạm quyền của người khác hoặc thông tin nhằm gây hại.' },
          { text: 'Gây quá tải, phá hoại hệ thống hoặc tìm cách vượt giới hạn truy cập và các cơ chế bảo vệ dịch vụ.' },
          { text: 'Làm sai lệch dữ liệu, thao túng kết quả hoặc trình bày TrustScore như một chứng nhận chính thức về người bán hay sản phẩm.' }
        ],
        paragraphsAfter: ['Nhóm có thể giới hạn yêu cầu hoặc quyền truy cập khi có dấu hiệu lạm dụng hoặc rủi ro an toàn. Nếu cho rằng hạn chế được áp dụng nhầm, bạn có thể gửi thông tin để yêu cầu xem xét.']
      },
      {
        id: 'du-lieu-ca-nhan', short: 'Dữ liệu & email', title: 'Dữ liệu cá nhân và email cập nhật',
        paragraphs: [
          'Chính sách bảo mật mô tả thông tin được thu thập, nơi xử lý, thời hạn lưu, cookies và cách gửi yêu cầu về dữ liệu. Chấp nhận điều khoản sử dụng không tự động có nghĩa bạn đồng ý nhận email marketing hoặc mọi mục đích xử lý dữ liệu mới.',
          'Lựa chọn nhận email cập nhật được ghi nhận riêng. Bạn có thể đề nghị ngừng nhận loại email này qua hỗ trợ mà không phải bỏ việc sử dụng các tính năng cơ bản.',
          'Việc xoá lịch sử, đăng xuất, xoá dữ liệu trình duyệt và yêu cầu xoá tài khoản là những thao tác khác nhau. Hãy đọc Chính sách bảo mật để hiểu phạm vi của từng thao tác.'
        ], related: true
      },
      {
        id: 'van-hanh', short: 'Vận hành & trách nhiệm', title: 'Khả năng hoạt động và trách nhiệm',
        paragraphs: [
          'Dịch vụ có thể gián đoạn vì bảo trì, lỗi kỹ thuật, thay đổi API, nguồn review bị giới hạn hoặc nhà cung cấp bên ngoài không phản hồi. Không phải mọi sản phẩm hay mọi lần phân tích đều lấy được đủ review.',
          'Tính năng, giới hạn sử dụng và mô hình phân tích có thể được điều chỉnh khi dự án phát triển. Nếu có thay đổi về điều kiện sử dụng hoặc thu phí, thông tin liên quan cần được công bố trước khi áp dụng; không suy ra nghĩa vụ thanh toán chỉ từ việc truy cập website.',
          'Bạn cần tự kiểm tra thông tin trước quyết định mua sắm. Nhóm hỗ trợ xem xét sai sót khi có thông tin đối chiếu, nhưng không bảo đảm độ chính xác tuyệt đối, hoạt động liên tục hoặc một kết quả mua sắm cụ thể.',
          'Các giới hạn mô tả ở đây không nhằm loại bỏ quyền của người dùng hoặc trách nhiệm của bên vận hành mà pháp luật áp dụng không cho phép loại bỏ.'
        ]
      },
      {
        id: 'lien-he', short: 'Cập nhật & hỗ trợ', title: 'Cập nhật điều khoản và liên hệ',
        paragraphs: [
          'Phiên bản và ngày cập nhật nằm ở đầu trang. Nhóm sẽ công bố thay đổi trên website và cung cấp thông báo phù hợp khi điều kiện sử dụng có thay đổi quan trọng. Yêu cầu đồng ý riêng, nếu cần, không được thay thế chỉ bằng việc sửa nội dung trang này.',
          'Nếu có câu hỏi, muốn phản ánh kết quả sai, nội dung ảnh hưởng tới quyền của bạn hoặc hạn chế truy cập, hãy gửi mô tả và link liên quan. Nhóm sẽ tiếp nhận và trao đổi để xác định cách xử lý phù hợp.'
        ], contact: true
      }
    ]
  }
]);
