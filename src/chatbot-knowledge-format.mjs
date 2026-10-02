import { paragraphAnswer, section } from './chatbot-answer-format.mjs';
import { REALVIEW_CONTACT_EMAIL, REVIEW_SCORE_LIMITATION } from './chatbot-site-facts.mjs';

export function formatKnowledgeAnswer(entry) {
  if (entry.id === 'usage_001') return {
    summary: 'Bạn bắt đầu bằng cách dán liên kết sản phẩm Shopee hoặc TikTok Shop vào RealView.', evidenceRefs: [],
    sections: [section('Cách thực hiện', 'steps', [
      'Mở đúng trang sản phẩm trên Shopee hoặc TikTok Shop và sao chép liên kết.',
      'Mở RealView, dán liên kết vào ô phân tích rồi gửi yêu cầu. Bạn không cần đăng nhập để phân tích.',
      'Theo dõi tiến độ. Hệ thống thu thập review công khai, lọc nội dung ít thông tin hoặc trùng lặp và tổng hợp kết quả.',
      'Đọc TrustScore, ưu điểm, nhược điểm và các review đáng tham khảo hoặc bị loại để đối chiếu với nhu cầu của bạn.'
    ])], limitations: [REVIEW_SCORE_LIMITATION], actions: ['analyze']
  };
  if (entry.id === 'review_008') return {
    summary: 'RealView lọc những review ít thông tin hoặc có nội dung cần kiểm tra; không loại chỉ vì người mua chấm ít sao.', evidenceRefs: [],
    sections: [section('Những nội dung cần kiểm tra', 'bullets', [
      'Review quá ngắn, khen hoặc chê chung chung, chưa mô tả trải nghiệm sản phẩm.',
      'Review chỉ nói về giao hàng hoặc shop, không cung cấp nhận xét về sản phẩm.',
      'Nội dung trùng lặp bất thường.',
      'Số sao mâu thuẫn rõ với lời nhận xét.'
    ])], limitations: ['Review tiêu cực có trải nghiệm cụ thể, liên quan đến sản phẩm không bị loại chỉ vì tiêu cực. Bị loại không đồng nghĩa review đó chắc chắn là giả.'], actions: ['criteria']
  };
  if (entry.id === 'contact_001') return { ...paragraphAnswer(`Bạn có thể liên hệ đội ngũ RealView qua email ${REALVIEW_CONTACT_EMAIL}.`),
    sections: [section('Cách liên hệ', 'paragraph', ['Bạn cũng có thể mở trang Liên hệ trên thanh điều hướng.'])], actions: ['contact'] };
  // Preserve every verified FAQ fact; split only at sentence boundaries, never by length.
  const sentences = entry.answer.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ỹ0-9])/u).filter(Boolean);
  if (sentences.length > 1 && sentences.length <= 6 && entry.answer.length > 220) return {
    ...paragraphAnswer(sentences[0]), sections: [section('Giải thích thêm', 'paragraph', sentences.slice(1))]
  };
  return paragraphAnswer(entry.answer);
}
