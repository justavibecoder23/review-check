// Read-only, local design preview. Deliberately outside public/ and auth APIs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const files = new Map([
  ['/', '../docs/previews/google-login/index.html'],
  ['/preview.css', '../docs/previews/google-login/preview.css'],
  ['/preview.js', '../docs/previews/google-login/preview.js'],
  ['/google-g.png', '../docs/previews/google-login/google-g.png'],
  ['/google-sans.ttf', '../docs/previews/google-login/google-sans.ttf'],
  ['/styles.css', '../public/styles.css'],
  ['/auth.css', '../public/auth.css'],
  ['/assets/realview-logo-v1.webp', '../public/assets/realview-logo-v1.webp'],
  ['/chinh-sach-bao-mat', '../public/privacy.html'],
  ['/dieu-khoan-su-dung', '../public/terms.html'],
  ['/legal.css', '../public/legal.css'],
  ['/legal.js', '../public/legal.js'],
]);
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', png: 'image/png', webp: 'image/webp', ttf: 'font/ttf' };
export function createPreviewServer() {
  return createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = files.get(path);
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method) || !file) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return response.end('Design preview only; no authentication API.');
    }
    try {
      const content = await readFile(new URL(file, import.meta.url));
      response.writeHead(200, { 'content-type': types[file.split('.').at(-1)] || 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(404);
      response.end('Preview resource not found.');
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.GOOGLE_PREVIEW_PORT || 3145);
  createPreviewServer().listen(port, '127.0.0.1', () => console.log(`Approval-only preview: http://127.0.0.1:${port}`));
}
