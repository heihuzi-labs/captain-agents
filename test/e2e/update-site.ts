// 负责人做在线更新真实验收用的本机测试下载站（docs/release-checklist.md）：只监听本机，正常的 HTTPS，证书由调用方给。
// 用法：node test/e2e/update-site.ts <目录> <端口> <证书.pem> <私钥.pem>
// 下载故意放慢一点，好看清进度。目录里放下面这些名字的空文件，就换一种“出毛病”的情形（验收脚本 update-real.ts 会自己放、自己删）：
//   corrupt：zip 被改坏一个字节（包被改过不安装）；cut：zip 传到一半断开；
//   badsig：清单正文被改了一个字（签名对不上）；same：清单换成 latest-same.json（版本不比现在新）。
import { createServer } from 'node:https';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [dir, port, cert, key] = process.argv.slice(2);
if (!dir || !port || !cert || !key) { console.error('用法：update-site.ts <目录> <端口> <证书> <私钥>'); process.exit(1); }
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (request, response) => {
  const name = basename(decodeURIComponent(new URL(request.url ?? '/', 'https://localhost').pathname));
  const has = (marker: string) => existsSync(join(dir, marker));
  const file = join(dir, name === 'latest.json' && has('same') ? 'latest-same.json' : name);
  console.log(new Date().toISOString(), request.method, name, JSON.stringify(request.headers));
  if (request.method !== 'GET' || !name || ['corrupt', 'cut', 'badsig', 'same'].includes(name) || !existsSync(file)) { response.writeHead(404).end(); return; }
  if (name === 'latest.json' && has('badsig')) {
    // 正文里的一个数字换掉，外壳和签名原样：验的就是“正文和签名对不上”。
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { body: string; signature: string };
    const data = Buffer.from(JSON.stringify({ ...envelope, body: envelope.body.replace(/"size":(\d)/, (_, d: string) => `"size":${d === '9' ? 1 : +d + 1}`) }));
    response.writeHead(200, { 'Content-Length': data.length }).end(data); return;
  }
  const size = statSync(file).size;
  response.writeHead(200, { 'Content-Length': size });
  const corrupt = name.endsWith('.zip') && has('corrupt'), cut = name.endsWith('.zip') && has('cut');
  let first = true, sent = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const data = Buffer.from(chunk as Buffer);
    if (corrupt && first) data[data.length - 1] ^= 0xff;
    first = false;
    if (cut && sent > size / 3) { response.destroy(); return; }
    sent += data.length;
    if (!response.write(data)) await new Promise(resolve => response.once('drain', resolve));
    if (name.endsWith('.zip')) await sleep(120);
  }
  response.end();
}).listen(Number(port), '127.0.0.1', () => console.log('测试下载站已启动：https://localhost:' + port));
