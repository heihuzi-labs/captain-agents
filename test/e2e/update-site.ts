// 负责人做在线更新真实验收用的本机测试下载站（docs/release-checklist.md）：只监听本机，正常的 HTTPS，证书由调用方给。
// 用法：node test/e2e/update-site.ts <目录> <端口> <证书.pem> <私钥.pem>
// 验“换地址”时起两个：一个当共用下载桶（只放 zip），一个当发布页（放清单和 zip），端口不同就是两个主机。
// 下载故意放慢一点，好看清进度。目录里放下面这些名字的空文件，就换一种“出毛病”的情形（验收脚本 update-real.ts 会自己放、自己删）：
//   corrupt：zip 被改坏一个字节（包被改过不安装）；cut：zip 传到一半断开；slow：zip 慢到约 200 KB/秒（一百多 MB 的包要十分钟以上，算太慢，该换地址）；
//   badsig：清单正文被改了一个字（签名对不上）；same：清单换成 latest-v2-same.json（版本不比现在新）。
// 每个请求在目录里的 requests.log 记一行“开始 文件名”，整份传完再记一行“传完 文件名”，验收脚本靠它看包是从哪个站下完的。
import { createServer } from 'node:https';
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [dir, port, cert, key] = process.argv.slice(2);
if (!dir || !port || !cert || !key) { console.error('用法：update-site.ts <目录> <端口> <证书> <私钥>'); process.exit(1); }
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (request, response) => {
  const name = basename(decodeURIComponent(new URL(request.url ?? '/', 'https://localhost').pathname));
  const has = (marker: string) => existsSync(join(dir, marker));
  const feed = name === 'latest-v2.json', markers = ['corrupt', 'cut', 'slow', 'badsig', 'same', 'requests.log'];
  const file = join(dir, feed && has('same') ? 'latest-v2-same.json' : name);
  console.log(new Date().toISOString(), request.method, name, JSON.stringify(request.headers));
  if (request.method !== 'GET' || !name || markers.includes(name) || !existsSync(file)) { response.writeHead(404).end(); return; }
  appendFileSync(join(dir, 'requests.log'), `开始 ${name}\n`);
  if (feed && has('badsig')) {
    // 正文里的一个数字换掉，外壳和签名原样：验的就是“正文和签名对不上”。
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { body: string; signature: string };
    const data = Buffer.from(JSON.stringify({ ...envelope, body: envelope.body.replace(/"size":(\d)/, (_, d: string) => `"size":${d === '9' ? 1 : +d + 1}`) }));
    response.writeHead(200, { 'Content-Length': data.length }).end(data); return;
  }
  const size = statSync(file).size;
  response.writeHead(200, { 'Content-Length': size });
  const zip = name.endsWith('.zip') || name.endsWith('.exe'), corrupt = zip && has('corrupt'), cut = zip && has('cut'), slow = zip && has('slow');
  let first = true, sent = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: slow ? 64 * 1024 : 4 * 1024 * 1024 })) {
    if (response.destroyed) return;
    const data = Buffer.from(chunk as Buffer);
    if (corrupt && first) data[data.length - 1] ^= 0xff;
    first = false;
    if (cut && sent > size / 3) { response.destroy(); return; }
    sent += data.length;
    if (!response.write(data)) await new Promise(resolve => response.once('drain', resolve));
    if (zip) await sleep(slow ? 320 : 120);
  }
  response.end();
  appendFileSync(join(dir, 'requests.log'), `传完 ${name}\n`);
}).listen(Number(port), '127.0.0.1', () => console.log('测试下载站已启动：https://localhost:' + port));
