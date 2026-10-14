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

// 运行时按算出来的位置去加载模块的地方有几处：createRequire(…)(…) 这种写法，上面那个检查看不出它要加载什么。
// 整个应用只放行一处：主进程在 Windows 上从平台目录取调系统接口用的模块（src/core/native-windows.ts 的 koffi()）。
export function runtimeLoads(source) {
  let count = 0;
  const visit = node => {
    if (node.type === 'CallExpression' && node.callee.type === 'CallExpression' && node.callee.callee.type === 'Identifier' && /^createRequire(\$\d+)?$/.test(node.callee.callee.name)) count++;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child); }
      else if (value?.type) visit(value);
    }
  };
  visit(parseAst(source));
  return count;
}
const ALLOWED_RUNTIME_LOADS = { 'out/main': 1, 'out/preload': 0 };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const dir of ['out/main', 'out/preload']) {
      const files = (await readdir(dir, { recursive: true })).filter(name => /\.(?:c|m)?js$/.test(name));
      if (!files.length) throw new Error(`${dir} 没有构建产物`);
      let loads = 0;
      for (const name of files) {
        const path = join(dir, name), source = await readFile(path, 'utf8'), dependencies = externalPackages(source, name);
        if (dependencies.length) throw new Error(`${path} 仍引用外部依赖：${dependencies.join('、')}`);
        loads += runtimeLoads(source);
      }
      if (loads > ALLOWED_RUNTIME_LOADS[dir]) throw new Error(`${dir} 里有 ${loads} 处运行时按位置加载模块，只放行 ${ALLOWED_RUNTIME_LOADS[dir]} 处（src/core/native-windows.ts）`);
    }
    // 放行的那一处加载的模块不在产物里，运行时从平台目录取，所以这里核对平台目录里有它（checkPlatform 按打包目标查）。
    await checkPlatform(resolve('out/platform'), process.argv[2]);
    console.log('主进程和预加载产物检查通过：只依赖 Electron、Node 内置模块和包内文件；平台文件与依赖完整、无符号链接。');
  } catch (error) { console.error(`打包前检查失败：${error.message}`); process.exitCode = 1; }
}
