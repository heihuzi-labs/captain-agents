import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, root } from './helpers.ts';
import { parseCodexModels, parseTextModels, queryModels } from '../src/core/models.ts';
import { formatModels } from '../src/cli/models.ts';
import { codexPath, command } from '../src/core/workers.ts';
import type { QueryCommand } from '../src/core/quota.ts';
const fixtures = join(root, 'test/fixtures/quota');
const sample = (name: string) => readFile(join(fixtures, name), 'utf8');

test('模型样本：保留 Codex 字段，Cursor 只显示三家，核对 workers 当前强度变体', async () => {
  const commands: QueryCommand[] = [];
  const result = await queryModels(async command => {
    commands.push(command);
    return sample(command.file === 'grok' ? 'grok-models.txt' : command.file === 'cursor-agent' ? 'cursor-models.txt' : 'codex-models.json');
  });
  assert.deepEqual(commands.map(c => c.args), [['debug', 'models'], ['models'], ['--list-models']]);
  assert.deepEqual(result[0].models[0], { slug: 'gpt-6-astra', name: 'GPT-6 Astra', visibility: 'list' });
  assert.equal(result[0].models[1].visibility, 'hide');
  assert.ok(result.every(r => r.current.every(c => c.present)));
  assert.equal(result[2].models.length, 24);
  // “当前”覆盖每位选手、每档强度和快速版：Grok 命令行普通与快速两个，Cursor 三位选手按强度展开。
  assert.deepEqual(result[1].current.map(c => c.model), ['grok-4.7', 'grok-4.7-build-fast']);
  assert.deepEqual(result[2].current.map(c => c.who), [...Array(6).fill('cursor-grok'), ...Array(6).fill('cursor-opus'), ...Array(3).fill('cursor-sonnet')]);
  assert.ok(result[2].current.some(c => c.model === 'grok-4.7-medium-fast') && result[2].current.some(c => c.model === 'claude-opus-5-5-xhigh-fast') && result[2].current.some(c => c.model === 'claude-sonnet-5-5-medium'));
  assert.ok(!result[2].current.some(c => /max|low|sonnet-5-5-\w+-fast/.test(c.model)));
  assert.match(formatModels(result), /当前 cursor-sonnet：claude-sonnet-5-5-medium（在列表中）/); assert.match(formatModels(result), /当前 grok：grok-4.7-build-fast（在列表中）/);
  assert.match(formatModels(result), /在列表中/); assert.ok(!formatModels(result).includes('gemini'));
  assert.deepEqual(parseCodexModels('{"models":[]}'), []);
  assert.throws(() => parseCodexModels('{}'), /格式/);
  assert.throws(() => parseTextModels('Usage: cursor-agent --list-models', 'cursor'), /未识别/);
});

test('某家查询失败只记无法核对；近似名称不能冒充当前模型', async () => {
  const result = await queryModels(async command => {
    if (command.file === 'grok') throw new Error('离线');
    if (command.file === 'cursor-agent') return 'claude-opus-5-5-high-new - Different\ngrok-4.7 - Grok';
    return '[{"slug":"gpt-6-astra-new","display_name":"GPT-6 Astra"}]';
  });
  assert.equal(result[0].current[0].present, false);
  assert.equal(result[1].error, '离线'); assert.equal(result[1].current[0].present, null);
  assert.ok(result[2].current.every(c => c.present === false));
  assert.match(formatModels(result), /查不到（离线）/); assert.match(formatModels(result), /不在列表中/);
});

test('models CLI 用实时查询替身，输出三家结果，不改模型设置', async t => {
  const c = await context(t, false), config = await readFile(join(root, 'src/core/workers.ts'), 'utf8');
  const result = await c.cli(['models'], { XAGENTS_QUERY_EXEC: join(fixtures, 'query.ts') });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Codex：[\s\S]*Grok：[\s\S]*Cursor：/);
  assert.match(result.stdout, /claude-opus-5-5-xhigh（在列表中）/);
  assert.equal(await readFile(join(root, 'src/core/workers.ts'), 'utf8'), config);
  assert.equal((await c.cli(['models', '--unknown'])).code, 1);
});

test('Codex 用与派活相同的路径（不在 PATH 上）；真实样本里的当前模型能核对，Grok、Cursor 真实列表也行', async t => {
  const old = process.env.XAGENTS_CODEX; delete process.env.XAGENTS_CODEX;
  t.after(() => { if (old === undefined) delete process.env.XAGENTS_CODEX; else process.env.XAGENTS_CODEX = old; });
  const files: string[] = [];
  const run = () => queryModels(async cmd => {
    files.push(cmd.file);
    return sample(cmd.file === 'grok' ? 'grok-models-real.txt' : cmd.file === 'cursor-agent' ? 'cursor-models-real.txt' : 'codex-models-real.json');
  });
  const result = await run();
  assert.equal(files[0], codexPath()); assert.ok(codexPath().startsWith('/'));
  process.env.XAGENTS_CODEX = '/opt/自定义/codex'; await run();
  assert.equal(files[3], '/opt/自定义/codex'); assert.equal(codexPath(), '/opt/自定义/codex');
  // 派活用的启动命令取的就是同一个函数的结果。
  const job = { id: 'x', who: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'read-only', repo: '/tmp/r', worktree: '/tmp/x' } as Parameters<typeof command>[0];
  assert.equal((await command(job, '题目', { denyReadExtra: [] })).file, codexPath());
  assert.equal(result[0].models.length, 9); assert.equal(result[0].models[3].slug, 'gpt-reserve'); assert.equal(result[0].models[3].visibility, 'hide');
  assert.deepEqual(result[0].current, [{ who: 'codex', model: 'gpt-6-astra', present: true }, { who: 'codex-luna', model: 'gpt-6-luna', present: true }]);
  assert.match(formatModels(result), /当前 codex：gpt-6-astra（在列表中）/); assert.match(formatModels(result), /当前 codex-luna：gpt-6-luna（在列表中）/);
  assert.ok(result[1].current.every(c => c.present)); assert.ok(result[2].current.every(c => c.present));
  assert.ok(result[2].models.every(m => !/[\u200b]/.test(m.name)));
  assert.ok(!result[2].models.some(m => m.slug === 'auto'));
});

test('找不到 Codex 时也列出当前模型，写明无法核对', async () => {
  const result = await queryModels(async cmd => { if (cmd.file.endsWith('codex')) throw new Error('spawn codex ENOENT'); return sample(cmd.file === 'grok' ? 'grok-models.txt' : 'cursor-models.txt'); });
  assert.equal(result[0].current[0].present, null);
  assert.match(formatModels(result), /Codex：查不到（spawn codex ENOENT）\n {2}当前 codex：gpt-6-astra（无法核对）/);
});
