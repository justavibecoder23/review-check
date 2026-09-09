import { currentAccount } from './auth.mjs';
import {
  clearAccountHistory,
  deleteAccountHistory,
  listAccountHistory,
  saveAccountHistory
} from '../src/account-store.mjs';

function bodyOf(request) {
  if (typeof request.body === 'string') return JSON.parse(request.body || '{}');
  return request.body || {};
}

function send(response, status, payload) {
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json(payload);
}

export default async function handler(request, response) {
  try {
    const user = await currentAccount(request);
    if (!user) return send(response, 401, { error: 'Vui lòng đăng nhập để sử dụng lịch sử phân tích.', code: 'AUTH_REQUIRED' });

    if (request.method === 'GET') {
      return send(response, 200, { items: await listAccountHistory(user.id) });
    }
    if (request.method === 'POST') {
      const item = await saveAccountHistory(user.id, bodyOf(request).item);
      return send(response, 201, { item });
    }
    if (request.method === 'DELETE') {
      const body = bodyOf(request);
      if (body.clear === true) await clearAccountHistory(user.id);
      else await deleteAccountHistory(user.id, body.id);
      return send(response, 200, { deleted: true });
    }
    response.setHeader('Allow', 'GET, POST, DELETE');
    return send(response, 405, { error: 'Phương thức không được hỗ trợ.' });
  } catch (error) {
    return send(response, error?.statusCode || 500, {
      error: error?.message || 'Không thể xử lý lịch sử lúc này.',
      ...(error?.code ? { code: error.code } : {})
    });
  }
}

