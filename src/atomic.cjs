const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * 原子写文件：先写同目录临时文件再 rename 覆盖。
 * 直接 writeFileSync 在进程被杀 / 断电时会留下半截 JSON，
 * config.json 坏掉后服务直接起不来，号池 / 用量文件坏掉则静默清空。
 * 写入或 rename 失败时保留旧文件并返回错误，不直接覆盖旧文件。
 */
function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, data, { encoding: 'utf8', mode });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
}

module.exports = { writeFileAtomic };
