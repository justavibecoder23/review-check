import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const publicDir = join(process.cwd(), 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

async function buildMockAnalysisResult() {
  const reviews = [
    { author: 'nguyenvana_hcm', rating: 5, text: 'Tai nghe xài rất ổn, bass chắc nịch, bật ANC lên là êm ru đỡ ồn hẳn khi ngồi quán cafe. Pin mình dùng cả buổi sáng vẫn còn hơn 60%. Đóng gói cẩn thận, 5 sao đáng tiền.', date: '10-09-2026', verified: true, included: true, labelId: 'kept-1' },
    { author: 'tranthib_da_nang', rating: 4, text: 'Sản phẩm hoàn thiện đẹp, đeo vừa tai không bị cấn hay đau. Âm thanh nghe nhạc acoustic rất mượt. Điểm trừ duy nhất là mic lúc đi ngoài đường bắt tiếng gió hơi nhiều.', date: '08-09-2026', verified: true, included: true, labelId: 'kept-2' },
    { author: 'hoangminh_gaming', rating: 4, text: 'Nghe nhạc xem phim bao phê, nhưng chơi PUBG thì vẫn cảm giác delay một xíu so với tai dây. Tầm giá này thì quá ổn áp rồi, phụ kiện đầy đủ núm tai dự phòng.', date: '05-09-2026', verified: true, included: true, labelId: 'kept-3' },
    { author: 'phamquangkhai', rating: 5, text: 'Chất lượng hoàn thiện cao cấp, hộp sạc nhỏ gọn bỏ túi quần không bị cộm. Kết nối bluetooth 5.3 rất nhanh, mở nắp là nhận.', date: '04-09-2026', verified: true, included: true, labelId: 'kept-4' },
    { author: 'dothuha_hn', rating: 5, text: 'Giao nhanh, tai nghe màu be rất sang. Chống ồn tốt trong phòng làm việc, đệm tai silicon êm ái.', date: '03-09-2026', verified: true, included: true, labelId: 'kept-5' },
    { author: 'user_seeding_xu', rating: 5, text: 'Shop giao hàng nhanh, chưa xài nên chưa biết thế nào, đánh giá lấy xu đã nhé mng.', date: '02-09-2026', verified: false, included: false, exclusionReason: 'Nội dung nhận thưởng / chưa trải nghiệm sản phẩm', labelId: 'excluded-1' },
    { author: 'nguoidung_spam', rating: 5, text: 'Giao hàng nhanh shipper thân thiện đóng gói cẩn thận 5 sao.', date: '01-09-2026', verified: true, included: false, exclusionReason: 'Chỉ đánh giá vận chuyển / shipper, không có nội dung về sản phẩm', labelId: 'excluded-2' },
    { author: 'random_chars', rating: 5, text: 'Shop phục vụ tốt jsdfhkjsdf hksjdf hsdjkf hskjdfh', date: '29-08-2026', verified: false, included: false, exclusionReason: 'Ký tự ngẫu nhiên, không có nghĩa', labelId: 'excluded-3' }
  ];

  for (let i = 6; i <= 25; i++) {
    reviews.push({
      author: 'buyer_' + i,
      rating: (i % 5) + 1,
      text: 'Đánh giá sản phẩm chi tiết số ' + i + ': chất âm tốt, đeo thoải mái sau nhiều ngày trải nghiệm thực tế.',
      date: '2026-08-2' + (i % 9),
      verified: true,
      included: true,
      labelId: 'kept-' + i
    });
  }

  let calculatedTrust = null;
  try {
    const { pathToFileURL } = await import('node:url');
    const { buildRuleBasedTrust } = await import(pathToFileURL(join(process.cwd(), 'src/trust-analysis.mjs')).href);
    calculatedTrust = buildRuleBasedTrust(reviews);
  } catch {
    // Fallback if trust-analysis.mjs is not available in an unusual commit
  }

  const baseQuality = Number(calculatedTrust?.method?.baseQualityScore) || 84.3;
  const rawScore = Number(calculatedTrust?.method?.rawScore) || 81.6;
  const score = Math.round(Number(calculatedTrust?.score) || 82);

  const trust = {
    score,
    scoreStatus: 'reliable',
    tone: score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'orange',
    label: score >= 80 ? 'Độ tin cậy cao' : 'Khá đáng tin',
    summary: 'Tập review có độ xác thực cao, đa số là người mua đã dùng thực tế trên 1 tuần và phản hồi chi tiết về chất âm lẫn pin. Ít dấu hiệu nhận xu hoặc văn mẫu seeding.',
    engine: 'gemini',
    pros: [
      { title: 'Chất âm và khả năng chống ồn tốt', detail: 'Âm bass chắc, chống ồn chủ động ANC hoạt động ổn định trong tầm giá.', mentions: 22, evidenceIds: ['kept-1', 'kept-2'] },
      { title: 'Thời lượng pin ấn tượng', detail: 'Nghe liên tục 6-8 tiếng đúng như thông số mô tả của shop.', mentions: 15, evidenceIds: ['kept-1', 'kept-3'] },
      { title: 'Đóng gói cẩn thận, phụ kiện đầy đủ', detail: 'Hộp nguyên seal, kèm nhiều cỡ nút tai và cáp sạc.', mentions: 9, evidenceIds: ['kept-2'] }
    ],
    cons: [
      { title: 'Micro đàm thoại ngoài trời hơi ồn', detail: 'Khi đi ngoài đường có tiếng gió lọt vào mic, nói chuyện cần nói to hơn.', mentions: 5, evidenceIds: ['kept-3'] },
      { title: 'Độ trễ nhẹ khi chơi game nhịp độ cao', detail: 'Chơi game FPS có cảm giác trễ âm thanh khoảng 0.1s.', mentions: 3, evidenceIds: ['kept-2'] }
    ],
    drivers: [
      { impact: 'up', title: 'Tỷ lệ review xác minh mua hàng cao', detail: '22/25 review hợp lệ đến từ người mua đã xác thực đơn hàng trên sàn.' },
      { impact: 'up', title: 'Thông tin kiểm chứng chi tiết', detail: 'Hơn 70% đánh giá có mô tả trải nghiệm cụ thể sau khi dùng thực tế.' },
      { impact: 'down', title: 'Một số review bị loại vì rác/nhận xu', detail: '3 review đã bị lọc do chỉ chứa icon, văn mẫu nhận xu hoặc chỉ khen shipper.' },
      { impact: 'neutral', title: 'Độ phủ mẫu đại diện', detail: 'Mẫu thu thập đủ dải đánh giá từ 1 sao đến 5 sao theo phân phối tự nhiên.' }
    ],
    method: {
      baseQualityScore: baseQuality,
      rawScore: rawScore,
      components: {
        text: { score: 86, label: 'Chất lượng bằng chứng' },
        authenticity: { score: 88, label: 'Mức ít nhiễu' },
        labeling: { score: 80, label: 'Độ phủ kiểm định' },
        adequacy: { score: 92, label: 'Độ đầy đủ của mẫu' }
      },
      adequacy: {
        coverage: 0.92
      },
      guardrails: {
        totalPenalty: 0
      }
    }
  };

  return {
    product: {
      platform: 'Shopee',
      title: 'Tai nghe Bluetooth True Wireless chống ồn ANC RealView SoundPro Max',
      price: '650.000₫',
      rating: 4.8,
      itemId: '248910234',
      url: 'https://shopee.vn/product/123456789/248910234',
      image: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df'
    },
    stats: {
      scanned: reviews.length,
      included: reviews.filter((r) => r.included).length,
      genuine: reviews.filter((r) => r.included).length,
      excluded: reviews.filter((r) => !r.included).length,
      unverified: reviews.filter((r) => !r.verified).length,
      lowRatings: reviews.filter((r) => r.rating <= 2).length
    },
    verdict: 'Trong mẫu đã thu thập, 22 review đáng tham khảo đánh giá tích cực về chất âm và pin.',
    issues: [],
    trust,
    reviews
  };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    // Mock SSE analysis stream for any version of results.js
    if (req.method === 'POST' && (pathname === '/api/analyze-stream' || pathname === '/api/analyze')) {
      const resultData = await buildMockAnalysisResult();

      if (pathname === '/api/analyze-stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });

        sendSse(res, 'ready', { message: 'Đã mở luồng cập nhật tiến độ (Mock Mode).' });
        sendSse(res, 'progress', { step: 1, percent: 20, message: 'Đang nhận diện sản phẩm...' });
        sendSse(res, 'product_meta', resultData.product);
        sendSse(res, 'reviews_sample', { count: resultData.stats.scanned, stars: { 5: 15, 4: 5, 3: 2, 2: 1, 1: 2 } });
        sendSse(res, 'progress', { step: 2, percent: 50, message: 'Đang thu thập và lọc review...' });
        sendSse(res, 'layer1_stats', { total: resultData.stats.scanned, included: resultData.stats.included, excluded: resultData.stats.excluded });
        sendSse(res, 'layer2_progress', { total: resultData.stats.included, completed: resultData.stats.included });
        sendSse(res, 'progress', { step: 3, percent: 85, message: 'Đang tính toán TrustScore...' });
        sendSse(res, 'progress', { step: 4, percent: 100, message: 'Hoàn tất phân tích.' });
        sendSse(res, 'result', resultData);
        res.end();
        return;
      }

      // Traditional JSON POST /api/analyze
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(resultData));
      return;
    }

    // Static file serving
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Phương thức không được hỗ trợ.' }));
      return;
    }

    const requested = pathname === '/' ? '/index.html' : pathname;
    const cleanPath = normalize(requested).replace(/^([.]{2}[\\/])+/, '');
    const filePath = join(publicDir, cleanPath);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Không có quyền truy cập.' }));
      return;
    }

    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 500;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 404 ? 'Không tìm thấy file.' : error.message);
  }
});

server.listen(port, host, () => {
  console.log('='.repeat(60));
  console.log(`[RealView Mock Server] Đang chạy tại http://${host}:${port}`);
  console.log(`-> Mở trực tiếp trang kết quả: http://${host}:${port}/results.html?url=demo`);
  console.log(`-> Hoặc mở trang chủ dán link bất kỳ để xem toàn bộ luồng tiến trình.`);
  console.log('='.repeat(60));
});
