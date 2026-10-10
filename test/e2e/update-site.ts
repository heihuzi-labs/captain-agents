// 负责人做在线更新真实验收用的本机测试下载站（docs/release-checklist.md）：只监听本机，正常的 HTTPS，证书由调用方给。
// 用法：node test/e2e/update-site.ts <目录> <端口> <证书.pem> <私钥.pem>
// 目录里放一个名叫 corrupt 的空文件时，zip 会被改坏一个字节（验证“包被改过不安装”）；下载故意放慢一点，好看清进度。
import { createServer } from 'node:https';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [dir, port, cert, key] = process.argv.slice(2);
if (!dir || !port || !cert || !key) { console.error('用法：update-site.ts <目录> <端口> <证书> <私钥>'); process.exit(1); }
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (request, response) => {
  const name = basename(decodeURIComponent(new URL(request.url ?? '/', 'https://localhost').pathname)), file = join(dir, name);
  console.log(new Date().toISOString(), request.method, name, JSON.stringify(request.headers));
  if (request.method !== 'GET' || !name || name === 'corrupt' || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Length': statSync(file).size });
  const corrupt = name.endsWith('.zip') && existsSync(join(dir, 'corrupt'));
  let first = true;
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const data = Buffer.from(chunk as Buffer);
    if (corrupt && first) data[data.length - 1] ^= 0xff;
    first = false;
    if (!response.write(data)) await new Promise(resolve => response.once('drain', resolve));
    if (name.endsWith('.zip')) await sleep(120);
  }
  response.end();
}).listen(Number(port), '127.0.0.1', () => console.log('测试下载站已启动：https://localhost:' + port));
