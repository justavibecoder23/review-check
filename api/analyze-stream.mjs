import { analyzeProductUrl } from '../src/analyze.mjs';
import { openSse } from '../src/sse.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }

  let body;
  try {
    body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
  } catch {
    return response.status(400).json({ error: 'Nội dung gửi lên không hợp lệ.' });
  }

  const stream = openSse(response);
  const heartbeat = setInterval(() => stream.send('heartbeat', { at: Date.now() }), 15_000);
  stream.send('ready', { message: 'Đã mở luồng cập nhật tiến độ.' });

  try {
    const result = await analyzeProductUrl(body.url, {
      onProgress: (progress) => stream.send('progress', progress)
    });
    stream.send('result', result);
  } catch (error) {
    stream.send('error', {
      error: error?.message || 'Có lỗi khi phân tích sản phẩm.',
      statusCode: error?.statusCode || 500,
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.details ? { details: error.details } : {})
    });
  } finally {
    clearInterval(heartbeat);
    stream.close();
  }
}

