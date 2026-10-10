import { readdir, readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlatform } from './prepare-platform.mjs';
// 复用已安装的 Vite 构建工具链，不额外增加依赖。
const require = createRequire(createRequire(import.meta.url).resolve('vite'));
const { parseAst } = require('rollup/parseAst');

// 打包前核对最终产物；外部依赖必须先处理，不能悄悄带进 node_modules。
export function externalPackages(source, name) {
  const file = parseAst(source);
  const missing = new Set();
  const check = value => {
    if (!value || value.type !== 'Literal' || typeof value.value !== 'string') { missing.add(`${name}：无法静态确认的动态依赖`); return; }
    const id = value.value;
    // original-fs 是 Electron 自带的模块（不带 asar 处理的文件函数），和 electron 一样不需要打进包里。
    if (id !== 'electron' && id !== 'original-fs' && !isBuiltin(id) && !id.startsWith('./') && !id.startsWith('../')) missing.add(id);
  };
  const visit = node => {
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) check(node.source);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && /^(?:require|__require)$/.test(node.callee.name)) check(node.arguments[0]);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child); }
      else if (value?.type) visit(value);
    }
  };
  visit(file);
  return [...missing];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const dir of ['out/main', 'out/preload']) {
      const files = (await readdir(dir, { recursive: true })).filter(name => /\.(?:c|m)?js$/.test(name));
      if (!files.length) throw new Error(`${dir} 没有构建产物`);
      for (const name of files) {
        const path = join(dir, name), dependencies = externalPackages(await readFile(path, 'utf8'), name);
        if (dependencies.length) throw new Error(`${path} 仍引用外部依赖：${dependencies.join('、')}`);
      }
    }
    await checkPlatform(resolve('out/platform'));
    console.log('主进程和预加载产物检查通过：只依赖 Electron、Node 内置模块和包内文件；平台文件与 srt 依赖完整、无符号链接。');
  } catch (error) { console.error(`打包前检查失败：${error.message}`); process.exitCode = 1; }
}
