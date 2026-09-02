export function normalizeApiPath(pathname = '') {
  return String(pathname)
    .replace(/^\/public(?=\/api\/)/, '')
    .replace(/\.mjs$/, '');
}
