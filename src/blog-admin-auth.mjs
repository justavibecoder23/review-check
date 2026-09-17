import { currentAccount } from '../api/auth.mjs';
import { accessCapabilities, resolveDynamicAccessRole } from './blog-access-store.mjs';

const ROLE_WEIGHT = Object.freeze({ editor: 1, admin: 2 });

function configuredValues(value) {
  return new Set(String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

export function resolveBlogRole(account, env = process.env) {
  if (!account?.id || !account?.email) return null;
  const id = String(account.id).trim().toLowerCase();
  const email = String(account.email).trim().toLowerCase();
  const admins = configuredValues(env.BLOG_ADMIN_EMAILS);
  const adminIds = configuredValues(env.BLOG_ADMIN_USER_IDS);
  if (admins.has(email) || adminIds.has(id)) return 'admin';
  const editors = configuredValues(env.BLOG_EDITOR_EMAILS);
  const editorIds = configuredValues(env.BLOG_EDITOR_USER_IDS);
  if (editors.has(email) || editorIds.has(id)) return 'editor';
  return null;
}

export async function resolveEffectiveBlogRole(account, options = {}) {
  const env = options.env || process.env;
  const configuredRole = resolveBlogRole(account, env);
  if (configuredRole === 'admin') return 'admin';
  let dynamicRole = null;
  try {
    dynamicRole = await (options.resolveDynamicAccessRoleImpl || resolveDynamicAccessRole)(account?.email, {
      ...options,
      env
    });
  } catch (error) {
    if (!configuredRole) throw error;
  }
  return dynamicRole || configuredRole;
}

export function hasBlogRole(role, minimumRole = 'editor') {
  return Number(ROLE_WEIGHT[role] || 0) >= Number(ROLE_WEIGHT[minimumRole] || 0);
}

export function blogAuthorizationError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export async function requireBlogRole(request, minimumRole = 'editor', options = {}) {
  const account = await (options.currentAccountImpl || currentAccount)(request);
  if (!account) {
    throw blogAuthorizationError('Vui lòng đăng nhập để quản trị bài viết.', 401, 'AUTH_REQUIRED');
  }
  const role = await resolveEffectiveBlogRole(account, options);
  if (!hasBlogRole(role, minimumRole)) {
    throw blogAuthorizationError('Tài khoản không có quyền thực hiện thao tác này.', 403, 'BLOG_ROLE_REQUIRED');
  }
  return {
    account: {
      id: account.id,
      username: account.username,
      email: account.email
    },
    role,
    capabilities: accessCapabilities(role)
  };
}

export const blogRoleInternals = { configuredValues, ROLE_WEIGHT };
