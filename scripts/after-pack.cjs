// 打包的最后一步：把准备好的平台（out/platform，由 scripts/prepare-platform.mjs 生成）原样放进应用的资源目录。
// 不用打包工具的 extraResources：它会悄悄丢掉所有名叫 node_modules 的目录（2026-10-10 实测，927 个文件只带进去 79 个），
// 而 srt 和它的依赖正好在里面。这里自己复制，并当场核对一个文件都没少、没有符号链接；不对就让打包失败。
const { cp, lstat, readdir, rm } = require('node:fs/promises');
const { join } = require('node:path');

async function files(root, base = '') {
  const out = [];
  for (const name of (await readdir(join(root, base))).sort()) {
    const rel = join(base, name), info = await lstat(join(root, rel));
    if (info.isSymbolicLink()) throw new Error(`平台目录里不该有符号链接：${rel}`);
    if (info.isDirectory()) out.push(...await files(root, rel)); else out.push(`${rel}:${info.size}`);
  }
  return out;
}
exports.default = async function afterPack(context) {
  const from = join(context.packager.projectDir, 'out/platform');
  const to = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources/platform');
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
  const [wanted, got] = [await files(from), await files(to)];
  if (wanted.length === 0 || wanted.join('\n') !== got.join('\n')) throw new Error(`应用里的平台和准备好的不一致（应有 ${wanted.length} 个文件，实际 ${got.length} 个）。`);
  if (!wanted.some(f => f.startsWith(join('node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js') + ':'))) throw new Error('应用里的平台缺少 srt。');
  console.log(`平台已放进应用：${got.length} 个文件。`);
};
