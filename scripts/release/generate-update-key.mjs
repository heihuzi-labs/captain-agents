import { generateKeyPairSync } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function generateUpdateKey(privateFile, publicFile) {
  if (resolve(privateFile) === resolve(publicFile)) throw new Error('私钥和公钥必须使用不同文件。');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const created = [];
  try {
    for (const [file, data, mode] of [[privateFile, privatePem, 0o600], [publicFile, publicRaw + '\n', 0o644]]) {
      const handle = await open(file, 'wx', mode); created.push(file);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    }
  } catch (error) {
    await Promise.all(created.map(file => rm(file, { force: true })));
    if (error.code === 'EEXIST') throw new Error('目标文件已经存在，拒绝覆盖密钥。');
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('用法：generate-update-key.mjs <私钥文件> <公钥文件>');
    await generateUpdateKey(process.argv[2], process.argv[3]);
    console.log('密钥已生成。请离线保管私钥；公钥在打包时编进应用。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
