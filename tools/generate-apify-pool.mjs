#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildApifyPoolFile, normalizeApifyTokens } from '../src/apify-pool-file.mjs';

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
    const modeAnswer = await ask('Chế độ [replace/append] (mặc định replace): ', 'replace');
    if (!['replace', 'append'].includes(modeAnswer)) throw new Error('Chế độ chỉ được là replace hoặc append.');
    const defaultPath = resolve('config/apify-pool.local.json');
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
  } catch (error) {
    process.exitCode = 1;
    stdout.write(`\nKhông thể tạo file: ${error.message}\n`);
  }
}

await main();
