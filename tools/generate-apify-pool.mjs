#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildApifyPoolFile, normalizeApifyTokens } from '../src/apify-pool-file.mjs';
import { DEFAULT_APIFY_CONFIG_URL, uploadApifyPool } from '../src/apify-pool-upload.mjs';

function promptSession() {
  return createInterface({ input: stdin, output: stdout });
}

async function collectTokens() {
  const reader = promptSession();
  const tokens = [];
  stdout.write('\nDán API key Apify, mỗi dòng một key.\nNhấn Enter tại một dòng trống để hoàn tất.\n\n');
  try {
    for await (const line of reader) {
      if (!line.trim()) break;
      tokens.push(line);
    }
  } finally {
    reader.close();
  }
  return tokens;
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
  const fromEnvironment = process.env.REALVIEW_APIFY_ADMIN_KEY || process.env.APIFY_ADMIN_KEY;
  if (fromEnvironment) return fromEnvironment;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return ask(question);

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let secret = '';
    const finish = (error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(secret);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Đã hủy nhập APIFY_ADMIN_KEY.'));
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
    const tokens = await collectTokens();
    stdout.write('\n1. Bổ sung — giữ pool Redis hiện tại và nối key mới.\n');
    stdout.write('2. Replace — thay toàn bộ pool Redis bằng danh sách mới.\n');
    const modeAnswer = normalizeMode(await ask('Chọn chế độ [1/2] (mặc định 1 - Bổ sung): ', '1'));
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const defaultFilename = modeAnswer === 'append'
      ? `config/apify-pool-append-${timestamp}.local.json`
      : 'config/apify-pool.local.json';
    const defaultPath = resolve(defaultFilename);
    const outputAnswer = await ask(`Đường dẫn file đầu ra (mặc định ${defaultPath}): `, defaultPath);
    const outputPath = resolve(outputAnswer);
    const cleanedTokens = normalizeApifyTokens(tokens);
    const uniqueTokenCount = new Set(cleanedTokens).size;
    const duplicateCount = cleanedTokens.length - uniqueTokenCount;
    const payload = buildApifyPoolFile(tokens, { mode: modeAnswer });

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
    stdout.write(`Tổng: ${uniqueTokenCount} key hợp lệ · ${payload.groups.length} nhóm đủ · ${payload.groups.length * payload.maxUsesPerKey} lượt phân tích.\n`);
    if (duplicateCount) stdout.write(`Đã tự bỏ ${duplicateCount} API key bị trùng, giữ lần xuất hiện đầu tiên.\n`);
    if (payload.pendingCredentials.length) {
      stdout.write(`${payload.pendingCredentials.length} key dư sẽ được lưu ở trạng thái pending và chưa được sử dụng cho đến khi đủ nhóm 5.\n`);
    }

    stdout.write('\n1. Push Redis ngay\n2. Không push, chỉ giữ file JSON\n');
    const pushAnswer = await ask('Chọn [1/2] (mặc định 2 - Không push): ', '2');
    if (!wantsPush(pushAnswer)) {
      stdout.write('Đã tạo file nhưng chưa thay đổi Redis.\n');
      return;
    }

    const endpoint = await ask(`URL API cấu hình (mặc định ${DEFAULT_APIFY_CONFIG_URL}): `, DEFAULT_APIFY_CONFIG_URL);
    const adminKey = await askSecret('Nhập APIFY_ADMIN_KEY (được ẩn): ');
    try {
      const pool = await uploadApifyPool(payload, { endpoint, adminKey });
      stdout.write(`Đã ${modeAnswer === 'append' ? 'bổ sung vào' : 'replace'} Redis thành công.\n`);
      stdout.write(`Pool: ${pool.totals?.groups || 0} nhóm · ${pool.reserve?.length || 0} dự phòng · ${pool.pendingCount || 0} key pending.\n`);
    } catch (error) {
      process.exitCode = 1;
      stdout.write(`Push Redis thất bại: ${error.message}\nFile JSON vẫn an toàn tại ${outputPath}\n`);
    }
  } catch (error) {
    process.exitCode = 1;
    stdout.write(`\nKhông thể tạo file: ${error.message}\n`);
  }
}

await main();
