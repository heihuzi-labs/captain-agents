import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, exec, root } from './helpers.ts';

// 不执行真实隔离、不监听端口，用库替身验证快照启动脚本的参数引用和退出状态。
test('srt 启动脚本：按指定库路径加载、参数逐字交给子进程，保留退出码并收尾', async t => {
  const c = await context(t, false), dist = join(c.temp, 'fake srt');
  await mkdir(dist);
  await writeFile(join(dist, 'package.json'), '{"type":"module"}');
  await writeFile(join(dist, 'index.js'), `
    import { writeFileSync } from 'node:fs';
    export const SandboxRuntimeConfigSchema = { parse: value => value };
    export const SandboxManager = {
      initialize() { throw new Error('不能初始化代理'); },
      wrapWithSandbox(command, shell, config) {
        if ('network' in config) throw new Error('仍有网络限制');
        if (!config.filesystem.denyRead.includes('dummy-secret')) throw new Error('文件规则丢失');
        return command;
      },
      cleanupAfterCommand() { writeFileSync(process.env.XA_TEST_CLEANUP, 'done'); }
    };
  `);
  const config = join(c.temp, 'sandbox.json'), child = join(c.temp, "worker ' name.mjs"), cleanup = join(c.temp, 'cleanup.txt');
  await writeFile(config, JSON.stringify({ filesystem: { denyRead: ['dummy-secret'], allowWrite: [c.temp] } }));
  await writeFile(child, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;');
  const args = ['空格 和 中文', "单引号 ' 双引号 \"", '$(false) `false` ; exit 23', '两行\n下一行', ''];
  const result = await exec(process.execPath, [join(root, 'src/core/srt-open.ts'), join(dist, 'cli.js'), '--settings', config, process.execPath, child, ...args], c.temp, { ...c.env, XA_TEST_CLEANUP: cleanup });
  assert.equal(result.code, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(await readFile(cleanup, 'utf8'), 'done');
  await writeFile(config, '{bad');
  const bad = await exec(process.execPath, [join(root, 'src/core/srt-open.ts'), join(dist, 'cli.js'), '--settings', config, process.execPath, child], c.temp, c.env);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /联网隔离启动失败/); assert.equal(bad.stdout, '');
});
