import { requireBlogRole } from './blog-admin-auth.mjs';
import {
  listAccessAudit,
  listAccessGrants,
  revokeAccessGrant,
  upsertAccessGrant
} from './blog-access-store.mjs';
import {
  adminErrorPayload,
  assertAdminSameOrigin,
  parseRequestBody,
  sendAdminJson
} from './blog-admin-http.mjs';

export default async function blogAccessHandler(request, response) {
  let body = {};
  try {
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      response.setHeader('Allow', 'GET, POST, DELETE');
      return sendAdminJson(response, 405, { error: 'Phương thức không được hỗ trợ.' });
    }
    const actor = await requireBlogRole(request, 'admin');
    if (request.method === 'GET') {
      const [entries, audit] = await Promise.all([
        listAccessGrants(),
        listAccessAudit({ limit: 50 })
      ]);
      return sendAdminJson(response, 200, {
        role: actor.role,
        capabilities: actor.capabilities,
        entries,
        audit
      });
    }

    assertAdminSameOrigin(request);
    body = parseRequestBody(request);
    const action = request.method === 'DELETE' ? 'revoke' : String(body.action || 'grant').trim().toLowerCase();
    if (action === 'grant' || action === 'update') {
      const entry = await upsertAccessGrant(body, actor);
      return sendAdminJson(response, action === 'grant' ? 201 : 200, { entry });
    }
    if (action === 'revoke') {
      const entry = await revokeAccessGrant(body.email, actor);
      return sendAdminJson(response, 200, { entry });
    }
    return sendAdminJson(response, 400, { error: 'Thao tác phân quyền không hợp lệ.', code: 'INVALID_ACCESS_ACTION' });
  } catch (error) {
    return sendAdminJson(response, error?.statusCode || 500, adminErrorPayload(error, 'Không thể xử lý quyền truy cập lúc này.'));
  }
}
