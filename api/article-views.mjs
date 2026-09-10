import { articleVisitorKey, readArticleViews, recordArticleView } from '../src/article-views.mjs';

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json(payload);
}

function slugOf(request) {
  if (request.query?.slug) return request.query.slug;
  return new URL(request.url || '/', 'https://www.realview.com.vn').searchParams.get('slug');
}

export default async function handler(request, response) {
  try {
    const slug = slugOf(request);
    if (request.method === 'GET') return send(response, 200, { views: await readArticleViews(slug) });
    if (request.method === 'POST') {
      const visitor = articleVisitorKey(request, slug);
      return send(response, 200, { views: await recordArticleView(slug, visitor) });
    }
    response.setHeader('Allow', 'GET, POST');
    return send(response, 405, { error: 'Phương thức không được hỗ trợ.' });
  } catch (error) {
    return send(response, error?.statusCode || 500, {
      error: error?.message || 'Không thể cập nhật lượt xem lúc này.',
      ...(error?.code ? { code: error.code } : {})
    });
  }
}
