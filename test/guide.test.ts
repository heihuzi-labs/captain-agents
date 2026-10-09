import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, exec, root } from './helpers.ts';
import { whos } from '../src/core/roster.ts';

const at = '2026-09-30T00:10:00.000Z';
const manualFile = join(root, 'guide/commander.md');
const local = (iso: string) => {
  const d = new Date(iso), two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

// 登记处里放一件任务记录（只写文件，不启动任何选手）。
async function put(home: string, id: string, who: string, extra: Record<string, unknown> = {}) {
  await mkdir(join(home, 'jobs', id), { recursive: true });
  await writeFile(join(home, 'jobs', id, 'job.json'), JSON.stringify({
    id, batch: `批-${id}`, project: '测试', repo: '/tmp/none', base: 'abc', worktree: `/tmp/none/${id}`, branch: `xa/${id}`,
    who, model: 'm', effort: 'high', mode: 'workspace-write', kind: '实现', title: `题目 ${id}`, summary: '测试用',
    state: 'done', created: at, started: at, ended: at, seconds: 60, ...extra,
  }));
}
const rating = (score: number, tags: string[]) => ({ score, tags, at, by: 'lead' });
const verified = { ok: true, at, seconds: 1, steps: [] };

test('手册里提到的每个 xagents 子命令和参数，都在 --help 里真实存在', async t => {
  const c = await context(t, false), manual = await readFile(manualFile, 'utf8');
  const help = await c.cli(['--help']); assert.equal(help.code, 0, help.stderr);
  const split = (words: string[]) => words.flatMap(w => w.split('|'));
  const known = new Set(split([...help.stdout.matchAll(/^ {2}xagents ([a-z|]+)/gm)].map(m => m[1])));
  const mentioned = new Set(split([...manual.matchAll(/\bxagents ([a-z][a-z|]*)/g)].map(m => m[1])));
  for (const word of mentioned) assert.ok(known.has(word), `手册提到了 xagents ${word}，但 --help 里没有这条命令`);
  for (const word of ['guide', 'status', 'inbox', 'workers', 'quota', 'profiles', 'stats', 'run', 'wait', 'verify', 'real', 'adopt', 'drop', 'rate', 'clean', 'reply', 'handled'])
    assert.ok(mentioned.has(word), `手册应该讲到 xagents ${word}`);
  const projectKnown = new Set([...help.stdout.matchAll(/xagents project ([a-z]+)/g)].map(m => m[1]));
  const projectMentioned = [...manual.matchAll(/\bxagents project ([a-z]+)/g)].map(m => m[1]);
  assert.ok(projectMentioned.length);
  for (const word of projectMentioned) assert.ok(projectKnown.has(word), `手册提到了 xagents project ${word}，但 --help 里没有`);
  const flags = new Set([...help.stdout.match(/--[a-z][a-z-]*/g) ?? [], '--help']); // --help 本身不写在帮助正文里
  for (const flag of new Set(manual.match(/--[a-z][a-z-]*/g))) assert.ok(flags.has(flag), `手册提到了参数 ${flag}，但 --help 里没有`);
  assert.match(help.stdout, /xagents guide\n\s+打印指挥手册全文/);
});

test('手册讲全了：打分五档、四类要主人本人的事、底线，且不写死选手清单', async () => {
  const manual = await readFile(manualFile, 'utf8');
  for (const heading of ['开工前', '派给谁', '派活，还是自己写', '骨架', '写题目', '拆小', '盯进度', '审查和验收', '拍板', '打分', '留言和拍板', '四类事', '常见故障', '底线'])
    assert.match(manual, new RegExp(`^## \\d+\\. .*${heading}`, 'm'), `缺少一节：${heading}`);
  for (const score of [1, 2, 3, 4, 5]) assert.match(manual, new RegExp(`^\\| ${score} \\|`, 'm'));
  assert.match(manual, /仅供参考，以最新的打分为准/);
  // 选手清单只写在 roster.ts：手册不并列写死选手名，让人去看 xagents workers。
  for (const who of whos.filter(w => w.includes('-'))) assert.ok(!manual.includes(`\`${who}\``), `手册不该写死选手名 ${who}`);
  assert.ok(!manual.includes('## 这台机器现在的情况'), '“这台机器现在的情况”由命令临时生成，不写进手册文件');
});

test('xagents guide：先是手册全文，再是“这台机器现在的情况”（选手设置、额度、档案、手头的活、待办）', async t => {
  const c = await context(t, false), manual = await readFile(manualFile, 'utf8');
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ workers: {
    codex: { enabled: false, efforts: ['high'], fast: false },
    grok: { enabled: true, efforts: ['medium', 'high'], fast: true },
  }, limits: { maxRunning: 2, quotaStop: 60 } }));
  const reset = '2026-10-04T01:00:00.000Z', queried = '2026-09-30T00:50:00.000Z';
  await mkdir(join(c.home, 'cache'), { recursive: true });
  await writeFile(join(c.home, 'cache', 'quota.json'), JSON.stringify({ queriedAt: queried, providers: [
    { name: 'Codex', icon: 'codex', plan: 'pro', at: queried, bars: [{ label: '周额度', used: 12, reset, windowMinutes: 10080 }] },
    { name: 'Grok', icon: 'grok', plan: 'super', at: '2026-09-30T00:30:00.000Z', error: '网络不通', bars: [{ label: '本期额度', used: 41, reset }] },
    { name: 'Cursor', icon: 'cursor', plan: null, at: null, error: '界面可能改了', bars: [{ label: '自家模型池', used: null, reset: null }, { label: '其他模型池', used: null, reset: null }] },
  ] }));
  // Codex 三件都打了分；Grok 一件；其余没有分或还在跑。
  await put(c.home, 'c1', 'codex', { rating: rating(5, ['一次做对', '速度快']), verify: verified, decision: { kind: 'adopt', at, by: 'lead' } });
  await put(c.home, 'c2', 'codex', { rating: rating(4, ['一次做对']), verify: verified });            // 验收过、还没拍板
  await put(c.home, 'c3', 'codex', { rating: rating(3, ['需要返工']) });                              // 做完了、还没验收
  await put(c.home, 'g1', 'grok', { rating: rating(2, ['夸大结论']), decision: { kind: 'drop', at, by: 'lead' } });
  // 在跑的活要有一个活着的看管进程号，否则命令会把它修正成“失联”；用一个空转的子进程顶替，测试结束时收掉。
  const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { idle.kill('SIGKILL'); });
  await put(c.home, 'r1', 'cursor-grok', { state: 'running', pid: idle.pid, ended: undefined, seconds: undefined });
  await put(c.home, 'o1', 'cursor-opus', { verify: verified, decision: { kind: 'adopt', at, by: 'owner' }, redo: { at, by: 'owner' } });
  await put(c.home, 'o2', 'cursor-sonnet', { state: 'failed', comments: [{ by: 'owner', text: '第一条', at }, { by: 'owner', text: '第二条', at }] });

  const result = await c.cli(['guide']);
  assert.equal(result.code, 0, result.stderr);
  const [body, appendix] = [result.stdout.slice(0, result.stdout.indexOf('\n## 这台机器现在的情况')), result.stdout.slice(result.stdout.indexOf('## 这台机器现在的情况'))];
  assert.equal(body.trimEnd(), manual.trimEnd(), '前半段必须是手册全文');
  assert.equal(result.stdout.split('## 这台机器现在的情况').length, 2);

  // 选手设置：和 xagents workers 一致，五位都在。
  assert.match(appendix, /- Codex（codex）· GPT-6 Astra：已关闭，不能派；强度 高档；快速版 未开放/);
  assert.match(appendix, /- Grok（grok）· Grok 4\.7：开启；强度 中档、高档；快速版 允许/);
  for (const who of whos) assert.ok(appendix.includes(`（${who}）`), `缺少选手 ${who}`);
  assert.match(appendix, /- Cursor · Sonnet（cursor-sonnet）· Claude Sonnet 5\.5：开启；强度 中档、高档、超高档；快速版 未开放/);

  // 额度：查到的、这次没查到但有上一次的、一直查不到的，各按 xagents quota 的写法。
  assert.match(appendix, new RegExp(`查询时间 ${local(queried)}`));
  assert.match(appendix, new RegExp(`- Codex：套餐 pro；周额度 12%，${local(reset)} 重置（数据时间 ${local(queried)}）`));
  assert.match(appendix, new RegExp(`- Grok：这次没查到（网络不通）；上一次的数据：套餐 super；本期额度 41%，${local(reset)} 重置（数据时间 ${local('2026-09-30T00:30:00.000Z')}）`));
  assert.match(appendix, /- Cursor：查不到（界面可能改了）/);
  assert.match(appendix, /派活限制：同时最多 2 件；额度用到 60% 停派（设置 → 选手与模型）/);
  assert.match(appendix, /某家本期额度用到 60%/);
  assert.doesNotMatch(appendix, /80%|默认 6/);

  // 档案摘要：每位选手一行。
  assert.match(appendix, /- Codex：做过 3 件，其中 3 件打了分，平均 4\.0 分；优点 一次做对 ×2、速度快 ×1；毛病 需要返工 ×1$/m);
  assert.match(appendix, /- Grok：做过 1 件，其中 1 件打了分，平均 2\.0 分；优点 暂无；毛病 夸大结论 ×1（样本少，仅供参考）$/m);
  assert.match(appendix, /- Cursor · Grok：还没做过活$/m);
  assert.match(appendix, /- Cursor · Claude：做过 1 件，还没打分$/m);
  assert.match(appendix, /- Cursor · Sonnet：做过 1 件，还没打分$/m);

  // 手头的活和待办。
  assert.match(appendix, /在跑或排队：1 件/);
  assert.match(appendix, /设置里同时最多 2 件/);
  assert.match(appendix, /做完了、还没验收：1 件/);
  assert.match(appendix, /验收过、还没拍板：1 件/);
  assert.match(appendix, /等你照办或回复的事.*：3 条/);
  const inbox = await c.cli(['inbox']); assert.equal(inbox.code, 0, inbox.stderr);
  assert.equal(inbox.stdout.trim().split('\n').length - 1, 3, '和 xagents inbox 表里的行数一致');

  // 只读：不改任何任务记录。
  assert.equal(JSON.parse(await readFile(join(c.home, 'jobs', 'c2', 'job.json'), 'utf8')).rating.score, 4);
});

test('xagents guide：登记处是空的也能用，额度没查过时提示先运行 xagents quota', async t => {
  const c = await context(t, false);
  const result = await c.cli(['guide']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /还没有额度数据，先运行 `xagents quota`/);
  assert.match(result.stdout, /在跑或排队：0 件/);
  assert.match(result.stdout, /派活限制：同时最多 12 件；额度用到 80% 停派/);
  assert.match(result.stdout, /：0 条/);
  for (const who of whos) assert.ok(result.stdout.includes(`（${who}）`));
  assert.equal((result.stdout.match(/：还没做过活$/gm) ?? []).length, whos.length);
  const extra = await c.cli(['guide', '多余']); assert.equal(extra.code, 1); assert.match(extra.stderr, /参数数量不对/);
});

test('guideAppendix()：登记处连 jobs 目录都没有时不报错，也不联网查额度', async t => {
  const c = await context(t, false), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = join(c.temp, '空登记处');
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  const previousHome = process.env.HOME; process.env.HOME = join(c.temp, 'user-home');
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  const { guideAppendix } = await import('../src/core/guide.ts');
  const text = await guideAppendix();
  assert.ok(text.startsWith('## 这台机器现在的情况\n'));
  assert.match(text, /还没有额度数据/);
  assert.match(text, /：0 条/);
});

test('手册文件缺失、是空的或读不了：用人话说清楚放哪、怎么办，不报堆栈', async t => {
  const c = await context(t, false), tool = join(c.temp, '工具副本');
  await mkdir(tool);
  await cp(join(root, 'src'), join(tool, 'src'), { recursive: true });
  await cp(join(root, 'package.json'), join(tool, 'package.json'));
  // 用复制出来的工具副本跑命令：手册的位置跟着工具走，副本里没有 guide/ 就等于手册缺失。
  const run = () => exec(process.execPath, [join(tool, 'src/cli/cli.ts'), 'guide'], c.repo, { ...c.env, HOME: join(c.temp, 'user-home') });
  const missing = await run();
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /出错：找不到指挥手册：.*guide\/commander\.md。.*重新拉取仓库或重新安装/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
  assert.equal(missing.stdout, '');
  await mkdir(join(tool, 'guide'));
  await writeFile(join(tool, 'guide/commander.md'), '  \n');
  const empty = await run();
  assert.equal(empty.code, 1); assert.match(empty.stderr, /指挥手册是空的/);
  await writeFile(join(tool, 'guide/commander.md'), '# 临时手册\n');
  const fine = await run();
  assert.equal(fine.code, 0, fine.stderr);
  assert.ok(fine.stdout.startsWith('# 临时手册\n\n## 这台机器现在的情况'));
  // 路径指向目录：读不了，也是人话。
  const { readGuide } = await import('../src/core/guide.ts');
  await mkdir(join(c.temp, '目录手册/guide/commander.md'), { recursive: true });
  await assert.rejects(readGuide(join(c.temp, '目录手册')), /读不了指挥手册.*检查这个文件的权限/);
});

test('xagents guide 列出结束超过 1 小时还没拍板的活，刚结束的和拍过板的不列', async t => {
  const c = await context(t, false);
  const old = new Date(Date.now() - 3 * 3600_000).toISOString(), fresh = new Date(Date.now() - 10 * 60_000).toISOString();
  await put(c.home, 'old-forgotten', 'codex', { ended: old });
  await put(c.home, 'fresh-done', 'codex', { ended: fresh });
  await put(c.home, 'old-decided', 'codex', { ended: old, decision: { kind: 'adopt', at: old, by: 'lead' } });
  const r = await c.cli(['guide']); assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /结束超过 1 小时还没拍板的活（1 件/);
  assert.match(r.stdout, /old-forgotten（测试）题目 old-forgotten：结束于 3 小时前/);
  assert.doesNotMatch(r.stdout, /- fresh-done|- old-decided/);
  assert.match(r.stdout, /adopt <号> --merged <提交号>/);
});
