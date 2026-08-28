import { assertApifyAdmin, readApifyAdminStatus, updateApifyAdminPool } from '../src/apify-admin.mjs';

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  if (!['GET', 'PUT'].includes(request.method)) {
    response.setHeader('Allow', 'GET, PUT');
    return response.status(405).json({ error: 'Phương thức không được hỗ trợ.' });
  }
  try {
    assertApifyAdmin(request.headers.authorization);
    if (request.method === 'GET') {
      return response.status(200).json(await readApifyAdminStatus());
    }
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const pool = await updateApifyAdminPool(body);
    return response.status(200).json({ updated: true, pool });
  } catch (error) {
    return response.status(error?.statusCode || 500).json({ error: error?.message || 'Không cập nhật được cấu hình Apify.' });
  }
}
