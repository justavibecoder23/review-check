(() => {
  if (window.RealViewI18n) return;

  const STORAGE_KEY = 'realview-language';
  const BLOG_NOTICE_KEY = 'realview:show-blog-language-notice';
  const SUPPORTED = new Set(['vi', 'en']);
  const BLOG_PATH = /^(?:\/bai-viet(?:\/|$)|\/blog(?:\.html|\/))/;
  const isBlogPage = BLOG_PATH.test(window.location.pathname);
  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();
  let observer;
  let language = readLanguage();

  const english = {
    'Đi đến nội dung chính': 'Skip to main content',
    'Trang chủ': 'Home',
    'Tiêu chí lọc': 'Review criteria',
    'Lịch sử': 'History',
    'Mới': 'New',
    'New': 'New',
    'Về RealView': 'About RealView',
    'Cách dùng RealView': 'How RealView works',
    'Cách dùng': 'How to use',
    'Vì sao nên chọn RealView?': 'Why choose RealView?',
    'Tính năng nổi bật': 'Key features',
    'Quy trình đánh giá': 'Review process',
    'Bộ tiêu chí đánh giá': 'Review criteria',
    'Bộ': 'Evaluation',
    'tiêu chí': 'criteria',
    'đánh giá': 'framework',
    'Trợ lý': 'Assistant',
    'Liên hệ': 'Contact',
    'Đăng nhập / Đăng ký': 'Sign in / Sign up',
    'Đăng nhập': 'Sign in',
    'Đăng ký': 'Sign up',
    'Đăng xuất': 'Sign out',
    'Tài khoản': 'Account',
    'Tài khoản RealView': 'RealView account',
    'Email cập nhật RealView': 'RealView email updates',
    'Quản trị bài viết': 'Manage articles',
    'Đăng và chỉnh sửa Blog': 'Publish and edit Blog posts',
    'Quản trị phân quyền': 'Manage access',
    'Quyền truy cập': 'Access management',
    'Quản lý admin và editor': 'Manage admin and editor roles',
    'Đổi mật khẩu': 'Change password',
    'Thêm mật khẩu RealView': 'Add a RealView password',
    'TÀI KHOẢN REALVIEW': 'REALVIEW ACCOUNT',
    'Đăng nhập để xem lịch sử phân tích trên mọi lần truy cập.': 'Sign in to access your analysis history across visits.',
    'Chọn đăng nhập hoặc đăng ký': 'Choose sign in or sign up',
    'hoặc dùng tài khoản RealView': 'or use your RealView account',
    'Email hoặc tên đăng nhập': 'Email or username',
    'Mật khẩu': 'Password',
    'Tên đăng nhập': 'Username',
    'Mật khẩu mới': 'New password',
    'Nhập lại mật khẩu mới': 'Confirm new password',
    'Mã xác minh email': 'Email verification code',
    'Mã xác minh': 'Verification code',
    'Email đã đăng ký': 'Registered email',
    'Quên mật khẩu?': 'Forgot password?',
    'Chưa có tài khoản?': 'New to RealView?',
    'Đăng ký ngay': 'Sign up now',
    'Đã có tài khoản?': 'Already have an account?',
    'Gửi mã xác minh': 'Send verification code',
    'Gửi mã xác minh email': 'Send email verification code',
    'Xác minh và tạo tài khoản': 'Verify and create account',
    'Xác minh và tiếp tục': 'Verify and continue',
    'Đổi email hoặc gửi lại mã': 'Change email or resend code',
    'Quay lại đăng nhập': 'Back to sign in',
    'Đặt mật khẩu mới': 'Set new password',
    'Chưa nhận được mã?': 'Did not receive the code?',
    'Gửi lại mã': 'Resend code',
    'Xác nhận và liên kết': 'Confirm and link accounts',
    'Hiện': 'Show',
    'Ẩn': 'Hide',
    'Hiện mật khẩu': 'Show password',
    'Ẩn mật khẩu': 'Hide password',
    'Đang đăng nhập…': 'Signing in…',
    'Đang gửi mã…': 'Sending code…',
    'Đang xác minh…': 'Verifying…',
    'Đang cập nhật…': 'Updating…',
    'Đang xử lý…': 'Processing…',
    'Chưa thể tải đăng nhập Google. Bạn vẫn có thể dùng mật khẩu bên dưới.': 'Google sign-in could not be loaded. You can still use your password below.',
    'Đã đồng ý nhận': 'Subscribed',
    'Chưa đăng ký nhận': 'Not subscribed',
    'Phân tích đánh giá sản phẩm': 'Product review analysis',
    'Tiết kiệm': 'Shop smarter',
    'cho quyết định đúng': 'with better-informed decisions',
    'Dán link sản phẩm Shopee hoặc TikTok Shop. RealView tổng hợp các đánh giá công khai, giảm nhiễu từ phản hồi ít thông tin và làm nổi bật những nhược điểm được người mua nhắc lại.': 'Paste a Shopee or TikTok Shop product link. RealView summarizes public reviews, reduces noise from low-information feedback, and highlights recurring drawbacks reported by buyers.',
    'Link sản phẩm': 'Product link',
    'Phân tích ngay': 'Analyze now',
    'RealView đang xử lý': 'RealView is processing',
    'Đang chuẩn bị kết quả cho bạn': 'Preparing your results',
    'Đang xác thực liên kết sản phẩm...': 'Validating the product link…',
    'Hệ thống đang tổng hợp đánh giá, vui lòng không thoát trang.': 'We are compiling reviews. Please keep this page open.',
    'Hỗ trợ link Shopee & TikTok Shop': 'Supports Shopee & TikTok Shop links',
    '3 lượt dùng thử không cần đăng nhập': '3 free analyses without signing in',
    'Dữ liệu công khai': 'Public data only',
    'Đã đăng nhập · phân tích không giới hạn số lượt': 'Signed in · unlimited analyses',
    'Bạn đã dùng hết 3 lượt thử. Hãy đăng ký hoặc đăng nhập để tiếp tục.': 'You have used all 3 free analyses. Sign up or sign in to continue.',
    'Chốt đơn, chốt đơn!': "It's time to shop!",
    'Mình giúp bạn check review nhé?': 'Let me help you check the reviews!',
    'Lưu theo tài khoản của bạn': 'Saved to your account',
    'Lịch sử phân tích gần đây': 'Recent analysis history',
    'Xóa tất cả': 'Clear all',
    'Kết quả phân tích review': 'Review analysis results',
    'Mở sản phẩm ↗': 'Open product ↗',
    'review đã quét': 'reviews scanned',
    'đã quét': 'scanned',
    'review giữ lại': 'reviews retained',
    'review đã loại': 'reviews excluded',
    'Điểm cần cân nhắc': 'Points to consider',
    'Chỉ tính review đã lọc': 'Based on filtered reviews only',
    'RealView giảm nhiễu thế nào?': 'How does RealView reduce noise?',
    'Các phản hồi thiếu bằng chứng trải nghiệm sẽ không được ưu tiên trong kết quả.': 'Feedback without evidence of actual product experience is deprioritized in the results.',
    'Review nhận xu / seeding': 'Incentivized or seeded reviews',
    'Khen chê một từ': 'One-word praise or criticism',
    'Chưa dùng đã đánh giá': 'Reviewed before use',
    'Kết quả chỉ hỗ trợ tham khảo; hãy kiểm tra kỹ thông tin sản phẩm trước khi mua.': 'Results are for reference only. Always verify product information before purchasing.',
    'Về RealView': 'About RealView',
    'Góc nhìn thật': 'Real insights',
    'cho lựa chọn đúng': 'for better choices',
    'RealView tổng hợp các đánh giá công khai để bạn nhìn rõ những điểm người mua thực sự nhắc tới — cả tích cực lẫn hạn chế.': 'RealView summarizes public reviews so you can clearly see what buyers actually mention—both the positives and the limitations.',
    'Cách RealView hoạt động': 'How RealView works',
    'Dán liên kết': 'Paste a link',
    'Dán link sản phẩm từ Shopee hoặc TikTok Shop.': 'Paste a product link from Shopee or TikTok Shop.',
    'Tổng hợp review': 'Collect reviews',
    'Hệ thống thu thập và chuẩn hóa các đánh giá công khai.': 'The system collects and normalizes public reviews.',
    'Lọc nhiễu': 'Reduce noise',
    'Giảm ảnh hưởng của phản hồi ít thông tin hoặc không liên quan.': 'Reduce the influence of low-information or irrelevant feedback.',
    'Đọc kết quả': 'Review the results',
    'Xem TrustScore, ưu nhược điểm và review để tự đối chiếu.': 'Review the TrustScore, pros, cons, and source reviews for yourself.',
    'Vì sao nên chọn RealView?': 'Why choose RealView?',
    'Nhìn tổng quan nhanh': 'See the big picture quickly',
    'Không cần đọc hàng trăm review để tìm các ý được nhắc lại nhiều lần.': 'No need to read hundreds of reviews to identify recurring themes.',
    'Giảm nhiễu thông tin': 'Reduce information noise',
    'Các phản hồi ít thông tin không được ưu tiên như trải nghiệm cụ thể.': 'Low-information feedback is not weighted like specific product experiences.',
    'Có bằng chứng để đối chiếu': 'Evidence you can verify',
    'Bạn vẫn có thể đọc lại các review được giữ và bị loại.': 'You can still review both retained and excluded reviews.',
    'Tính năng nổi bật': 'Key features',
    'TrustScore minh bạch': 'Transparent TrustScore',
    'Giải thích các tín hiệu ảnh hưởng tới độ tin cậy của tập review.': 'Explains which signals affect the reliability of the review set.',
    'Tóm tắt ưu và nhược điểm': 'Pros and cons summary',
    'Làm nổi bật các trải nghiệm được nhiều người mua nhắc lại.': 'Highlights experiences repeatedly mentioned by buyers.',
    'Review để kiểm chứng': 'Reviews for verification',
    'Cho phép xem dữ liệu cụ thể đằng sau phần tổng hợp.': 'Lets you inspect the specific reviews behind each summary.',
    'Câu chuyện dự án': 'Our story',
    'Hỗ trợ': 'Support',
    'Minh bạch': 'Transparency',
    'Kết quả phân tích': 'Analysis results',
    'Chỉ dùng dữ liệu công khai': 'Uses public data only',
    '“Góc nhìn thật, lựa chọn đúng.”': '“Real insights, better choices.”',
    '© 2026 RealView. Dự án học thuật của sinh viên UEH.': '© 2026 RealView. An academic project by UEH students.',
    'Chính sách bảo mật': 'Privacy Policy',
    'Điều khoản sử dụng': 'Terms of Use',
    'Chính sách và điều khoản': 'Policies and terms',
    'Liên hệ với': 'Contact',
    'Nhóm luôn sẵn sàng lắng nghe góp ý từ người dùng, giảng viên và các bên quan tâm đến dự án.': 'Our team welcomes feedback from users, lecturers, and anyone interested in the project.',
    'Gửi liên hệ cho chúng tôi': 'Send us a message',
    'Phản hồi của bạn giúp dự án hoàn thiện hơn.': 'Your feedback helps us improve the project.',
    'Họ và tên': 'Full name',
    'Nội dung': 'Message',
    'Mã gồm 6 số, có hiệu lực trong 10 phút. Nếu sửa thông tin phía trên, bạn cần nhận mã mới.': 'The 6-digit code is valid for 10 minutes. If you edit the information above, you will need a new code.',
    'Gửi liên hệ': 'Send message',
    'Đội ngũ dự án': 'Project team',
    'Thông tin liên hệ': 'Contact information',
    'Đơn vị': 'Institution',
    'Đại học Kinh tế TP.HCM': 'University of Economics Ho Chi Minh City',
    'Phạm vi': 'Scope',
    'Dự án học thuật phi lợi nhuận': 'Non-profit academic project',
    'Kết nối': 'Connect',
    'Dữ liệu phân tích được dùng để hỗ trợ tham khảo, không thay thế đánh giá trực tiếp của người mua.': 'Analysis data is provided for reference and does not replace a buyer’s own assessment.',
    'Đang gửi…': 'Sending…',
    'Xác minh và gửi': 'Verify and send',
    'Đã gửi phản hồi đến hộp thư RealView. Cảm ơn bạn đã liên hệ.': 'Your message has been sent to RealView. Thank you for contacting us.',
    'Quyết định ví tiền của bạn': 'Your purchase decisions',
    'Vì quyền lợi người tiêu dùng': 'For consumer interests',
    'Đừng để review ảo quyết định ví tiền của bạn': 'Do not let misleading reviews decide how you spend',
    'Đừng để': 'Do not let',
    'review ảo': 'misleading reviews',
    'quyết định ví tiền của bạn': 'decide how you spend',
    'RealView với một sứ mệnh duy nhất:': 'RealView has one clear mission:',
    'Bóc tách lớp vỏ bọc seeding để mang đến cho bạn': 'Cut through seeded reviews so you can make',
    'những trải nghiệm mua hàng dựa trên sự thật 100%': 'shopping decisions based on clearer evidence',
    'Thông điệp “100%” thể hiện định hướng minh bạch của dự án; kết quả phân tích luôn mang tính tham khảo.': 'The “100%” message expresses the project’s commitment to transparency; analysis results are always for reference.',
    'Tìm hiểu thuật toán': 'Explore the method',
    'Dải chỉ số uy tín RealView': 'RealView reliability indicators',
    'Đánh giá thật': 'Authentic reviews',
    'được phát hiện': 'identified',
    'Đánh giá đã': 'Reviews',
    'được phân tích': 'analyzed',
    'Đánh giá seeding': 'Seeded reviews',
    'đã được loại bỏ': 'filtered out',
    'Người dùng tin tưởng': 'Users who trust',
    'Số liệu minh họa cho định hướng sản phẩm — không phải KPI vận hành thực tế. Mốc trình bày: 06/2026.': 'These figures illustrate the product vision and are not actual operating KPIs. Reference date: 06/2026.',
    'Quy trình minh bạch': 'Transparent process',
    'Quy trình đánh giá 4 bước': 'A four-step review process',
    '4 bước': '4 steps',
    'Một quy trình minh bạch, có phương pháp và có thể kiểm chứng': 'A transparent, methodical, and verifiable process',
    'Thu thập dữ liệu': 'Collect data',
    'Thu thập review từ các nền tảng TMĐT': 'Collect reviews from e-commerce platforms',
    'Lọc & làm sạch': 'Filter and clean',
    'Loại bỏ spam, trùng lặp không liên quan': 'Remove spam and irrelevant duplicates',
    'Phân tích & chấm điểm': 'Analyze and score',
    'Phân tích nội dung, ngữ cảnh, hành vi người dùng và tín hiệu bất thường': 'Analyze content, context, user behavior, and unusual signals',
    'Phân loại & báo cáo': 'Classify and report',
    'Áp dụng thuật toán và AI độc quyền để chấm điểm độ tin cậy của review': 'Apply RealView’s analysis method to assess review reliability',
    '“AI độc quyền” là nội dung định hướng trong bản thiết kế; phiên bản thử nghiệm hiện dùng bộ quy tắc và mô hình phân tích đang được hoàn thiện.': '“Proprietary AI” describes the design direction; the current prototype uses a ruleset and an analysis model that are still being refined.',
    'Minh bạch tiêu chí': 'Transparent criteria',
    'Bộ tiêu chí đánh giá': 'Review criteria',
    'Các tiêu chí cốt lõi mà RealView sử dụng để đánh giá độ tin cậy của mỗi review': 'The core criteria RealView uses to assess each review’s reliability',
    'Review có thông tin hữu ích': 'Reviews with useful information',
    'Ưu tiên review có thông tin hữu ích (nêu rõ chất lượng, nhược điểm, không khen chung chung); loại những review ngắn': 'Prioritize useful reviews that describe quality and drawbacks instead of offering generic praise; exclude reviews that are too short.',
    'Ngôn ngữ và nội dung bất thường': 'Unusual language and content',
    'Lọc review có ngôn ngữ bất thường (nội dung mâu thuẫn với sản phẩm, ít giá trị về mặt thông tin) và nội dung trùng lặp': 'Filter reviews with unusual language, content inconsistent with the product, little informational value, or duplicate content.',
    'Ý nghĩa bị lặp lại': 'Repeated meaning',
    'Review được paraphrase lại cùng một ý nghĩa (nhiều người mua khác nhau nhưng cùng khen một điểm với một nghĩa)': 'Identify reviews that paraphrase the same idea, where different buyers praise the same point with the same meaning.',
    'Mức độ biểu đạt': 'Tone and intensity',
    'Khen chê quá mức, ngôn ngữ mang tính quảng cáo': 'Overstated praise or criticism and promotional language.',
    'Kết quả mang tính tham khảo': 'Results are for reference',
    'Không kết luận review là giả/thật 100% → Mang tính chất tham khảo dựa trên phân tích khách quan của mô hình thuật toán và AI': 'The system does not declare reviews 100% genuine or fake. Results are reference signals based on objective algorithmic and AI-assisted analysis.',
    'Độc lập trong đánh giá': 'Independent assessment',
    'Cam kết không nhận tài trợ': 'Committed to not accepting sponsorship for assessments.',
    'Dùng thử RealView ngay': 'Try RealView now',
    'Tiêu chí lọc review': 'Review filtering criteria',
    'Illustration: Katerina Limpitsouni · unDraw (human-made, sử dụng theo giấy phép unDraw)': 'Illustration: Katerina Limpitsouni · unDraw (human-made, used under the unDraw license)',
    'Illustration: unDraw · Icons: hệ SVG đồng nhất': 'Illustration: unDraw · Icons: consistent SVG system',
    'SẢN PHẨM VỪA PHÂN TÍCH': 'PRODUCT ANALYZED',
    'Phân tích từ review công khai': 'Analyzed from public reviews',
    'Xem trang sản phẩm': 'View product page',
    'MỨC ĐỘ TIN CẬY': 'RELIABILITY LEVEL',
    'Kết luận TrustScore': 'TrustScore conclusion',
    'Nhấn để xem giải thích chi tiết': 'Tap to view the detailed explanation',
    'ƯU ĐIỂM NỔI BẬT': 'KEY STRENGTHS',
    'NHƯỢC ĐIỂM CẦN CÂN NHẮC': 'DRAWBACKS TO CONSIDER',
    'Review đáng tham khảo': 'Useful reviews',
    'Review giữ lại': 'Retained reviews',
    'Review đã loại': 'Excluded reviews',
    'Phương pháp tính điểm': 'Scoring method',
    'Phân tích sản phẩm khác': 'Analyze another product',
    'Xem lịch sử phân tích': 'View analysis history',
    'Đang làm rõ tín hiệu từ các review': 'Analyzing signals across reviews',
    'Đang thu thập mẫu đánh giá công khai từ sàn.': 'Collecting public review samples from the marketplace.',
    'Đợi mình chút xíu nhé...': 'Just a moment…',
    'MẪU ĐÁNH GIÁ': 'REVIEW SAMPLE',
    'Đang kết nối nguồn': 'Connecting to source',
    'Nhận diện sản phẩm': 'Identify product',
    'Kiểm tra đúng link và thông tin sản phẩm': 'Validate the link and product information',
    'Thu thập đánh giá': 'Collect reviews',
    'Lấy mẫu và chuẩn hóa dữ liệu review': 'Sample and normalize review data',
    'Kiểm định nội dung': 'Assess content',
    'Giảm nhiễu và thẩm định ngữ nghĩa': 'Reduce noise and assess meaning',
    'Hoàn thiện kết quả': 'Finalize results',
    'Tính TrustScore và tổng hợp bằng chứng': 'Calculate TrustScore and summarize evidence',
    'Chưa thể hoàn tất phân tích': 'Unable to complete the analysis',
    'Không thể hoàn tất phân tích.': 'Unable to complete the analysis.',
    'Thử lại': 'Try again',
    'Lịch sử phân tích': 'Analysis history',
    'Đóng lịch sử': 'Close history',
    'Sản phẩm đã phân tích': 'Analyzed product',
    'Không thể tải lịch sử phân tích.': 'Could not load analysis history.',
    'Vừa xong': 'Just now',
    'Hôm qua': 'Yesterday',
    'Các báo cáo gần nhất được lưu theo tài khoản của bạn.': 'Your latest reports are saved to your account.',
    'Chưa có lịch sử': 'No history yet',
    'Hỏi Trợ lý': 'Ask the Assistant',
    'Chat với RealViewee': 'Chat with RealViewee',
    'Trò chuyện cùng RealViewee': 'Chat with RealViewee',
    'Trợ lý AI mua sắm & đánh giá của bạn': 'Your AI shopping and review assistant',
    'Xin chào! Mình có thể giải thích cách dùng RealView, ý nghĩa của TrustScore và tiêu chí lọc review.': 'Hello! I can explain how RealView works, what TrustScore means, and how reviews are filtered.',
    'Câu hỏi gợi ý': 'Suggested questions',
    'RealView hoạt động thế nào?': 'How does RealView work?',
    'TrustScore là gì?': 'What is TrustScore?',
    'Review bị loại theo tiêu chí nào?': 'How are reviews excluded?',
    'Câu hỏi dành cho RealViewee': 'Question for RealViewee',
    'Gửi câu hỏi': 'Send question',
    'Bỏ chọn sản phẩm': 'Deselect product',
    'Khoan! Check trên RealView đã!': 'Wait! Check it on RealView first!',
    'Trợ lý mua sắm & review bằng AI': 'Your AI shopping and review assistant',
    'Chỉ trả lời từ thông tin chính thức của RealView.': 'Answers are based only on official RealView information.',
    'Gửi': 'Send',
    'Đóng': 'Close',
    'Về đầu trang': 'Back to top',
    'Mở menu': 'Open menu',
    'Đóng menu': 'Close menu',
    'danh mục': 'category',
    'Mở Trợ lý RealView': 'Open the RealView Assistant',
    'Đóng Trợ lý RealView': 'Close the RealView Assistant',
    'Đóng trợ lý RealViewee': 'Close RealViewee',
    'Đóng giải thích chi tiết TrustScore': 'Close the detailed TrustScore explanation',
    'Mở giải thích chi tiết TrustScore': 'Open the detailed TrustScore explanation',
    'RealViewee tự tin với kết quả TrustScore': 'RealViewee is confident about the TrustScore result',
    'Xem chi tiết điểm nha!': 'See the score details!',
    'RealViewee bất ngờ với các đánh giá đáng tham khảo': 'RealViewee is impressed by the useful reviews',
    'Góc review chân thực!': 'Useful review highlights!',
    'RealViewee lưu ý các đánh giá đã bị loại': 'RealViewee points out the excluded reviews',
    'Review này hơi ảo!': 'This review looks questionable!',
    'RealViewee hào hứng với sản phẩm đối chiếu': 'RealViewee is excited about the comparison product',
    'Bắt đúng sản phẩm!': 'Matching product found!',
    'sản phẩm này': 'this product',
    'Câu trả lời chỉ dựa trên kết quả và review đã phân tích.': 'Answers are based only on the analyzed results and reviews.',
    'Đang đồng bộ dữ liệu sản phẩm…': 'Syncing product data…',
    'Chưa thể đọc dữ liệu sản phẩm này': 'This product data could not be loaded',
    'Kho dữ liệu RealView': 'RealView knowledge base',
    'Trợ lý đang trả lời': 'The assistant is responding',
    'Không thể kết nối Trợ lý RealView.': 'Could not connect to the RealView Assistant.',
    'Mình chưa có thông tin này trong kho dữ liệu RealView. Bạn có thể liên hệ đội ngũ để được hỗ trợ.': 'I do not have this information in RealView’s knowledge base. Please contact the team for support.',
    'Hiện mình chưa thể kết nối. Bạn vui lòng thử lại sau hoặc liên hệ đội ngũ RealView.': 'I cannot connect right now. Please try again later or contact the RealView team.',
    'Sản phẩm trong lịch sử': 'Product from history',
    'Mở trang Liên hệ RealView': 'Open the RealView contact page',
    'Trang Liên hệ RealView': 'RealView Contact page',
    'Link không đúng định dạng. Hãy sao chép lại từ Shopee hoặc TikTok Shop.': 'The link format is invalid. Copy it again from Shopee or TikTok Shop.',
    'Link sản phẩm phải sử dụng kết nối HTTPS an toàn.': 'Product links must use a secure HTTPS connection.',
    'Link chứa thông tin kết nối không được hỗ trợ.': 'Links containing connection credentials are not supported.',
    'RealView hiện chỉ hỗ trợ link sản phẩm Shopee hoặc TikTok Shop.': 'RealView currently supports only Shopee or TikTok Shop product links.',
    'Không tải được Google. Vui lòng kiểm tra kết nối rồi thử lại.': 'Google could not be loaded. Check your connection and try again.',
    'Google chưa sẵn sàng. Vui lòng thử lại.': 'Google is not ready. Please try again.',
    'Không tải được Google. Bạn vẫn có thể đăng nhập bằng mật khẩu bên dưới.': 'Google could not be loaded. You can still sign in with your password below.',
    'Chưa thể kết nối với Google. Bạn có thể thử lại hoặc dùng mật khẩu RealView.': 'Could not connect to Google. Try again or use your RealView password.',
    'RealView - Trang chủ': 'RealView - Home',
    'Trợ lý mua sắm RealViewee': 'RealViewee shopping assistant',
    'Mở Chat with RealViewee': 'Open chat with RealViewee',
    'Minh họa người mua đang kiểm tra đánh giá sản phẩm': 'Illustration of a shopper checking product reviews',
    'Minh họa một người đang xem thông tin trên điện thoại': 'Illustration of a person viewing information on a phone',
    'Sơ đồ dự án RealView': 'RealView project overview',
    '9 thành viên xác định 4 vấn đề chính và cùng hướng tới 1 mục tiêu': '9 team members identified 4 core challenges and share 1 goal',
    'Quy trình sử dụng RealView': 'How to use RealView',
    'Bản xem trước giao diện kết quả phân tích hiện tại của RealView': 'Preview of RealView’s current analysis results interface',
    'Minh họa thủ công về sản phẩm đang được phân tích': 'Illustration of a product being analyzed',
    'Minh họa thủ công về người dùng đang đọc đánh giá trực tuyến': 'Illustration of a shopper reading online reviews',
    'Người mua đang xem đánh giá sản phẩm trực tuyến': 'Shopper reading online product reviews',
    'Minh họa người dùng gửi phản hồi và đánh giá': 'Illustration of a user submitting feedback and reviews',
    'Điều hướng chính': 'Main navigation',
    'Thao tác với kết quả': 'Result actions',
    'Tiến độ phân tích': 'Analysis progress',
    'Chính sách bảo mật RealView': 'RealView Privacy Policy',
    'Tìm hiểu cách RealView sử dụng thông tin tài khoản, lịch sử phân tích, review công khai, cookies và cách yêu cầu hỗ trợ về dữ liệu.': 'Learn how RealView uses account information, analysis history, public reviews, and cookies, and how to request data support.',
    'Điều khoản sử dụng RealView': 'RealView Terms of Use',
    'Cập nhật gần nhất': 'Last updated',
    'Mục lục': 'Contents',
    'Đường dẫn trang': 'Breadcrumb',
    'Mục lục Chính sách bảo mật': 'Privacy Policy contents',
    'Mục lục Điều khoản sử dụng': 'Terms of Use contents',
    'Nội dung Chính sách bảo mật': 'Privacy Policy content',
    'Nội dung Điều khoản sử dụng': 'Terms of Use content',
    'Đọc tiếp': 'Continue reading',
    'Đọc Chính sách bảo mật': 'Read the Privacy Policy',
    'Đọc Điều khoản sử dụng': 'Read the Terms of Use',
    'Cập nhật chính sách': 'Policy updates',
    'Thông tin chúng tôi thu thập': 'Information we collect',
    'Cách chúng tôi sử dụng thông tin': 'How we use information',
    'Cách chúng tôi chia sẻ thông tin': 'How we share information',
    'Phạm vi & liên hệ': 'Scope & contact',
    'Dữ liệu được xử lý': 'Data processed',
    'Mục đích sử dụng': 'Purposes of use',
    'Cookies & lưu trên máy': 'Cookies & on-device storage',
    'Nhà cung cấp & chia sẻ': 'Providers & sharing',
    'Thời hạn lưu & bảo vệ': 'Retention & protection',
    'Lựa chọn & yêu cầu dữ liệu': 'Choices & data requests',
    'Thời gian lưu trữ dữ liệu': 'Data retention',
    'Quyền và lựa chọn của bạn': 'Your rights and choices',
    'Bảo mật dữ liệu': 'Data security',
    'Quyền riêng tư của trẻ em': 'Children’s privacy',
    'Thay đổi chính sách': 'Policy changes',
    'Liên hệ với chúng tôi': 'Contact us',
    'Chấp nhận điều khoản': 'Acceptance of terms',
    'Mô tả dịch vụ': 'Service description',
    'Trách nhiệm của người dùng': 'User responsibilities',
    'Giới hạn trách nhiệm': 'Limitation of liability',
    'Quyền sở hữu trí tuệ': 'Intellectual property',
    'Chấm dứt sử dụng': 'Termination',
    'Luật áp dụng': 'Governing law',
    'Về chúng tôi': 'About us',
    'Dự án học thuật, bài toán thực tế': 'An academic project solving a real problem',
    'Về': 'About',
    'RealView là dự án của nhóm sinh viên Đại học Kinh tế TP.HCM (UEH), được phát triển trong môn Digital Marketing. Nhóm muốn giúp người mua nhìn nhanh vào trải nghiệm thực tế thay vì phải đọc hàng trăm bình luận rời rạc.': 'RealView is a project by students at the University of Economics Ho Chi Minh City (UEH), developed as part of a Digital Marketing course. We want to help shoppers understand real buyer experiences without reading hundreds of scattered comments.',
    'Bối cảnh': 'Context',
    'Mua sắm online thuận tiện nhưng đánh giá sản phẩm thường dài, lặp lại và có chất lượng thông tin không đồng đều.': 'Online shopping is convenient, but product reviews are often lengthy, repetitive, and inconsistent in quality.',
    'Vấn đề nhóm quan sát': 'What we observed',
    'Nhiều review nhưng khó đọc hết': 'Too many reviews to read',
    'Khó nhận biết giữa review thật và review seeding': 'Hard to distinguish genuine feedback from seeded reviews',
    'Rating cao nhưng rất nhiều nhược điểm': 'High ratings can still hide recurring drawbacks',
    'Người mua tốn thời gian ra quyết định': 'Shoppers spend too much time deciding',
    'Mục tiêu của dự án': 'Project goals',
    'Tiết kiệm thời gian đọc review': 'Save time reading reviews',
    'Chỉ ra những nhược điểm quan trọng của sản phẩm': 'Highlight important product drawbacks',
    'Giúp người mua cân nhắc nhanh hơn, kỹ hơn': 'Help shoppers decide faster and more carefully',
    'thành viên': 'team members',
    'vấn đề chính': 'core challenges',
    'mục tiêu': 'goal',
    'Góc nhìn rõ hơn trước khi mua': 'A clearer view before you buy',
    'Dự án học thuật': 'An academic project',
    'hướng tới khả năng phát triển thành sản phẩm thực tế.': 'designed with the potential to become a real-world product.',
    'Nhanh chóng, đơn giản và minh bạch': 'Fast, simple, and transparent',
    'Sao chép link': 'Copy the link',
    'Sao chép đường dẫn sản phẩm từ Shopee hoặc TikTok Shop.': 'Copy a product link from Shopee or TikTok Shop.',
    'Dán vào RealView': 'Paste it into RealView',
    'Đưa link vào ô phân tích ở đầu trang.': 'Paste the link into the analysis field at the top of the page.',
    'Thu thập review': 'Collect reviews',
    'Hệ thống lấy dữ liệu từ nguồn được cấu hình.': 'The system retrieves data from the configured source.',
    'Lọc tín hiệu nhiễu': 'Filter noisy signals',
    'Giảm ưu tiên phản hồi ngắn và ít thông tin.': 'Deprioritize short, low-information feedback.',
    'Tóm tắt nhược điểm': 'Summarize drawbacks',
    'Nhóm các ý kiến giống nhau để dễ đọc.': 'Group similar feedback so it is easier to review.',
    'Ra quyết định': 'Make your decision',
    'Đối chiếu kết quả với nhu cầu của bạn.': 'Compare the results with your own needs.',
    'giúp bạn mua sắm thông minh hơn mỗi ngày': 'helps you shop smarter every day',
    'Website sử dụng công nghệ AI lọc đánh giá ảo, tóm tắt các phản hồi thực tế từ người dùng thật, giúp bạn tiết kiệm thời gian, tránh rủi ro và đưa ra quyết định chính xác khi mua sắm.': 'The website uses AI-assisted analysis to reduce unreliable feedback and summarize useful buyer experiences, helping you save time, reduce risk, and make better-informed purchases.',
    'Thông tin đáng tin cậy': 'More reliable information',
    'Chỉ hiển thị các đánh giá chân thực, đã được sàng lọc và đánh giá chính xác.': 'Prioritizes substantive reviews after applying transparent filters.',
    'Tiết kiệm thời gian': 'Save time',
    'Giúp bạn phân tích và đánh giá nhanh dựa trên những ý kiến có giá trị.': 'Quickly understand the product through useful buyer feedback.',
    'Quyết định chính xác': 'Better-informed decisions',
    'Cung cấp thông tin khách quan giúp bạn mua đúng sản phẩm phù hợp nhu cầu.': 'Provides clearer information to help you choose products that match your needs.',
    'Mua sắm thông minh': 'Shop smarter',
    'Đưa ra khuyến nghị dựa trên mức độ uy tín của sản phẩm.': 'Supports your decision with evidence from the review set.',
    'Những tính năng nổi bật của': 'Key features of',
    'Sản phẩm vừa phân tích': 'Product analyzed',
    'Dữ liệu review đã lọc': 'Filtered review data',
    'Sản phẩm đang phân tích trên Shopee': 'Product being analyzed on Shopee',
    '99 review công khai đã được kiểm tra': '99 public reviews checked',
    'Mức tin cậy rất cao': 'Very high reliability',
    'Kết luận nhanh': 'Quick conclusion',
    'Các review đủ điều kiện khá nhất quán, có nội dung dễ đối chiếu và ít dấu hiệu bất thường.': 'Eligible reviews are fairly consistent, easy to verify, and show few unusual signals.',
    'TrustScore đánh giá độ tin cậy của review': 'TrustScore measures review reliability',
    'Đây không phải điểm chất lượng sản phẩm.': 'It is not a product quality score.',
    'đáng tham khảo': 'useful',
    'bị loại': 'excluded',
    'Giao diện này mô phỏng đúng trang Results hiện tại của RealView.': 'This preview reflects RealView’s current Results page.',
    'Phân tích AI thông minh': 'AI-assisted analysis',
    'AI lọc bỏ review ảo, nhận diện seeding và phân tích cảm xúc đánh giá.': 'AI helps detect suspicious patterns, seeded feedback, and review sentiment.',
    'Lọc review ảo hiệu quả': 'Effective noise filtering',
    'Loại bỏ các bình luận spam, seeding, đánh giá nhận xu hoặc không liên quan.': 'Filters spam, seeded content, incentivized reviews, and irrelevant comments.',
    'Tóm tắt nhanh & dễ hiểu': 'Fast, clear summaries',
    'Hiển thị ưu điểm, nhược điểm nổi bật giúp bạn nắm bắt thông tin nhanh chóng.': 'Highlights recurring strengths and drawbacks so you can understand the feedback quickly.',
    'Điểm số theo thang 100 phản ánh độ tin cậy của tập review, không phải chất lượng sản phẩm.': 'A score out of 100 reflects the reliability of the review set, not product quality.',
    'Blog & chia sẻ kiến thức': 'Blog & practical guides',
    'Cập nhật mua sắm thông minh, cách nhận biết sản phẩm tốt và tránh rủi ro khi mua online.': 'Learn smarter shopping practices, how to assess products, and how to reduce online shopping risks.',
    'Phân tích đang diễn ra': 'ANALYSIS IN PROGRESS',
    'RealView đang xác thực liên kết sản phẩm.': 'RealView is validating the product link.',
    'Thời gian đã xử lý': 'Processing time',
    'Đợi mình chút xíu nhé': 'Just a moment',
    'Đang nhận diện sàn': 'Identifying marketplace',
    'Đang nhận diện sản phẩm…': 'Identifying product…',
    'Tên và hình ảnh sẽ xuất hiện ngay khi nguồn dữ liệu phản hồi.': 'The product name and image will appear as soon as the data source responds.',
    'Mẫu đánh giá': 'Review sample',
    'Nguồn dữ liệu đang phản hồi chậm hơn thường lệ. Bạn có thể giữ trang này mở; tiến trình vẫn đang tiếp tục.': 'The data source is responding more slowly than usual. You can keep this page open while processing continues.',
    'Đăng ký / Đăng nhập': 'Sign up / Sign in',
    'Nhập link khác': 'Enter another link',
    'Chưa có sản phẩm để phân tích.': 'No product has been submitted for analysis.',
    'Hãy dán link sản phẩm trên trang chủ. RealView sẽ lọc review, tính TrustScore và giải thích kết quả.': 'Paste a product link on the homepage. RealView will filter the reviews, calculate TrustScore, and explain the result.',
    'Phân tích sản phẩm': 'Analyze a product',
    'Sản phẩm trên Shopee': 'Product on Shopee',
    'Dữ liệu review công khai': 'Public review data',
    'Đang tìm sản phẩm tương tự trên nền tảng khác': 'Looking for a similar product on another marketplace',
    'RealView đang đối chiếu hình ảnh và thông tin sản phẩm': 'RealView is comparing product images and details',
    'Nhấn để xem và đối chiếu hai sản phẩm': 'Open to view and compare both products',
    'Chưa tìm thấy sản phẩm tương tự phù hợp': 'No suitable similar product was found',
    'Tìm kiếm đang tạm dừng, bạn có thể thử lại sau': 'Search is paused. You can try again later.',
    'Bạn vẫn có thể tiếp tục xem kết quả phân tích hiện tại': 'You can still continue viewing the current analysis result.',
    'Chưa lấy được ảnh sản phẩm để đối chiếu': 'The product image is not yet available for comparison',
    'Kết quả gần giống nhất': 'Closest match',
    'Sản phẩm vừa phân tích': 'Product analyzed',
    'Đối chiếu từ nền tảng gốc sang nền tảng còn lại': 'Compare the original marketplace with the other marketplace',
    'Đối chiếu hai sản phẩm': 'Compare two products',
    'Mở sản phẩm tương tự': 'Open similar product',
    'Đã tạm dừng tìm kiếm': 'Search paused',
    'Vui lòng thử lại sau ít phút.': 'Please try again in a few minutes.',
    'Chưa tìm thấy sản phẩm đủ giống': 'No sufficiently similar product was found',
    'RealView không hiển thị kết quả khi hình ảnh chưa đủ tin cậy.': 'RealView does not display a match when image similarity is not reliable enough.',
    'Chưa đủ dữ liệu để tìm kiếm': 'Not enough data to search',
    'Tên sản phẩm hiện chưa cung cấp đủ tín hiệu đối chiếu.': 'The product name does not yet provide enough information for comparison.',
    'Tìm kiếm chưa hoàn tất': 'Search is not complete',
    'Dịch vụ đối chiếu đang tạm thời không phản hồi.': 'The comparison service is temporarily unavailable.',
    'Tìm kiếm đang tạm dừng': 'Search is paused',
    'Hệ thống lưu trạng thái hiện chưa sẵn sàng.': 'The status storage service is not currently available.',
    'Chưa tìm thấy sản phẩm tương tự': 'No similar product was found',
    'Mức độ tin cậy': 'Reliability level',
    'Mức tin cậy rất cao': 'Very high reliability',
    'Mức tin cậy khá tốt': 'Good reliability',
    'Mức tin cậy trung bình': 'Moderate reliability',
    'Mức tin cậy thấp': 'Low reliability',
    'Xem cách tính điểm': 'View scoring method',
    'MINH BẠCH CÁCH CHẤM': 'TRANSPARENT SCORING',
    'Cách tính TrustScore': 'How TrustScore is calculated',
    'Công thức dùng ba tỷ lệ đầu để tạo điểm cơ sở, sau đó xét độ phủ mẫu.': 'The first three ratios form the base score, which is then adjusted for sample coverage.',
    'Kiểm tra': 'Verification',
    'Độ phủ': 'Coverage',
    'TrustScore cơ sở': 'Base TrustScore',
    'TrustScore sau độ phủ mẫu': 'TrustScore after coverage adjustment',
    'Kết quả sau khi làm tròn': 'Rounded result',
    'Đây là cách diễn giải đã được đơn giản hóa để dễ hiểu. Hệ thống thực tế còn cân bằng người đánh giá, nhóm sao, nội dung trùng và trường hợp thiếu dữ liệu trước khi công bố điểm.': 'This is a simplified explanation. Before publishing the score, the system also balances reviewers, rating groups, duplicate content, and incomplete data.',
    'Đang đánh giá': 'Assessing',
    'Chưa đủ review có nội dung chữ để công bố TrustScore.': 'There are not enough written reviews to publish a TrustScore.',
    'RealView cần ít nhất 20 review có nội dung chữ trước khi hiển thị điểm.': 'RealView needs at least 20 written reviews before displaying a score.',
    'Không có điều chỉnh bổ sung nào làm thay đổi điểm sau bước tổng hợp.': 'No additional adjustment changed the score after aggregation.',
    'Ba tỷ lệ đầu tạo mức tin cậy ban đầu, độ phủ mẫu cho biết điểm có cần được điều chỉnh thận trọng hay không.': 'The first three ratios establish the initial reliability level, while sample coverage indicates whether the score needs a cautious adjustment.',
    'Chưa đủ bằng chứng': 'Insufficient evidence',
    'Chưa đủ bằng chứng để tính TrustScore': 'Insufficient evidence to calculate TrustScore',
    'Độ tin cậy cao': 'High reliability',
    'Khá đáng tin': 'Fairly reliable',
    'Nên cân nhắc kỹ': 'Consider carefully',
    'Độ tin cậy thấp': 'Low reliability',
    'Tập review có độ tin cậy cao, bạn có thể dùng kết quả này làm cơ sở cân nhắc sản phẩm.': 'The review set has high reliability and can be used as a basis when considering the product.',
    'Tập review khá đáng tin, bạn có thể tham khảo để cân nhắc sản phẩm nhưng nên đọc kỹ các điểm chưa đồng nhất.': 'The review set is fairly reliable and can inform your decision, but you should still examine any inconsistent findings carefully.',
    'Tập review có độ tin cậy trung bình, hãy xem đây là nguồn tham khảo và kiểm tra kỹ các review liên quan trước khi quyết định.': 'The review set has moderate reliability. Treat it as a reference and carefully examine the relevant reviews before deciding.',
    'Tập review có độ tin cậy thấp, bạn chưa nên dựa chủ yếu vào kết quả này để quyết định mua.': 'The review set has low reliability and should not be your primary basis for a purchase decision.',
    'Backend chưa cung cấp đủ dữ liệu để tính TrustScore. Bạn vẫn có thể đọc các review đã lọc, nhưng giao diện không tự suy ra điểm từ số sao.': 'The backend did not provide enough data to calculate TrustScore. You can still read the filtered reviews, but the interface will not infer a score from star ratings.',
    'Phản hồi tích cực': 'Positive feedback',
    'Các review này ghi nhận trải nghiệm tích cực với sản phẩm.': 'These reviews describe positive experiences with the product.',
    'Phản hồi cần cân nhắc': 'Feedback to consider',
    'Các review này nêu trải nghiệm chưa tốt hoặc điểm cần cân nhắc.': 'These reviews describe poor experiences or points to consider.',
    'Tỷ lệ review hữu ích': 'Useful review ratio',
    'Khả năng kiểm chứng': 'Verifiability',
    'Nguồn dữ liệu không cung cấp trạng thái xác minh mua hàng. Hệ thống không tự suy diễn.': 'The data source does not provide purchase-verification status. The system does not infer it.',
    'Review đã bị loại': 'Excluded reviews',
    'Củng cố': 'Strengthens',
    'Hạ điểm': 'Lowers score',
    'Trung lập': 'Neutral',
    'Yếu tố củng cố độ tin cậy': 'Factors strengthening reliability',
    'Những tín hiệu giúp tập review đáng tin hơn.': 'Signals that make the review set more reliable.',
    'Chưa ghi nhận yếu tố củng cố nổi bật.': 'No notable strengthening factor was identified.',
    'Yếu tố làm giảm độ tin cậy': 'Factors lowering reliability',
    'Những tín hiệu trực tiếp kéo TrustScore xuống.': 'Signals that directly lower the TrustScore.',
    'Chưa ghi nhận yếu tố làm giảm điểm.': 'No score-lowering factor was identified.',
    'Yếu tố trung lập': 'Neutral factors',
    'Thông tin giúp hiểu bối cảnh nhưng không trực tiếp nâng hoặc hạ điểm.': 'Contextual information that does not directly raise or lower the score.',
    'Chưa ghi nhận yếu tố trung lập.': 'No neutral factor was identified.',
    'Chưa có đủ dữ liệu để giải thích các tín hiệu TrustScore.': 'There is not enough data to explain the TrustScore signals.',
    'Đây là phần review còn lại sau khi bỏ nội dung trùng, quảng cáo, lạc đề hoặc quá ngắn. Mức này đang củng cố TrustScore.': 'This is the share of reviews remaining after duplicate, promotional, irrelevant, or overly short content was removed. This level strengthens the TrustScore.',
    'Đây là phần review còn lại sau khi bỏ nội dung trùng, quảng cáo, lạc đề hoặc quá ngắn. Mức này còn thấp và đang giới hạn TrustScore.': 'This is the share of reviews remaining after duplicate, promotional, irrelevant, or overly short content was removed. This level remains low and limits the TrustScore.',
    'Đây là tỷ lệ review mô tả trải nghiệm đủ rõ để người mua đối chiếu. Mức này đang củng cố TrustScore.': 'This is the share of reviews that describe the experience clearly enough for buyers to assess. This level strengthens the TrustScore.',
    'Đây là tỷ lệ review mô tả trải nghiệm đủ rõ để người mua đối chiếu. Mức này còn thấp và đang giới hạn TrustScore.': 'This is the share of reviews that describe the experience clearly enough for buyers to assess. This level remains low and limits the TrustScore.',
    'Đây là tỷ lệ review đã nhận được kết quả kiểm tra nội dung. Mức này đang củng cố TrustScore.': 'This is the share of reviews that received a content-check result. This level strengthens the TrustScore.',
    'Đây là tỷ lệ review đã nhận được kết quả kiểm tra nội dung. Mức này còn thấp và đang giới hạn TrustScore.': 'This is the share of reviews that received a content-check result. This level remains low and limits the TrustScore.',
    'Mẫu review đủ rộng nên không làm giảm điểm sau bước tổng hợp.': 'The review sample is broad enough, so it does not reduce the score after aggregation.',
    'Số review có nội dung chưa đủ để công bố TrustScore.': 'There are not enough written reviews to publish a TrustScore.',
    'Mẫu chưa đủ rộng nên phần điểm cao được điều chỉnh xuống để tránh kết luận quá chắc chắn.': 'The sample is not broad enough, so the higher portion of the score is adjusted downward to avoid an overly confident conclusion.',
    'TrustScore vẫn được công bố, nhưng nên được xem là kết quả tạm thời.': 'The TrustScore is still published, but it should be treated as a provisional result.',
    'Người mua Shopee': 'Shopee buyer',
    'Nội dung chưa đủ thông tin để đưa vào kết quả chính.': 'This content does not contain enough information for the main result.',
    'Đã xác minh mua hàng': 'Verified purchase',
    'Chưa có tín hiệu xác minh': 'No verification signal',
    'Không rõ ngày': 'Date unavailable',
    'Review không có nội dung chữ.': 'The review has no written content.',
    'Chưa có review đủ điều kiện': 'No eligible reviews yet',
    'Không có review nào bị loại': 'No reviews were excluded',
    'Mẫu dữ liệu hiện tại chưa có phản hồi đủ chi tiết.': 'The current sample does not contain sufficiently detailed feedback.',
    'Tất cả review thu thập được đều vượt qua bước giảm nhiễu.': 'All collected reviews passed the noise-reduction step.',
    'Không có review để chuyển': 'No reviews to show',
    'chủ đề đã chọn': 'selected topic',
    'Gemini AI + bộ lọc RealView': 'Gemini AI + RealView filters',
    'Bộ lọc minh bạch RealView': 'Transparent RealView filters',
    'Chưa đủ dữ liệu để tính': 'Not enough data to calculate',
    'Chưa đủ dữ liệu': 'Not enough data',
    'Vẫn đang xử lý những đánh giá cuối cùng. Bạn có thể giữ trang này mở.': 'The final reviews are still being processed. You can keep this page open.',
    'Đã nhận diện sản phẩm': 'Product identified',
    'Đã xác nhận đúng sản phẩm. Đang thu thập các đánh giá công khai.': 'The product has been confirmed. Collecting public reviews.',
    'sản phẩm đang phân tích': 'product being analyzed',
    'Đang lấy dữ liệu review của sản phẩm.': 'Retrieving product review data.',
    'Đang giảm nhiễu và thẩm định ý nghĩa của từng review.': 'Reducing noise and assessing the meaning of each review.',
    'Đang tính TrustScore và tổng hợp các bằng chứng quan trọng.': 'Calculating TrustScore and summarizing the key evidence.',
    'Không thể mở luồng phân tích.': 'Could not start the analysis stream.',
    'Trình duyệt không hỗ trợ nhận tiến trình trực tiếp.': 'This browser does not support live progress updates.',
    'Đã hoàn tất bước kiểm định nội dung.': 'Content assessment is complete.',
    'Luồng phân tích kết thúc trước khi có kết quả.': 'The analysis stream ended before a result was available.',
    'Nguồn review của sàn đang được bảo trì.': 'The marketplace review source is under maintenance.',
    'Tiến trình đã dừng trước khi có kết quả.': 'Processing stopped before a result was available.',
    'lấy review': 'collect reviews',
    'Đã hết lượt dùng thử': 'Free analyses used up',
    'Có lỗi khi phân tích sản phẩm.': 'An error occurred while analyzing the product.',
    'Đăng ký hoặc đăng nhập để tiếp tục phân tích không giới hạn số lượt.': 'Sign up or sign in to continue analyzing without the trial limit.',
    'RealView đang tổng hợp chất lượng và độ tin cậy của các review.': 'RealView is assessing the quality and reliability of the review set.',
    'GIẢI THÍCH NHANH': 'QUICK EXPLANATION',
    'Điểm số được hình thành thế nào?': 'How is the score calculated?',
    'Các tỷ lệ dưới đây được lấy trực tiếp từ kết quả kiểm tra của hệ thống.': 'The ratios below come directly from the system’s checks.',
    'Nội dung rõ, hữu ích': 'Clear, useful content',
    'Review vượt lọc nhiễu': 'Reviews passing the noise filter',
    'Đã có kết quả kiểm tra': 'Verification completed',
    'Độ phủ của mẫu': 'Sample coverage',
    '01 · Tóm tắt review': '01 · Review summary',
    'Điều người mua thực sự nói': 'What buyers are actually saying',
    'Xem nhanh các chủ đề nổi bật và bấm vào số liệu để kiểm chứng.': 'Scan the key topics and select a count to inspect the supporting reviews.',
    'AI + bộ lọc RealView': 'AI + RealView filters',
    'Một review có thể nhắc nhiều chủ đề, vì vậy các lượt đề cập không cộng thành tổng mẫu.': 'One review may mention several topics, so mention counts do not add up to the sample total.',
    'Điểm cộng': 'Strengths',
    'Người mua đánh giá tốt điều gì?': 'What do buyers like?',
    'Điểm trừ': 'Drawbacks',
    'Điều gì khiến người mua chưa hài lòng?': 'What are buyers dissatisfied with?',
    'Lọc nhiễu trước, tổng hợp sau.': 'Filter noise first, summarize second.',
    'Review quá ngắn, nhận xu hoặc chưa dùng sản phẩm không được dùng làm bằng chứng chính.': 'Reviews that are too short, incentivized, or written before product use are not used as primary evidence.',
    '02 · Giải thích điểm số': '02 · Score explanation',
    'Đối chiếu từng tín hiệu': 'Inspect each signal',
    'Bốn tín hiệu dưới đây cho biết vì sao TrustScore tăng, giảm hoặc được điều chỉnh thận trọng.': 'The four signals below explain why TrustScore rises, falls, or receives a cautious adjustment.',
    '03 · Bằng chứng review': '03 · Review evidence',
    'Tự kiểm tra trước khi quyết định': 'Verify the evidence before deciding',
    'Hai nhóm review được thu gọn để trang dễ đọc. Mở từng nhóm khi bạn muốn xem chi tiết.': 'The two review groups are collapsed for readability. Open either group to inspect the details.',
    'Được dùng làm bằng chứng': 'Used as evidence',
    'Đánh giá đáng tham khảo': 'Useful reviews',
    'Đang tải review': 'Loading reviews',
    'Không dùng để kết luận sản phẩm': 'Not used to draw product conclusions',
    'Đánh giá đã bị loại': 'Excluded reviews',
    'Các review này vẫn được công khai để bạn biết RealView đã loại nội dung nào và vì sao.': 'These reviews remain visible so you can see what RealView excluded and why.',
    '04 · Đối chiếu giữa hai sàn': '04 · Cross-marketplace comparison',
    'Sản phẩm gần giống nhất trên': 'Closest matching product on',
    'sàn khác': 'another marketplace',
    'So sánh ảnh và thông tin sản phẩm trước khi bạn quyết định phân tích thêm.': 'Compare the image and product details before starting another analysis.',
    'Trước khi xem kết quả': 'Before viewing the result',
    'TrustScore nói gì?': 'What does TrustScore mean?',
    'Đây là điểm độ tin cậy của': 'It measures the reliability of the',
    'tập review': 'review set',
    ', không phải điểm chất lượng sản phẩm.': ', not the quality of the product.',
    'Nội dung càng rõ và ít nhiễu, điểm càng được củng cố.': 'Clearer, less noisy content strengthens the score.',
    'Mẫu thiếu độ phủ hoặc nhiều review bị loại sẽ làm điểm thận trọng hơn.': 'Limited coverage or many excluded reviews makes the score more cautious.',
    'Bạn vẫn có thể mở review gốc để tự kiểm chứng.': 'You can always open the source reviews and verify them yourself.',
    'Đã hiểu': 'Got it',
    'Đã tìm thấy sản phẩm tương tự': 'Similar product found',
    'Sẵn sàng để bạn đối chiếu': 'Ready for comparison',
    'Đánh giá': 'Rating',
    'Giá': 'Price',
    'Phân tích sản phẩm này': 'Analyze this product',
    'Bạn vẫn có thể đối chiếu sản phẩm; nếu chọn phân tích, RealView sẽ thông báo trạng thái bảo trì.': 'You can still compare the products; if you start an analysis, RealView will display the maintenance status.',
    'Sản phẩm đáp ứng ngưỡng dữ liệu ban đầu để bắt đầu phân tích.': 'The product meets the initial data threshold for analysis.',
    'Bạn vẫn có thể phân tích; RealView sẽ dừng và thông báo nếu không đủ 20 review có nội dung như khi dán link ở trang chủ.': 'You can still start an analysis; RealView will stop and notify you if there are fewer than 20 written reviews, just as it does for links submitted on the homepage.',
    'Đóng cửa sổ tài khoản': 'Close account dialog',
    'Chào mừng bạn trở lại': 'Welcome back',
    'Đăng nhập để tiếp tục xem lịch sử phân tích.': 'Sign in to continue viewing your analysis history.',
    'Vui lòng đăng ký tài khoản để kích hoạt tính năng lịch sử phân tích.': 'Please sign up for an account to enable analysis history.',
    'Thử lại với Google': 'Try Google again',
    'Đăng nhập Google tạm thời không khả dụng.': 'Google sign-in is temporarily unavailable.',
    'Đưa các kết quả dùng thử trên thiết bị này vào lịch sử tài khoản': 'Add trial results from this device to your account history',
    'Email này dùng cho hồ sơ tài khoản và thông báo dịch vụ như thư chào mừng hoặc khôi phục mật khẩu.': 'This email is used for your account profile and service messages such as welcome and password recovery emails.',
    'Đồng ý nhận email marketing từ RealView (không bắt buộc)': 'Receive marketing emails from RealView (optional)',
    'Tin hướng dẫn đọc review, cập nhật tính năng và nội dung hữu ích. Lựa chọn này không ảnh hưởng việc tạo tài khoản.': 'Tips for reading reviews, feature updates, and useful content. This choice does not affect account creation.',
    'Mã gồm 6 số, có hiệu lực trong 10 phút và chỉ dùng được một lần.': 'The 6-digit code is valid for 10 minutes and can only be used once.',
    'Mã có hiệu lực trong 10 phút. Nếu trước đây chỉ dùng Google, bạn có thể xác minh email để thêm mật khẩu RealView. Mật khẩu Google không thay đổi.': 'The code is valid for 10 minutes. If you previously used only Google, you can verify your email to add a RealView password. Your Google password will not change.',
    'Email tài khoản': 'Account email',
    'Xác minh bằng mã gửi đến email này trước khi cập nhật mật khẩu RealView. Việc này không thay đổi mật khẩu Google.': 'Verify the code sent to this email before updating your RealView password. This does not change your Google password.',
    'Mã dùng một lần, hết hạn sau 10 phút. Gửi lại sau ít nhất 60 giây; mã cũ sẽ hết hiệu lực. Các phiên đăng nhập cũ sẽ được đăng xuất khi mật khẩu cập nhật.': 'The one-time code expires after 10 minutes. You can request another after 60 seconds; the previous code will become invalid. Existing sessions will be signed out after the password is updated.',
    'Email này đã có tài khoản RealView. Nhập mật khẩu RealView của tài khoản đó để xác nhận liên kết. Lịch sử của bạn được giữ nguyên.': 'A RealView account already uses this email. Enter that account’s RealView password to confirm the link. Your history will be preserved.',
    'Mật khẩu RealView': 'RealView password',
    'Quên mật khẩu RealView?': 'Forgot your RealView password?',
    'Google chưa đủ thông tin để xác minh quyền sở hữu email này. RealView sẽ gửi thêm một mã xác minh; không yêu cầu tạo mật khẩu.': 'Google did not provide enough information to verify ownership of this email. RealView will send an additional verification code; you do not need to create a password.',
    'Mã có hiệu lực trong 10 phút và chỉ dùng được một lần.': 'The code is valid for 10 minutes and can only be used once.',
    'Khi tiếp tục, bạn đồng ý với': 'By continuing, you agree to the',
    'và xác nhận đã đọc': 'and acknowledge that you have read the',
    'Chuẩn bị đăng nhập Google…': 'Preparing Google sign-in…',
    'Tạo tài khoản RealView': 'Create a RealView account',
    'Lưu lịch sử phân tích riêng theo tài khoản của bạn.': 'Save your analysis history securely to your account.',
    'Xác minh email': 'Verify your email',
    'Nhập mã đã gửi đến email để hoàn tất tạo tài khoản.': 'Enter the code sent to your email to finish creating your account.',
    'Khôi phục mật khẩu': 'Recover your password',
    'Nhập email đã đăng ký để nhận mã xác minh.': 'Enter your registered email to receive a verification code.',
    'Đổi mật khẩu RealView': 'Change your RealView password',
    'Xác minh email trước khi thay đổi phương thức đăng nhập.': 'Verify your email before changing your sign-in method.',
    'Tạo mật khẩu RealView': 'Create a RealView password',
    'Dùng mật khẩu này để đăng nhập RealView bằng email hoặc tên đăng nhập. Mật khẩu Google không thay đổi.': 'Use this password to sign in to RealView with your email or username. Your Google password will not change.',
    'Xác nhận liên kết tài khoản': 'Confirm account linking',
    'Một tài khoản, giữ nguyên lịch sử phân tích.': 'One account, with your analysis history preserved.',
    'Xác minh email của bạn': 'Verify your email',
    'Thêm một bước xác minh để bảo vệ tài khoản.': 'Complete one additional verification step to protect your account.',
    'Kiểm tra email của bạn': 'Check your email',
    'Nhập mã 6 số để hoàn tất đăng nhập Google.': 'Enter the 6-digit code to complete Google sign-in.',
    'Bạn đã đăng ký nhận email RealView': 'You are subscribed to RealView emails',
    'Chúng tôi đã ghi nhận lựa chọn đồng ý nhận email mà bạn xác nhận trước đây. Email dịch vụ của tài khoản được gửi riêng.': 'We have recorded the email consent you previously confirmed. Account service emails are managed separately.',
    'Đóng thông báo': 'Close notification',
    'Để sau': 'Maybe later',
    'MỘT LỜI MỜI TỪ REALVIEW': 'AN INVITATION FROM REALVIEW',
    'Nhận thêm góc nhìn hữu ích': 'Get more useful insights',
    'Đăng ký email để nhận mẹo đọc review, hướng dẫn mua sắm sáng suốt và thông tin tính năng mới từ RealView.': 'Subscribe for review-reading tips, smarter shopping guidance, and RealView feature updates.',
    'Nội dung hữu ích, chọn lọc — gửi riêng với email dịch vụ của tài khoản.': 'Useful, curated content—sent separately from account service emails.',
    'Đồng ý nhận email': 'Subscribe to emails',
    'Không phải lúc này': 'Not now',
    'Hoàn toàn tự nguyện. Chỉ đăng ký khi bạn chọn “Đồng ý nhận email”.': 'Completely optional. You are subscribed only when you choose “Subscribe to emails”.',
    'Đang lưu lựa chọn…': 'Saving your choice…',
    'Chưa lưu được lựa chọn. Vui lòng thử lại.': 'Your choice could not be saved. Please try again.',
    'Phiên bản 1.0': 'Version 1.0',
    'Cập nhật:': 'Updated:',
    'Những điểm bạn cần biết': 'Key points',
    'Thông tin của bạn cần được sử dụng rõ ràng, đúng mục đích. Chính sách này giải thích dữ liệu RealView xử lý và những lựa chọn bạn có khi sử dụng dịch vụ.': 'Your information should be used transparently and for clearly defined purposes. This policy explains the data RealView processes and the choices available to you when using the service.',
    'Thông tin tài khoản giúp xác thực và lưu lịch sử. Review sản phẩm công khai là một nguồn dữ liệu riêng, không phải dữ liệu đăng nhập của bạn.': 'Account information supports authentication and saved history. Public product reviews are a separate data source and are not your sign-in data.',
    'Dịch vụ sử dụng nhà cung cấp hạ tầng, phân tích truy cập và AI. Phần dưới giải thích vai trò của từng nhóm nhà cung cấp.': 'The service uses infrastructure, traffic analytics, and AI providers. The sections below explain the role of each provider category.',
    'Bạn có thể xoá lịch sử đã lưu hoặc gửi yêu cầu về thông tin cá nhân qua kênh hỗ trợ của RealView.': 'You can delete saved history or submit a personal-data request through RealView support.',
    'Phạm vi và nhóm phụ trách': 'Scope and responsible team',
    'Những thông tin được xử lý': 'Information we process',
    'Dữ liệu được dùng để làm gì?': 'How is data used?',
    'Cookies và dữ liệu trên thiết bị': 'Cookies and on-device data',
    'Nơi xử lý dữ liệu và nhà cung cấp': 'Data processing locations and providers',
    'Lưu trữ, xoá và bảo vệ dữ liệu': 'Data retention, deletion, and protection',
    'Lựa chọn của bạn và cách gửi yêu cầu': 'Your choices and how to submit a request',
    '1. Phạm vi và nhóm phụ trách': '1. Scope and responsible team',
    'Chính sách áp dụng cho website RealView tại realview.com.vn và các tính năng tài khoản, phân tích đánh giá, trợ lý AI, lịch sử và liên hệ do nhóm dự án RealView vận hành.': 'This policy applies to the RealView website at realview.com.vn and to the account, review analysis, AI assistant, history, and contact features operated by the RealView project team.',
    'RealView là dự án học thuật của nhóm sinh viên UEH. Nhóm dự án là đầu mối hỗ trợ của website; mô tả này không xác định UEH là bên vận hành hoặc bên bảo đảm cho dịch vụ.': 'RealView is an academic project created by UEH students. The project team is the website’s support contact; this description does not identify UEH as the service operator or guarantor.',
    'Chính sách không thay thế chính sách của Shopee, TikTok Shop, Google hoặc website khác mà bạn truy cập từ RealView. Khi mở liên kết bên ngoài, hãy đọc chính sách của dịch vụ đó.': 'This policy does not replace the policies of Shopee, TikTok Shop, Google, or other websites reached through RealView. Please review the relevant service’s policy when opening an external link.',
    'Email hỗ trợ:': 'Support email:',
    '. Bạn cũng có thể dùng': '. You can also use the',
    'trang liên hệ RealView': 'RealView contact page',
    '2. Những thông tin được xử lý': '2. Information we process',
    'RealView xử lý thông tin tương ứng với tính năng bạn sử dụng; không phải mọi lần truy cập đều yêu cầu tạo tài khoản.': 'RealView processes information according to the features you use; creating an account is not required for every visit.',
    '2.1. Tài khoản RealView': '2.1. RealView account',
    'Tên đăng nhập, email, thời điểm tạo tài khoản và lựa chọn nhận email. Với đăng nhập bằng mật khẩu, hệ thống lưu bản băm mật khẩu, không lưu mật khẩu ở dạng văn bản thuần.': 'Username, email address, account creation time, and email preferences. For password sign-in, the system stores a password hash rather than a plaintext password.',
    '2.2. Đăng nhập Google': '2.2. Google sign-in',
    'Khi tính năng được cung cấp và bạn chọn sử dụng, RealView xử lý tên, email và mã định danh tài khoản Google để xác thực hoặc liên kết tài khoản. Luồng đăng nhập này không yêu cầu quyền đọc Gmail hay Google Drive.': 'When available and selected, RealView processes your name, email address, and Google account identifier to authenticate or link an account. This sign-in flow does not request permission to read Gmail or Google Drive.',
    '2.3. Sử dụng dịch vụ': '2.3. Service usage',
    'Link sản phẩm, kết quả và lịch sử phân tích bạn lưu. Nếu hỏi trợ lý AI, nội dung câu hỏi, các tin nhắn liên quan và ngữ cảnh kết quả có thể được xử lý để trả lời.': 'Product links, analysis results, and history you save. If you use the AI assistant, your question, relevant messages, and result context may be processed to provide an answer.',
    '2.4. Liên hệ và email': '2.4. Contact and email',
    'Họ tên, email, nội dung bạn gửi qua biểu mẫu và thông tin cần thiết để xác minh, phản hồi yêu cầu. Không gửi mật khẩu, mã xác minh hoặc thông tin tài chính vào biểu mẫu hay cuộc trò chuyện.': 'Your name, email address, form message, and information needed to verify and respond to your request. Do not submit passwords, verification codes, or financial information through forms or conversations.',
    '2.5. Dữ liệu kỹ thuật': '2.5. Technical data',
    'Thông tin phiên đăng nhập, địa chỉ IP dùng cho giới hạn truy cập, thông tin thiết bị/trình duyệt, lượt truy cập, sự kiện sử dụng, hiệu suất và nhật ký lỗi cần cho vận hành hoặc chẩn đoán.': 'Session information, IP addresses used for rate limiting, device/browser information, visits, usage events, performance information, and error logs needed for operation or diagnostics.',
    '2.6. Review công khai': '2.6. Public reviews',
    'Nội dung đánh giá, số sao, ngày đánh giá và thông tin người viết do nguồn cung cấp trả về, như tên hiển thị hoặc mã định danh. Việc dữ liệu được công khai không có nghĩa người viết mất quyền đối với thông tin của mình.': 'Review content, star rating, review date, and reviewer information returned by the source, such as a display name or identifier. Public availability does not mean reviewers lose their rights over their information.',
    '3. Dữ liệu được dùng để làm gì?': '3. How is data used?',
    '3.1. Cung cấp tính năng': '3.1. Providing features',
    'Xác thực tài khoản, lưu và hiển thị lịch sử, thu thập review theo link sản phẩm, phân loại review, tính TrustScore và trả lời câu hỏi của bạn.': 'Authenticate accounts, save and display history, collect reviews for a product link, classify reviews, calculate TrustScore, and answer your questions.',
    '3.2. Hỗ trợ và bảo vệ dịch vụ': '3.2. Supporting and protecting the service',
    'Gửi mã xác minh, thông báo liên quan tài khoản, phản hồi liên hệ, giới hạn lạm dụng và xử lý lỗi.': 'Send verification codes and account-related notices, respond to inquiries, limit abuse, and resolve errors.',
    '3.3. Đo lường và cải thiện': '3.3. Measurement and improvement',
    'Hiểu tính năng được sử dụng, đo tốc độ tải và cải thiện trải nghiệm. Các sự kiện phân tích tuỳ chỉnh giới hạn ở thông tin như nền tảng mua sắm, phương thức thao tác hoặc loại lỗi; không chủ đích gửi mật khẩu hay nội dung biểu mẫu liên hệ vào các sự kiện này.': 'Understand feature usage, measure load performance, and improve the experience. Custom analytics events are limited to information such as shopping platform, interaction method, or error category; passwords and contact-form content are not intentionally sent in these events.',
    '3.4. Email cập nhật': '3.4. Update emails',
    'Lựa chọn nhận email cập nhật được ghi nhận riêng với việc tạo tài khoản. Bạn có thể yêu cầu ngừng nhận loại email này; email xác minh hoặc hỗ trợ được dùng cho mục đích vận hành, không phải đăng ký marketing.': 'Your choice to receive update emails is recorded separately from account creation. You may request to stop receiving them; verification and support emails are operational messages, not marketing subscriptions.',
    '3.5. Bộ dữ liệu review': '3.5. Review datasets',
    'Review thô và review đã gắn nhãn có thể được lưu để đối chiếu kết quả, tái sử dụng dữ liệu và xây dựng bộ dữ liệu nghiên cứu. Lưu bộ dữ liệu không đồng nghĩa mô hình đã được huấn luyện trên bộ dữ liệu đó. Việc sử dụng cho huấn luyện cần được xem xét riêng về quyền dữ liệu và mục đích xử lý.': 'Raw and labeled reviews may be retained to verify results, reuse data, and build research datasets. Retaining a dataset does not mean a model has been trained on it. Any training use requires a separate review of data rights and processing purposes.',
    '4. Cookies và dữ liệu trên thiết bị': '4. Cookies and on-device data',
    'Cookie phiên đăng nhập giúp website nhận biết tài khoản giữa các lần truy cập. Luồng đăng nhập Google, khi được sử dụng, có thể tạo cookie và thông tin xác thực tạm thời để kiểm tra đúng phiên đăng nhập.': 'Session cookies allow the website to recognize an account across visits. When used, Google sign-in may create cookies and temporary authentication information to validate the correct sign-in session.',
    'Website có thể dùng bộ nhớ phiên của trình duyệt để giữ kết quả phân tích gần nhất hoặc trạng thái giao diện. Xoá dữ liệu trình duyệt có thể làm mất trạng thái này hoặc đăng xuất; thao tác đó không tự xoá tài khoản và dữ liệu đã lưu trên máy chủ.': 'The website may use browser session storage to retain the latest analysis result or interface state. Clearing browser data may remove this state or sign you out, but does not automatically delete your account or server-stored data.',
    'Landing page hiện tích hợp Google Analytics và công cụ đo truy cập/hiệu suất của Vercel. Google Analytics có thể đặt cookie phân tích và xử lý dữ liệu truy cập theo cấu hình dịch vụ. Website hiện chưa có bảng lựa chọn cookies theo từng nhóm; không nên hiểu rằng các cookie phân tích chỉ được tải sau khi bạn bấm đồng ý.': 'The landing page currently integrates Google Analytics and Vercel traffic/performance tools. Google Analytics may set analytics cookies and process traffic data according to its configuration. The website does not currently provide category-level cookie controls, so analytics cookies should not be assumed to load only after consent is selected.',
    'Bạn có thể điều chỉnh hoặc chặn cookie trong trình duyệt. Một số tính năng, đặc biệt là đăng nhập, có thể không hoạt động khi cookie cần thiết bị chặn.': 'You can adjust or block cookies in your browser. Some features, particularly sign-in, may not work when necessary cookies are blocked.',
    '5. Nơi xử lý dữ liệu và nhà cung cấp': '5. Data processing locations and providers',
    'RealView sử dụng dịch vụ bên ngoài để vận hành các tính năng. Dữ liệu được truyền tuỳ theo chức năng và cấu hình đang hoạt động; nhà cung cấp có chính sách lưu trữ, bảo mật và xử lý riêng.': 'RealView uses external services to operate its features. Data transfers depend on the active function and configuration, and each provider has its own retention, security, and processing policies.',
    'Nhà cung cấp theo chức năng': 'Providers by function',
    'Dịch vụ': 'Service',
    'Vai trò và dữ liệu liên quan': 'Role and related data',
    'Phân phối website, chạy API và đo hiệu suất/truy cập. Vercel Blob có thể lưu bộ dữ liệu review trong vùng lưu trữ riêng tư khi được cấu hình.': 'Website delivery, API execution, and performance/traffic measurement. When configured, Vercel Blob may store review datasets in private storage.',
    'Dịch vụ Redis': 'Redis service',
    'Lưu tài khoản, phiên đăng nhập, lịch sử, yêu cầu liên hệ, thông tin xác minh tạm thời và bộ đếm vận hành.': 'Stores accounts, sessions, history, contact requests, temporary verification information, and operational counters.',
    'Apify / nguồn review': 'Apify / review sources',
    'Nhận link hoặc định danh sản phẩm và tham số thu thập để trả về đánh giá công khai.': 'Receives product links or identifiers and collection parameters in order to return public reviews.',
    'Xác thực khi bạn chọn đăng nhập Google; xử lý nội dung review hoặc câu hỏi/ngữ cảnh khi tính năng AI sử dụng Gemini; đo truy cập qua Google Analytics. Đây là các chức năng riêng biệt.': 'Authenticates users who choose Google sign-in; processes review content or questions/context when Gemini-powered AI features are used; and measures traffic through Google Analytics. These are separate functions.',
    'Gmail SMTP hoặc Resend': 'Gmail SMTP or Resend',
    'Gửi email xác minh, khôi phục tài khoản và phản hồi theo nhà cung cấp email đang được cấu hình.': 'Sends verification, account recovery, and response emails through the configured email provider.',
    'Hạ tầng của các nhà cung cấp có thể xử lý hoặc lưu dữ liệu ngoài Việt Nam. Không nên hiểu vị trí chạy một API là vị trí duy nhất lưu tất cả dữ liệu.': 'Provider infrastructure may process or store data outside Vietnam. The location where an API runs should not be treated as the only place where all data is stored.',
    'Đối với đăng nhập Google, thông tin xác thực được dùng cho xác thực và liên kết tài khoản, không phải đầu vào của bộ phân loại review. Nội dung bạn tự nhập vào trợ lý vẫn có thể được chuyển tới nhà cung cấp AI; hãy tránh đưa thông tin cá nhân nhạy cảm vào câu hỏi.': 'For Google sign-in, authentication information is used to authenticate and link accounts, not as input to the review classifier. Content you enter into the assistant may still be sent to the AI provider; avoid including sensitive personal information in questions.',
    'Dữ liệu có thể được cung cấp khi cần xử lý yêu cầu hợp lệ của cơ quan có thẩm quyền hoặc bảo vệ an toàn dịch vụ, trong phạm vi nghĩa vụ áp dụng. Nhóm giới hạn việc sử dụng dữ liệu theo các mục đích được mô tả trong chính sách này.': 'Data may be disclosed when necessary to respond to a valid request from a competent authority or to protect the service, within applicable obligations. The team limits data use to the purposes described in this policy.',
    '6. Lưu trữ, xoá và bảo vệ dữ liệu': '6. Data retention, deletion, and protection',
    'Một số dữ liệu tạm thời có thời hạn kỹ thuật: phiên tài khoản hiện có thời hạn tối đa 30 ngày; mã và yêu cầu xác minh/khôi phục thường có thời hạn 10 phút. Đăng xuất làm hết hiệu lực phiên đang sử dụng, không xoá tài khoản.': 'Some temporary data has technical expiry periods: account sessions currently last up to 30 days, while verification and recovery codes/requests generally expire after 10 minutes. Signing out invalidates the active session but does not delete the account.',
    'Lịch sử tài khoản hiện giữ tối đa 50 kết quả; kết quả cũ có thể được thay thế khi vượt giới hạn. Bạn có thể xoá lịch sử bằng chức năng hiện có. Việc xoá một mục lịch sử không đồng thời xoá bộ dữ liệu review công khai hoặc dữ liệu nguồn ở nền tảng khác.': 'Account history currently retains up to 50 results, and older results may be replaced when the limit is reached. You can delete history using the available controls. Deleting a history item does not also delete public review datasets or source data on other platforms.',
    'Hồ sơ tài khoản, yêu cầu liên hệ và bộ dữ liệu review chưa có một lịch tự động xoá chung theo số ngày trong hệ thống hiện tại. Các dữ liệu này có thể tiếp tục được lưu cho mục đích đã nêu cho đến khi được xử lý hoặc xoá theo yêu cầu phù hợp. Thời hạn lưu của nhật ký và bản sao lưu còn phụ thuộc nhà cung cấp; nhóm không cam kết xoá tức thời mọi bản sao.': 'The current system does not apply one common day-based automatic deletion schedule to account profiles, contact requests, and review datasets. This data may remain stored for the stated purposes until processed or deleted following an appropriate request. Log and backup retention also depends on providers, and the team cannot guarantee immediate deletion of every copy.',
    'Hệ thống sử dụng bản băm mật khẩu, kiểm tra phiên, xác minh email và kiểm soát truy cập ở những chức năng tương ứng. Không có biện pháp kỹ thuật nào bảo đảm an toàn tuyệt đối. Bạn nên dùng mật khẩu riêng, giữ kín mã xác minh và thông báo khi phát hiện truy cập bất thường.': 'The system uses password hashing, session checks, email verification, and access controls where applicable. No technical measure can guarantee absolute security. Use a unique password, protect verification codes, and report suspected unauthorized access.',
    '7. Lựa chọn của bạn và cách gửi yêu cầu': '7. Your choices and how to submit a request',
    'Bạn có thể xoá các mục lịch sử bằng giao diện lịch sử, đăng xuất tài khoản, xoá bộ nhớ trình duyệt hoặc kiểm soát cookie tại thiết bị của mình. Nếu đã đăng ký email cập nhật, bạn có thể gửi yêu cầu ngừng nhận qua email hỗ trợ.': 'You can delete history items through the history interface, sign out, clear browser storage, or control cookies on your device. If you subscribed to update emails, you can request to stop them through the support email address.',
    'Để yêu cầu xem, sửa hoặc xoá thông tin tài khoản, hoặc phản ánh thông tin cá nhân xuất hiện trong một review, hãy gửi email nêu rõ dữ liệu/tài khoản liên quan và phạm vi yêu cầu. Website chưa có nút xoá tài khoản tự phục vụ; yêu cầu xoá tài khoản được tiếp nhận qua hỗ trợ.': 'To request access, correction, or deletion of account information, or to report personal information appearing in a review, email us with the relevant data/account and the scope of your request. The website does not currently offer self-service account deletion; deletion requests are handled through support.',
    'Nhóm có thể cần xác minh bạn là người liên quan trước khi thực hiện yêu cầu. Không gửi mật khẩu hoặc mã xác minh trong email. Nhóm sẽ thông báo về phạm vi có thể xử lý, các giới hạn kỹ thuật và nghĩa vụ lưu giữ nếu có; không bảo đảm xoá được dữ liệu do nền tảng bên ngoài kiểm soát.': 'The team may need to verify your relationship to the data before acting on a request. Do not send passwords or verification codes by email. We will explain the available scope, technical limitations, and any retention obligations; we cannot guarantee deletion of data controlled by external platforms.',
    '8. Cập nhật chính sách': '8. Policy updates',
    'Phiên bản và ngày cập nhật được hiển thị ở đầu trang. Khi dữ liệu được sử dụng cho mục đích mới hoặc có thay đổi quan trọng, nhóm sẽ cập nhật nội dung và cung cấp thông báo phù hợp với tính năng hoặc nghĩa vụ áp dụng.': 'The version and update date appear at the top of this page. If data is used for a new purpose or a material change occurs, the team will update this policy and provide notice appropriate to the feature or applicable obligation.',
    'Chính sách này giải thích việc xử lý dữ liệu; nó không thay thế việc xin phép riêng khi một chức năng cần sự đồng ý của bạn. Hãy liên hệ nếu bạn có câu hỏi trước khi cung cấp thông tin.': 'This policy explains data processing and does not replace separate consent where a feature requires it. Contact us if you have questions before providing information.',
    'Liên hệ hỗ trợ': 'Contact support',
    'Nếu bạn cần làm rõ một mục, hãy liên hệ nhóm RealView trước khi cung cấp thông tin hoặc sử dụng tính năng liên quan.': 'If you need clarification, contact the RealView team before providing information or using the relevant feature.',
    'Điều khoản sử dụng RealView: phạm vi dịch vụ, trách nhiệm tài khoản, giới hạn TrustScore, nội dung đánh giá và cách liên hệ hỗ trợ.': 'RealView Terms of Use: service scope, account responsibilities, TrustScore limitations, review content, and how to contact support.',
    'Một góc nhìn rõ ràng trước khi sử dụng RealView. Những điều khoản dưới đây giúp bạn hiểu phạm vi dịch vụ, trách nhiệm của mình và giới hạn của kết quả phân tích.': 'A clear overview before you use RealView. These terms explain the scope of the service, your responsibilities, and the limitations of analysis results.',
    'RealView hỗ trợ đọc và phân tích review. Kết quả giúp tham khảo, không thay bạn đưa ra quyết định mua hàng.': 'RealView helps you read and analyze reviews. Results are for reference and do not make purchasing decisions for you.',
    'TrustScore là tín hiệu về độ tin cậy của tập review được phân tích, không phải điểm chất lượng sản phẩm hay chứng nhận review thật/giả.': 'TrustScore indicates the reliability of the analyzed review set. It is not a product-quality score or a certification that a review is genuine or fake.',
    'Bạn chịu trách nhiệm với thông tin tài khoản và nội dung gửi lên. Các vấn đề về dữ liệu được giải thích riêng trong Chính sách bảo mật.': 'You are responsible for your account information and submitted content. Data matters are explained separately in the Privacy Policy.',
    'Phạm vi dịch vụ': 'Service scope',
    'RealView cung cấp dịch vụ gì?': 'What service does RealView provide?',
    'RealView là website hỗ trợ tổng hợp và phân tích các đánh giá sản phẩm công khai, giảm nhiễu từ phản hồi ít thông tin và trình bày những điểm cần cân nhắc trước khi mua sắm. Website có thể cung cấp lịch sử, nội dung hướng dẫn và trợ lý AI.': 'RealView is a website that aggregates and analyzes public product reviews, reduces noise from low-information feedback, and presents points to consider before purchasing. The website may also provide history, guides, and an AI assistant.',
    'Dịch vụ do nhóm dự án RealView vận hành trong bối cảnh dự án học thuật của sinh viên UEH. Việc nhắc đến UEH không có nghĩa trường là bên vận hành, xác nhận sản phẩm hoặc bảo đảm kết quả phân tích.': 'The RealView project team operates the service as an academic project by UEH students. Mentioning UEH does not mean the university operates the service, endorses products, or guarantees analysis results.',
    'RealView không phải sàn thương mại điện tử, không phải bên bán và không thay mặt Shopee, TikTok Shop hay người bán xử lý đơn hàng, thanh toán, hoàn tiền hoặc bảo hành.': 'RealView is not an e-commerce marketplace or seller and does not handle orders, payments, refunds, or warranties on behalf of Shopee, TikTok Shop, or any seller.',
    'Sử dụng & tài khoản': 'Use & account',
    'Sử dụng dịch vụ và bảo vệ tài khoản': 'Using the service and protecting your account',
    'Trước khi dùng dịch vụ, hãy đọc các điều khoản này và Chính sách bảo mật. Nếu không đồng ý với điều khoản sử dụng, bạn có thể ngừng sử dụng và liên hệ để hỏi về thông tin hoặc dữ liệu đã cung cấp.': 'Before using the service, please read these terms and the Privacy Policy. If you do not agree, you may stop using the service and contact us about information or data you have provided.',
    'Khi đăng ký, bạn cần cung cấp thông tin phù hợp và có quyền sử dụng địa chỉ email hoặc tài khoản Google được chọn. Đăng nhập Google chỉ được cung cấp khi tính năng đã được triển khai; liên kết tài khoản có thể yêu cầu xác nhận bổ sung.': 'When registering, provide appropriate information and use only an email address or Google account you are authorized to use. Google sign-in is available only when implemented, and linking accounts may require additional confirmation.',
    'Bạn chịu trách nhiệm giữ kín mật khẩu và mã xác minh, bảo vệ thiết bị, đăng xuất trên thiết bị dùng chung và thông báo khi nghi ngờ tài khoản bị truy cập trái phép. Không dùng danh tính của người khác hoặc chia sẻ thông tin đăng nhập để lạm dụng dịch vụ.': 'You are responsible for protecting passwords and verification codes, securing your devices, signing out on shared devices, and reporting suspected unauthorized access. Do not use another person’s identity or share credentials to misuse the service.',
    'Nếu chưa đủ tuổi tự quyết định việc sử dụng dịch vụ theo quy định áp dụng, hãy sử dụng với sự hướng dẫn hoặc chấp thuận phù hợp của cha mẹ hay người giám hộ.': 'If you are not old enough to make your own decision to use the service under applicable rules, use it only with appropriate guidance or consent from a parent or guardian.',
    'Giới hạn kết quả': 'Result limitations',
    'Hiểu đúng TrustScore và kết quả phân tích': 'Understanding TrustScore and analysis results',
    'Điểm số không phải chứng nhận': 'The score is not a certification',
    'TrustScore phản ánh độ tin cậy của tập review theo mô hình và dữ liệu đã xử lý, không phải điểm chất lượng sản phẩm, xác nhận người bán uy tín hay kết luận một review là thật/giả 100%.': 'TrustScore reflects the reliability of a review set based on the model and processed data. It is not a product-quality score, an endorsement of a seller, or a definitive judgment that a review is 100% genuine or fake.',
    'Cỡ mẫu và thời điểm có ảnh hưởng': 'Sample size and timing matter',
    'Kết quả phụ thuộc số review lấy được, bộ lọc, nguồn dữ liệu và thời điểm thu thập. Mẫu nhỏ, thiếu nhóm đánh giá hoặc lấy theo số sao có thể không đại diện cho toàn bộ người mua.': 'Results depend on the number of reviews available, the filters, data sources, and collection time. A small sample, missing rating groups, or star-based sampling may not represent all buyers.',
    'Thuật toán và AI có thể sai': 'Algorithms and AI can be wrong',
    'Việc gắn nhãn, tóm tắt, phân tích ngôn ngữ hoặc kiểm định có thể bỏ sót hay diễn giải nhầm. Tín hiệu thống kê không tự chứng minh nguyên nhân, hành vi gian lận hoặc trải nghiệm thực tế của mọi người mua.': 'Labeling, summarization, language analysis, or verification may miss or misinterpret information. Statistical signals alone do not prove causation, fraud, or every buyer’s actual experience.',
    'Giữ lại hay loại bỏ không khẳng định thật/giả': 'Retaining or excluding a review does not establish authenticity',
    'Review được giữ lại là review đáp ứng tiêu chí sử dụng trong phép phân tích. Review bị tách riêng có thể ít thông tin, trùng lặp hoặc mang tín hiệu cần xem xét; không vì thế được khẳng định là giả.': 'A retained review meets the criteria for use in the analysis. An excluded review may contain little information, duplicate content, or signals requiring caution; this does not establish that it is fake.',
    'Bạn vẫn cần kiểm tra thông tin sản phẩm': 'You still need to verify product information',
    'Hãy đối chiếu mô tả, giá, người bán, chính sách đổi trả và các review gốc. Không dùng điểm số làm căn cứ duy nhất để mua hàng hoặc công khai cáo buộc một cá nhân hay tổ chức.': 'Check the description, price, seller, return policy, and original reviews. Do not use the score as the sole basis for a purchase or for publicly accusing any person or organization.',
    'Nội dung & liên kết': 'Content & links',
    'Nội dung, quyền sử dụng và liên kết ngoài': 'Content, usage rights, and external links',
    'Review gốc, hình ảnh và thông tin sản phẩm có thể thuộc người viết, người bán hoặc nền tảng nguồn. RealView trình bày thông tin phục vụ tham khảo; việc xuất hiện trên website không đồng nghĩa mọi nội dung đó thuộc sở hữu RealView.': 'Original reviews, images, and product information may belong to their authors, sellers, or source platforms. RealView presents this information for reference; appearing on the website does not mean all such content is owned by RealView.',
    'Bạn cần có quyền phù hợp đối với nội dung tự gửi và không đưa lên thông tin cá nhân của người khác khi không có căn cứ phù hợp. Nội dung được xử lý để cung cấp dịch vụ theo Chính sách bảo mật, không phải một sự chuyển giao vô điều kiện mọi quyền sở hữu cho nhóm dự án.': 'You must have appropriate rights to content you submit and must not submit another person’s personal information without a proper basis. Content is processed to provide the service under the Privacy Policy; this is not an unconditional transfer of all ownership rights to the project team.',
    'Liên kết “Mở sản phẩm” và các liên kết ngoài đưa bạn sang dịch vụ khác. Giá, tình trạng hàng, thông tin và chính sách ở nguồn có thể thay đổi. RealView không kiểm soát nội dung hoặc giao dịch trên các dịch vụ đó.': '“Open product” and other external links take you to third-party services. Prices, availability, information, and policies at the source may change. RealView does not control content or transactions on those services.',
    'Nếu bạn cho rằng một nội dung ảnh hưởng đến quyền của mình, hãy gửi link liên quan và thông tin mô tả qua kênh hỗ trợ để nhóm xem xét.': 'If you believe content affects your rights, send the relevant link and a description through the support channel for the team to review.',
    'Hành vi không phù hợp': 'Prohibited conduct',
    'Những hành vi không được phép': 'Prohibited conduct',
    'Để bảo vệ người dùng và khả năng hoạt động của hệ thống, không sử dụng RealView để:': 'To protect users and system availability, do not use RealView to:',
    'Mạo danh, chiếm đoạt tài khoản, truy cập trái phép dữ liệu hoặc chức năng không được cấp quyền.': 'Impersonate others, take over accounts, or access data or features without authorization.',
    'Gửi mã độc, spam, nội dung vi phạm quyền của người khác hoặc thông tin nhằm gây hại.': 'Submit malware, spam, content that infringes others’ rights, or information intended to cause harm.',
    'Gây quá tải, phá hoại hệ thống hoặc tìm cách vượt giới hạn truy cập và các cơ chế bảo vệ dịch vụ.': 'Overload or disrupt the system, or attempt to bypass access limits and service protections.',
    'Làm sai lệch dữ liệu, thao túng kết quả hoặc trình bày TrustScore như một chứng nhận chính thức về người bán hay sản phẩm.': 'Distort data, manipulate results, or present TrustScore as an official certification of a seller or product.',
    'Nhóm có thể giới hạn yêu cầu hoặc quyền truy cập khi có dấu hiệu lạm dụng hoặc rủi ro an toàn. Nếu cho rằng hạn chế được áp dụng nhầm, bạn có thể gửi thông tin để yêu cầu xem xét.': 'The team may limit requests or access when there are signs of abuse or security risk. If you believe a restriction was applied incorrectly, you may submit information for review.',
    'Dữ liệu & email': 'Data & email',
    'Dữ liệu cá nhân và email cập nhật': 'Personal data and update emails',
    'Chính sách bảo mật mô tả thông tin được thu thập, nơi xử lý, thời hạn lưu, cookies và cách gửi yêu cầu về dữ liệu. Chấp nhận điều khoản sử dụng không tự động có nghĩa bạn đồng ý nhận email marketing hoặc mọi mục đích xử lý dữ liệu mới.': 'The Privacy Policy describes the information collected, where it is processed, retention periods, cookies, and how to submit a data request. Accepting these terms does not automatically mean you consent to marketing emails or every new data-processing purpose.',
    'Lựa chọn nhận email cập nhật được ghi nhận riêng. Bạn có thể đề nghị ngừng nhận loại email này qua hỗ trợ mà không phải bỏ việc sử dụng các tính năng cơ bản.': 'Your choice to receive update emails is recorded separately. You may ask support to stop these emails without giving up use of the core features.',
    'Việc xoá lịch sử, đăng xuất, xoá dữ liệu trình duyệt và yêu cầu xoá tài khoản là những thao tác khác nhau. Hãy đọc Chính sách bảo mật để hiểu phạm vi của từng thao tác.': 'Deleting history, signing out, clearing browser data, and requesting account deletion are different actions. Read the Privacy Policy to understand the scope of each one.',
    'Vận hành & trách nhiệm': 'Availability & responsibility',
    'Khả năng hoạt động và trách nhiệm': 'Service availability and responsibility',
    'Dịch vụ có thể gián đoạn vì bảo trì, lỗi kỹ thuật, thay đổi API, nguồn review bị giới hạn hoặc nhà cung cấp bên ngoài không phản hồi. Không phải mọi sản phẩm hay mọi lần phân tích đều lấy được đủ review.': 'The service may be interrupted by maintenance, technical errors, API changes, limited review sources, or unresponsive external providers. Not every product or analysis will return enough reviews.',
    'Tính năng, giới hạn sử dụng và mô hình phân tích có thể được điều chỉnh khi dự án phát triển. Nếu có thay đổi về điều kiện sử dụng hoặc thu phí, thông tin liên quan cần được công bố trước khi áp dụng; không suy ra nghĩa vụ thanh toán chỉ từ việc truy cập website.': 'Features, usage limits, and analysis models may change as the project develops. Any change to usage conditions or fees should be disclosed before it applies; merely accessing the website does not create a payment obligation.',
    'Bạn cần tự kiểm tra thông tin trước quyết định mua sắm. Nhóm hỗ trợ xem xét sai sót khi có thông tin đối chiếu, nhưng không bảo đảm độ chính xác tuyệt đối, hoạt động liên tục hoặc một kết quả mua sắm cụ thể.': 'You must verify information before making a purchase. The team can review reported errors when supporting evidence is available, but does not guarantee absolute accuracy, uninterrupted operation, or any particular purchasing outcome.',
    'Các giới hạn mô tả ở đây không nhằm loại bỏ quyền của người dùng hoặc trách nhiệm của bên vận hành mà pháp luật áp dụng không cho phép loại bỏ.': 'These limitations do not exclude user rights or operator responsibilities that applicable law does not permit to be excluded.',
    'Cập nhật & hỗ trợ': 'Updates & support',
    'Cập nhật điều khoản và liên hệ': 'Updates to these terms and contact',
    'Phiên bản và ngày cập nhật nằm ở đầu trang. Nhóm sẽ công bố thay đổi trên website và cung cấp thông báo phù hợp khi điều kiện sử dụng có thay đổi quan trọng. Yêu cầu đồng ý riêng, nếu cần, không được thay thế chỉ bằng việc sửa nội dung trang này.': 'The version and update date appear at the top of this page. The team will publish changes on the website and provide appropriate notice when usage conditions materially change. Where separate consent is required, it is not replaced merely by editing this page.',
    'Nếu có câu hỏi, muốn phản ánh kết quả sai, nội dung ảnh hưởng tới quyền của bạn hoặc hạn chế truy cập, hãy gửi mô tả và link liên quan. Nhóm sẽ tiếp nhận và trao đổi để xác định cách xử lý phù hợp.': 'If you have questions, want to report an incorrect result, content affecting your rights, or an access restriction, send a description and the relevant link. The team will review the information and discuss an appropriate response.'
  };

  const placeholders = {
    'Dán link sản phẩm Shopee hoặc TikTok Shop...': 'Paste a Shopee or TikTok Shop product link…',
    'Nhập email hoặc tên đăng nhập': 'Enter your email or username',
    'Nhập mật khẩu': 'Enter your password',
    'Tối thiểu 8 ký tự': 'At least 8 characters',
    '3–30 ký tự': '3–30 characters',
    'Nhập lại mật khẩu': 'Re-enter your password',
    'Tìm bài viết...': 'Search articles…',
    'Hỏi thêm về kết quả này...': 'Ask about these results…',
    'Hỏi về RealView...': 'Ask about RealView…',
    'Nhập câu hỏi của bạn...': 'Type your question…'
  };

  const dynamicRules = [
    [/^(\d+)\/([\d]+) báo cáo đã tải$/, '$1/$2 reports loaded'],
    [/^Còn (\d+)\/(\d+) lượt dùng thử$/, '$1/$2 free analyses remaining'],
    [/^(\d+) phút trước$/, '$1 minutes ago'],
    [/^Hôm nay, (.+)$/, 'Today, $1'],
    [/^(\d+) ngày trước$/, '$1 days ago'],
    [/^Danh mục (.+)$/, '$1 category'],
    [/^Mở danh mục (.+)$/, 'Open $1 category'],
    [/^(\d+) review$/, '$1 reviews'],
    [/^(\d+) trên 5 sao$/, '$1 out of 5 stars'],
    [/^Xem (\d+) review đã xử lý$/, 'View $1 processed reviews'],
    [/^Mở menu tài khoản (.+)$/, 'Open $1 account menu'],
    [/^Hỏi Trợ lý về (.+)$/, 'Ask the Assistant about $1'],
    [/^Xóa (.+) khỏi lịch sử$/, 'Remove $1 from history'],
    [/^Đang hỏi về: (.+)$/, 'Asking about: $1'],
    [/^Xem sản phẩm trên (.+)$/, 'View product on $1'],
    [/^Sản phẩm trên (.+)$/, 'Product on $1'],
    [/^Sản phẩm đang phân tích trên (.+)$/, 'Product being analyzed on $1'],
    [/^Đang tìm sản phẩm tương tự trên (.+)$/, 'Looking for a similar product on $1'],
    [/^Đang tìm theo tên và thông tin sản phẩm trên (.+)$/, 'Searching by product name and details on $1'],
    [/^Đang đối chiếu hình ảnh và thông tin trên (.+)$/, 'Comparing images and product details on $1'],
    [/^Đã tìm thấy sản phẩm tương tự trên (.+)\. Nhấn để xem$/, 'A similar product was found on $1. Open to view it'],
    [/^Đã tìm thấy sản phẩm tương tự trên (.+)$/, 'A similar product was found on $1'],
    [/^Kết quả phân tích vẫn dùng bình thường; RealView chưa gửi yêu cầu tìm kiếm sang (.+)$/, 'The analysis result remains available; RealView has not sent a search request to $1.'],
    [/^Hệ thống lấy review (.+) đang bảo trì\. Bạn vẫn có thể đối chiếu sản phẩm; nếu chọn phân tích, RealView sẽ thông báo trạng thái bảo trì\.$/, 'The $1 review service is under maintenance. You can still compare the products; if you start an analysis, RealView will display the maintenance status.'],
    [/^Hệ thống lấy review (.+) đang bảo trì\. Hiện chưa thể phân tích sản phẩm này\. Vui lòng thử lại sau\.$/, 'The $1 review service is under maintenance. This product cannot be analyzed right now. Please try again later.'],
    [/^Hệ thống lấy review (.+) đang bảo trì\.$/, 'The $1 review service is under maintenance.'],
    [/^Hệ thống (.+) đang bảo trì$/, 'The $1 review service is under maintenance'],
    [/^(\d+(?:[.,]\d+)?) review công khai\. Sản phẩm đáp ứng ngưỡng dữ liệu ban đầu để bắt đầu phân tích\.$/, '$1 public reviews. The product meets the initial data threshold for analysis.'],
    [/^(\d+(?:[.,]\d+)?) review công khai\.$/, '$1 public reviews.'],
    [/^Hiện chỉ ghi nhận (\d+(?:[.,]\d+)?) review\. Bạn vẫn có thể phân tích; RealView sẽ dừng và thông báo nếu không đủ 20 review có nội dung như khi dán link ở trang chủ\.$/, 'Only $1 reviews are currently available. You can still start an analysis; RealView will stop and notify you if there are fewer than 20 written reviews, just as it does for links submitted on the homepage.'],
    [/^Hiện chỉ ghi nhận (\d+(?:[.,]\d+)?) review\.$/, 'Only $1 reviews are currently available.'],
    [/^Một lựa chọn trên (.+) đã sẵn sàng để đối chiếu$/, 'An option on $1 is ready for comparison'],
    [/^Đối chiếu từ (.+) sang (.+)$/, 'Compare $1 with $2'],
    [/^(.+) sao trên sàn$/, '$1 marketplace rating'],
    [/^Mã SP (.+)$/, 'Product ID $1'],
    [/^Ảnh (.+)$/, '$1 image'],
    [/^TrustScore (\d+) trên 100$/, 'TrustScore $1 out of 100'],
    [/^Mức tin cậy trước khi xét độ phủ mẫu là (.+)\. Ba tỷ lệ đầu tạo mức tin cậy ban đầu, độ phủ mẫu cho biết điểm có cần được điều chỉnh thận trọng hay không\.$/, 'Reliability before the sample-coverage adjustment is $1. The first three ratios establish the initial reliability level, while sample coverage indicates whether the score needs a cautious adjustment.'],
    [/^Mức tin cậy trước khi xét độ phủ mẫu là (.+)\.$/, 'Reliability before the sample-coverage adjustment is $1.'],
    [/^Độ phủ mẫu đạt (.+), vì vậy hệ thống đã giảm (.+) từ phần điểm cao hơn 50 để kết quả thận trọng hơn\.$/, 'Sample coverage is $1, so the system reduced the portion above 50 by $2 to keep the result cautious.'],
    [/^Độ phủ mẫu đạt (.+) nên không làm giảm TrustScore sau bước tổng hợp\.$/, 'Sample coverage is $1, so it does not reduce TrustScore after aggregation.'],
    [/^(\d+)\/(\d+) review vượt qua bước giảm nhiễu\.$/, '$1/$2 reviews passed the noise-reduction step.'],
    [/^(\d+)% review có trạng thái xác minh rõ ràng đến từ người mua đã xác minh\.$/, '$1% of reviews with a clear verification status are from verified buyers.'],
    [/^(\d+) phản hồi không được dùng để kết luận sản phẩm\.$/, '$1 feedback items were not used to draw product conclusions.'],
    [/^Review vượt lọc nhiễu: (.+)$/, 'Reviews passing the noise filter: $1'],
    [/^Nội dung rõ, hữu ích: (.+)$/, 'Clear, useful content: $1'],
    [/^Review đã được kiểm tra: (.+)$/, 'Reviews checked: $1'],
    [/^Độ phủ của mẫu: (.+)$/, 'Sample coverage: $1'],
    [/^Xem (\d+) trên (\d+) review đáng tham khảo về (.+)$/, 'View $1 of $2 useful reviews about $3'],
    [/^(\d+) yếu tố$/, '$1 factors'],
    [/^(\d+) review về “(.+)” đang được đánh dấu$/, '$1 reviews about “$2” are highlighted'],
    [/^Đang kiểm định nội dung: đã xử lý (\d+)\/(\d+) nhóm đánh giá\.$/, 'Assessing content: processed $1/$2 review groups.'],
    [/^(\d+) review đã được chuẩn hóa; đang thẩm định các trường hợp cần đọc hiểu ngữ cảnh\.$/, '$1 reviews normalized; assessing cases that require contextual understanding.']
  ];

  const pageMetadata = {
    '/': {
      title: 'RealView | Real insights, better choices',
      description: 'RealView summarizes public reviews and highlights what to consider before buying on Shopee or TikTok Shop.'
    },
    '/tieu-chi-loc': {
      title: 'How RealView evaluates reviews',
      description: 'Learn how RealView filters noise and assesses the reliability of public product reviews.'
    },
    '/lien-he': {
      title: 'Contact RealView',
      description: 'Send feedback or get in touch with the RealView project team.'
    },
    '/ket-qua': {
      title: 'Product TrustScore | RealView',
      description: 'Review the product TrustScore, recurring pros and cons, and the evidence behind the analysis.'
    },
    '/chinh-sach-bao-mat': {
      title: 'RealView Privacy Policy',
      description: 'Learn how RealView collects, uses, protects, and retains data.'
    },
    '/dieu-khoan-su-dung': {
      title: 'RealView Terms of Use',
      description: 'Read the terms that apply when using RealView.'
    }
  };

  function readLanguage() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.has(saved) ? saved : 'vi';
    } catch {
      return 'vi';
    }
  }

  function translateText(value) {
    const trimmed = String(value || '').replace(/\s+/g, ' ').trim();
    if (!trimmed || language === 'vi') return trimmed;
    if (english[trimmed]) return english[trimmed];
    const numbered = trimmed.match(/^(\d+(?:\.\d+)?\.)\s+(.+)$/);
    if (numbered && english[numbered[2]]) return `${numbered[1]} ${english[numbered[2]]}`;
    for (const [pattern, replacement] of dynamicRules) {
      if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement);
    }
    return trimmed;
  }

  function shouldSkip(node) {
    const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!parent || parent.closest('script, style, template, code, pre, [data-i18n-skip]')) return true;
    return Boolean(isBlogPage && parent.closest('main'));
  }

  function translateTextNode(node) {
    if (shouldSkip(node)) return;
    if (!originalText.has(node)) originalText.set(node, node.textContent);
    const source = originalText.get(node);
    if (language === 'vi') {
      if (node.textContent !== source) node.textContent = source;
      return;
    }
    const leading = source.match(/^\s*/)?.[0] || '';
    const trailing = source.match(/\s*$/)?.[0] || '';
    const translated = translateText(source);
    if (translated !== source.trim()) node.textContent = `${leading}${translated}${trailing}`;
  }

  function translateAttributes(element) {
    if (shouldSkip(element)) return;
    const names = ['aria-label', 'title', 'placeholder', 'alt'];
    if (!originalAttributes.has(element)) originalAttributes.set(element, {});
    const originals = originalAttributes.get(element);
    names.forEach((name) => {
      if (!element.hasAttribute(name)) return;
      if (!(name in originals)) originals[name] = element.getAttribute(name);
      const source = originals[name];
      const translated = name === 'placeholder' && language === 'en'
        ? (placeholders[source] || translateText(source))
        : translateText(source);
      element.setAttribute(name, language === 'vi' ? source : translated);
    });
  }

  function translateTree(root = document.body) {
    if (!root) return;
    observer?.disconnect();
    if (root.nodeType === Node.TEXT_NODE) translateTextNode(root);
    if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
      else translateAttributes(node);
    }
    observe();
  }

  function updateMetadata() {
    document.documentElement.lang = isBlogPage ? 'vi' : language;
    document.body?.classList.toggle('is-english', language === 'en');
    if (isBlogPage) document.querySelector('main')?.setAttribute('lang', 'vi');
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    const metadata = pageMetadata[path];
    if (metadata && !isBlogPage) {
      if (!document.documentElement.dataset.viTitle) document.documentElement.dataset.viTitle = document.title;
      document.title = language === 'en' ? metadata.title : document.documentElement.dataset.viTitle;
      const description = document.querySelector('meta[name="description"]');
      if (description) {
        if (!description.dataset.viContent) description.dataset.viContent = description.content;
        description.content = language === 'en' ? metadata.description : description.dataset.viContent;
      }
    }
    document.querySelectorAll('[data-language]').forEach((button) => {
      const active = button.dataset.language === language;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', button.dataset.language === 'vi'
        ? (language === 'vi' ? 'Tiếng Việt đang được chọn' : 'Switch to Vietnamese')
        : (language === 'en' ? 'English is selected' : 'Chuyển sang tiếng Anh'));
    });
  }

  function ensureToggle() {
    document.querySelectorAll('.site-header .header-inner').forEach((header) => {
      if (header.querySelector('.language-toggle')) return;
      const brand = header.querySelector(':scope > .brand');
      if (!brand) return;
      const cluster = document.createElement('div');
      cluster.className = 'header-brand-cluster';
      brand.before(cluster);
      cluster.append(brand);
      cluster.insertAdjacentHTML('beforeend', `
        <div class="language-toggle" role="group" aria-label="Language selection">
          <button type="button" data-language="vi" aria-pressed="false">VN</button>
          <span aria-hidden="true">|</span>
          <button type="button" data-language="en" aria-pressed="false">EN</button>
        </div>`);
    });
    updateMetadata();
  }

  function ensureBlogDialog() {
    if (!isBlogPage || language !== 'en') return;
    let shouldShow = false;
    try {
      shouldShow = sessionStorage.getItem(BLOG_NOTICE_KEY) === '1';
      sessionStorage.removeItem(BLOG_NOTICE_KEY);
    } catch {}
    if (!shouldShow || document.querySelector('#blog-language-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'blog-language-dialog';
    dialog.className = 'blog-language-dialog';
    dialog.setAttribute('aria-labelledby', 'blog-language-title');
    dialog.innerHTML = `
      <div class="blog-language-dialog-card">
        <button class="blog-language-dialog-close" type="button" aria-label="Close">×</button>
        <span class="blog-language-dialog-kicker">REALVIEW BLOG</span>
        <h2 id="blog-language-title">This section is currently available in Vietnamese</h2>
        <p>We are working on the English version and will make it available soon. You can still continue reading the Vietnamese articles.</p>
        <button class="blog-language-dialog-continue" type="button">Continue reading</button>
      </div>`;
    document.body.append(dialog);
    const close = () => dialog.close();
    dialog.querySelectorAll('button').forEach((button) => button.addEventListener('click', close));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close();
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  function setLanguage(nextLanguage) {
    if (!SUPPORTED.has(nextLanguage) || nextLanguage === language) return;
    language = nextLanguage;
    try { localStorage.setItem(STORAGE_KEY, language); } catch {}
    translateTree(document.body);
    updateMetadata();
    window.dispatchEvent(new CustomEvent('realview:language-changed', { detail: { language } }));
  }

  function observe() {
    if (!document.body) return;
    if (!observer) {
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) translateTree(node);
          });
        }
      });
    }
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    ensureToggle();
    translateTree(document.body);
    ensureBlogDialog();
    document.addEventListener('click', (event) => {
      const languageButton = event.target.closest('[data-language]');
      if (languageButton) {
        setLanguage(languageButton.dataset.language);
        return;
      }
      const blogLink = event.target.closest('.main-nav a[href^="/bai-viet"]');
      if (blogLink && language === 'en') {
        try { sessionStorage.setItem(BLOG_NOTICE_KEY, '1'); } catch {}
      }
    }, true);
  }

  window.RealViewI18n = {
    getLanguage: () => language,
    setLanguage,
    t: (viText) => language === 'en' ? translateText(viText) : viText,
    refresh: () => translateTree(document.body)
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
