// 伪终端桥的测试替身：像交互界面一样，报告自己看到的终端大小，回显收到的输入。
// 可选第 2 个参数：标记目录。像 cursor-agent 一样，自己和起的子进程各写一个以进程号命名的空文件，
// 收到 SIGTERM 时删掉再退出；第 3 个参数为 stubborn 时两个进程都不理 SIGTERM，只能被强杀。
import { spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [pidFile, markers, mode] = process.argv.slice(2);
const mark = `const fs=require('node:fs'),path=require('node:path'),dir=process.argv[1],stubborn=process.argv[2]==='stubborn';
const own=path.join(dir,String(process.pid));fs.writeFileSync(own,'');
process.on('SIGTERM',()=>{if(stubborn)return;fs.unlinkSync(own);process.exit(143)});`;
let child: number | undefined;
if (markers) {
  const helper = spawn(process.execPath, ['-e', `${mark} setInterval(()=>{},1000)`, markers, mode ?? ''], { stdio: 'ignore' });
  child = helper.pid;
  const own = join(markers, String(process.pid));
  writeFileSync(own, '');
  process.on('SIGTERM', () => { if (mode === 'stubborn') return; unlinkSync(own); process.exit(143); });
}
writeFileSync(pidFile, JSON.stringify(child ? [process.pid, child] : process.pid));
process.stdout.write(`size=${process.stdout.columns}x${process.stdout.rows} tty=${process.stdin.isTTY}\n`);
process.stdin.setRawMode(true);
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.includes('\r')) process.stdout.write(`got:${input.replace('\r', '')}\n`);
});
setInterval(() => {}, 1000);
