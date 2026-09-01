#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildGeminiPoolFile, normalizeGeminiApiKeys } from '../src/gemini-pool-file.mjs';
import { DEFAULT_GEMINI_CONFIG_URL, uploadGeminiPool } from '../src/gemini-pool-upload.mjs';

function promptSession() {
  return createInterface({ input: stdin, output: stdout });
}

async function collectApiKeys() {
  const reader = promptSession();
  const apiKeys = [];
  stdout.write('\nDán Gemini API key, mỗi dòng một key.\n');
  stdout.write('Các key nên thuộc Google Cloud project khác nhau; key cùng project dùng chung quota.\n');
  stdout.write('Nhấn Enter tại một dòng trống để hoàn tất.\n\n');
  try {
    for await (const line of reader) {
      if (!line.trim()) break;
      apiKeys.push(line);
    }
  } finally {
    reader.close();
  }
  return apiKeys;
}

async function ask(question, fallback = '') {
  const reader = promptSession();
  try {
    const answer = (await reader.question(question)).trim();
    return answer || fallback;
  } finally {
    reader.close();
  }
}

async function askSecret(question) {
  const fromEnvironment = process.env.REALVIEW_GEMINI_ADMIN_KEY || process.env.GEMINI_ADMIN_KEY || process.env.APIFY_ADMIN_KEY;
  if (fromEnvironment) return fromEnvironment;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return ask(question);
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolveSecret, reject) => {
    let secret = '';
    const finish = (error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolveSecret(secret);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Đã hủy nhập admin key.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          secret = secret.slice(0, -1);
          continue;
        }
        if (character >= ' ' && character !== '\u007f') secret += character;
      }
    };
    stdin.on('data', onData);
  });
}

function normalizeMode(answer) {
  const value = String(answer || '').trim().toLowerCase();
  if (['1', 'append', 'bo sung', 'bổ sung', 'bosung'].includes(value)) return 'append';
  if (['2', 'replace', 'thay thế', 'thay the'].includes(value)) return 'replace';
  throw new Error('Hãy chọn 1 (Bổ sung) hoặc 2 (Replace).');
}

function wantsPush(answer) {
  return ['1', 'y', 'yes', 'có', 'co', 'push'].includes(String(answer || '').trim().toLowerCase());
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const apiKeys = await collectApiKeys();
    stdout.write('\n1. Bổ sung — giữ Gemini pool hiện tại và nối key mới.\n');
    stdout.write('2. Replace — thay danh sách key nhưng không xóa trạng thái quota trong ngày của key trùng ID.\n');
    const mode = normalizeMode(await ask('Chọn chế độ [1/2] (mặc định 1 - Bổ sung): ', '1'));
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const defaultFilename = mode === 'append'
      ? `config/gemini-pool-append-${timestamp}.local.json`
      : 'config/gemini-pool.local.json';
    const outputPath = resolve(await ask(`Đường dẫn file đầu ra (mặc định ${resolve(defaultFilename)}): `, resolve(defaultFilename)));
    const cleaned = normalizeGeminiApiKeys(apiKeys);
    const duplicateCount = cleaned.length - new Set(cleaned).size;
    const payload = buildGeminiPoolFile(apiKeys, { mode });

    if (await fileExists(outputPath)) {
      const overwrite = (await ask(`File ${outputPath} đã tồn tại. Ghi đè? [y/N]: `, 'n')).toLowerCase();
      if (!['y', 'yes', 'có', 'co'].includes(overwrite)) {
        stdout.write('Đã hủy, không có file nào bị thay đổi.\n');
        return;
      }
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    stdout.write(`\nĐã tạo ${outputPath}\n`);
    stdout.write(`Tổng: ${payload.credentials.length} Gemini API key.\n`);
    if (duplicateCount) stdout.write(`Đã tự bỏ ${duplicateCount} key bị trùng.\n`);

    stdout.write('\n1. Push Redis ngay\n2. Không push, chỉ giữ file JSON\n');
    if (!wantsPush(await ask('Chọn [1/2] (mặc định 2 - Không push): ', '2'))) {
      stdout.write('Đã tạo file nhưng chưa thay đổi Redis.\n');
      return;
    }
    const endpoint = await ask(`URL API cấu hình (mặc định ${DEFAULT_GEMINI_CONFIG_URL}): `, DEFAULT_GEMINI_CONFIG_URL);
    const adminKey = await askSecret('Nhập GEMINI_ADMIN_KEY hoặc APIFY_ADMIN_KEY (được ẩn): ');
    try {
      const pool = await uploadGeminiPool(payload, { endpoint, adminKey });
      stdout.write(`Đã ${mode === 'append' ? 'bổ sung vào' : 'replace'} Redis thành công.\n`);
      stdout.write(`Pool: ${pool.totals?.credentials || 0} key · ${pool.totals?.backup || 0} backup · ${pool.totals?.used || 0} used.\n`);
    } catch (error) {
      process.exitCode = 1;
      stdout.write(`Push Redis thất bại: ${error.message}\nFile JSON vẫn an toàn tại ${outputPath}\n`);
    }
  } catch (error) {
    process.exitCode = 1;
    stdout.write(`\nKhông thể tạo Gemini pool: ${error.message}\n`);
  }
}

await main();
