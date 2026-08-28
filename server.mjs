import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { analyzeProductUrl } from './src/analyze.mjs';
import { answerWebsiteQuestion } from './src/site-chatbot.mjs';
import { assertApifyAdmin, readApifyAdminStatus, updateApifyAdminPool } from './src/apify-admin.mjs';
import { openSse } from './src/sse.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const publicDir = join(process.cwd(), 'public');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function getBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 512_000) throw new Error('Nội dung gửi lên quá lớn.');
  }
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === 'POST' && url.pathname === '/api/analyze') {
      const body = await getBody(request);
      const result = await analyzeProductUrl(body.url);
      return sendJson(response, 200, result);
    }

    if (request.method === 'POST' && url.pathname === '/api/analyze-stream') {
      const body = await getBody(request);
      const stream = openSse(response);
      const heartbeat = setInterval(() => stream.send('heartbeat', { at: Date.now() }), 15_000);
      stream.send('ready', { message: 'Đã mở luồng cập nhật tiến độ.' });
      try {
        const result = await analyzeProductUrl(body.url, {
          onProgress: (progress) => stream.send('progress', progress)
        });
        stream.send('result', result);
      } catch (error) {
        stream.send('error', { error: error?.message || 'Có lỗi khi phân tích sản phẩm.', statusCode: error?.statusCode || 500 });
      } finally {
        clearInterval(heartbeat);
        stream.close();
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const body = await getBody(request);
      const result = await answerWebsiteQuestion(body.messages);
      return sendJson(response, 200, result);
    }

    if (['GET', 'PUT'].includes(request.method) && url.pathname === '/api/apify-config') {
      assertApifyAdmin(request.headers.authorization);
      if (request.method === 'GET') return sendJson(response, 200, await readApifyAdminStatus());
      const body = await getBody(request);
      const pool = await updateApifyAdminPool(body);
      return sendJson(response, 200, { updated: true, pool });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { error: 'Phương thức không được hỗ trợ.' });
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const cleanPath = normalize(requested).replace(/^([.]{2}[\\/])+/, '');
    const filePath = join(publicDir, cleanPath);
    if (!filePath.startsWith(publicDir)) return sendJson(response, 403, { error: 'Không có quyền truy cập.' });
    const content = await readFile(filePath);
    response.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error?.statusCode || 500;
    const message = error?.message || 'Có lỗi khi xử lý yêu cầu.';
    if (request.url?.startsWith('/api/')) return sendJson(response, status, { error: message });
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(message);
  }
});

server.listen(port, host, () => {
  console.log(`Review Check đang chạy tại http://${host}:${port}`);
});

