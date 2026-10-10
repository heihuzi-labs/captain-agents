import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const platformParts = ['bin', 'src', 'sandbox', 'rules.md', 'guide', 'package.json'];
const srt = '@anthropic-ai/sandbox-runtime';

// 按 Node 的逐级 node_modules 查找，随后解开 pnpm 链接；不依赖包是否导出 package.json。
async function packageRoot(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    try { await stat(join(candidate, 'package.json')); return await realpath(candidate); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (dirname(dir) === dir) throw new Error(`缺少平台依赖：${name}（从 ${from} 查找）`);
  }
}

export async function checkPlatform(root) {
  for (const name of [...platformParts, 'bin/xagents', 'src/cli/cli.ts', 'src/core/paths.ts',
    'src/core/node-entry.ts', 'src/core/pty-bridge.py', 'sandbox/grok.json', 'sandbox/cursor.json',
    `node_modules/${srt}/dist/cli.js`]) await stat(join(root, name));
  let bytes = 0, files = 0;
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const path = join(dir, name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`平台目录不允许符号链接：${path}`);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) { bytes += info.size; files++; }
      else throw new Error(`平台目录有非常规文件：${path}`);
    }
  }
  await walk(root);
  const checked = new Set();
  async function dependencies(name, from) {
    const dir = await packageRoot(name, from);
    if (!dir.startsWith(resolve(root) + '/')) throw new Error(`平台依赖落在包外：${name}`);
    if (checked.has(dir)) return;
    checked.add(dir);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!(dep in (pkg.optionalDependencies ?? {}))) await dependencies(dep, dir);
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      let found;
      try { found = await packageRoot(dep, dir); } catch { continue; }
      if (found) await dependencies(dep, dir);
    }
  }
  await dependencies(srt, resolve(root));
  return { bytes, files, packages: checked.size };
}

export async function preparePlatform(source, destination) {
  source = resolve(source); destination = resolve(destination);
  const temporary = `${destination}.partial-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  const packages = [];
  try {
    for (const part of platformParts) await cp(join(source, part), join(temporary, part), { recursive: true, dereference: true });
    async function copyPackage(name, from, parent, ancestors = new Map()) {
      const real = await packageRoot(name, from);
      // 环形依赖使用已经复制的祖先；其他依赖保持嵌套，允许同名包的不同版本。
      if (ancestors.get(name) === real) return;
      const target = join(parent, 'node_modules', name);
      await mkdir(dirname(target), { recursive: true });
      await cp(real, target, { recursive: true, dereference: true,
        filter: path => path !== join(real, 'node_modules') });
      const pkg = JSON.parse(await readFile(join(real, 'package.json'), 'utf8'));
      packages.push(`${pkg.name}@${pkg.version}`);
      const chain = new Map(ancestors).set(name, real);
      const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies };
      for (const dep of Object.keys(dependencies)) {
        if (dep in (pkg.optionalDependencies ?? {})) {
          try { await packageRoot(dep, real); } catch { continue; }
        }
        await copyPackage(dep, real, target, chain);
      }
    }
    await copyPackage(srt, source, temporary);
    const info = await checkPlatform(temporary);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return { ...info, dependencies: packages };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await preparePlatform(root, join(root, 'out/platform'));
  console.log(`平台已准备：${result.packages} 个依赖包，${(result.bytes / 1024 / 1024).toFixed(1)} MiB（未压缩）。`);
}
