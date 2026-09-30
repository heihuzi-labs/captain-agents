import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { context } from './helpers.ts';
import { ensureHome } from '../src/core/paths.ts';
import { writeJson } from '../src/core/fsx.ts';
import { loadProject } from '../src/core/project.ts';
import { staticChecks, checkProject } from '../src/core/project-check.ts';
import type { CheckItem, DynamicChecks } from '../src/core/project-check.ts';

type Ctx = Awaited<ReturnType<typeof context>>;
// 在本进程里直接调核心：把登记处指到临时目录，测完还原。
async function core(t: Parameters<typeof context>[0], repository = true) {
  const c = await context(t, repository), before = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (before === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = before; });
  await ensureHome();
  return c;
}
// 直接写登记文件（非 git 目录登记不了，也方便带上额外字段）。
async function register(c: Ctx, extra: Record<string, unknown> = {}, name = '测试') {
  await writeJson(join(c.home, 'projects', `${name}.json`), { repo: c.repo, worktreeRoot: '.worktrees', setup: [], verify: [], denyReadExtra: [], ...extra });
  return loadProject(name);
}
const items = async (c: Ctx, extra: Record<string, unknown> = {}) => staticChecks(await register(c, extra));
const pick = (list: CheckItem[], id: string) => { const found = list.find(i => i.id === id); assert.ok(found, `缺少 ${id} 项`); return found; };
const touch = async (c: Ctx, ...files: string[]) => {
  for (const file of files) { await mkdir(join(c.repo, file, '..'), { recursive: true }); await writeFile(join(c.repo, file), 'x\n'); }
};
async function snapshot(c: Ctx) {
  return { status: await c.git(['status', '--porcelain', '--untracked-files=all']), index: (await readFile(join(c.repo, '.git/index'))).toString('hex'),
    files: (await readdir(c.repo, { recursive: true })).sort() };
}

test('git 项：正常、非 git 目录、目录不存在、没有提交、游离提交', async t => {
  const ok = await core(t);
  const good = pick(await items(ok), 'git');
  assert.equal(good.status, 'ok'); assert.match(good.detail, /当前分支 main/);
  await ok.git(['checkout', '--detach']);
  const detached = pick(await items(ok), 'git');
  assert.equal(detached.status, 'warn'); assert.ok(detached.fix);

  const plain = await core(t, false);
  const notGit = await items(plain);
  assert.equal(pick(notGit, 'git').status, 'fail'); assert.match(pick(notGit, 'git').detail, /不是 git 仓库/); assert.ok(pick(notGit, 'git').fix);
  assert.ok(!notGit.some(i => i.id === 'clean' || i.id === 'ignored'), '不是 git 仓库就不查提交相关项');
  assert.ok(notGit.some(i => i.id === 'verify'));

  await plain.git(['init', '-b', 'main']);
  const empty = pick(await items(plain), 'git');
  assert.equal(empty.status, 'fail'); assert.match(empty.detail, /没有任何提交/); assert.match(empty.fix!, /git commit/);

  const missing = await staticChecks({ name: 'x', repo: join(plain.temp, '不存在'), worktreeRoot: '.worktrees', setup: [], verify: [], denyReadExtra: [] });
  assert.equal(missing[0].status, 'fail'); assert.match(missing[0].detail, /找不到项目目录/);
  assert.ok(!missing.some(i => i.id === 'secrets'));
});

test('clean 项：干净、有未提交文件、副本目录里的变化不算', async t => {
  const c = await core(t);
  assert.equal(pick(await items(c), 'clean').status, 'ok');
  await touch(c, '.worktrees/xa-1/a.txt', '.worktrees/xa-1/b.txt');
  assert.equal(pick(await items(c), 'clean').status, 'ok', '副本目录里的变化不算');
  await touch(c, 'new.txt', 'dir/one.txt', 'dir/two.txt');
  await writeFile(join(c.repo, 'base.txt'), '改过\n');
  const dirty = pick(await items(c), 'clean');
  assert.equal(dirty.status, 'warn');
  assert.equal(dirty.detail, '有 4 个文件没提交，选手的副本看不到这些改动');
  assert.equal(dirty.fix, '先提交或自己收好再派活');
});

test('ignored 项：没忽略给出做法，写进 .git/info/exclude 或 .gitignore 后正常', async t => {
  const c = await core(t);
  const warn = pick(await items(c), 'ignored');
  assert.equal(warn.status, 'warn'); assert.match(warn.fix!, /\.gitignore/); assert.match(warn.fix!, /\.git\/info\/exclude/); assert.match(warn.fix!, /\.worktrees\//);
  await writeFile(join(c.repo, '.git/info/exclude'), '.worktrees/\n');
  assert.equal(pick(await items(c), 'ignored').status, 'ok');
  await writeFile(join(c.repo, '.git/info/exclude'), '');
  assert.equal(pick(await items(c), 'ignored').status, 'warn');
  await writeFile(join(c.repo, '.gitignore'), '.worktrees\n');
  assert.equal(pick(await items(c), 'ignored').status, 'ok');
  await writeFile(join(c.repo, '.gitignore'), '/.worktrees/*\n');
  assert.equal(pick(await items(c), 'ignored').status, 'ok');
  // 多级副本目录也认。
  await writeFile(join(c.repo, '.gitignore'), '.claude/\n');
  const nested = await staticChecks(await register(c, { worktreeRoot: '.claude/worktrees' }));
  assert.equal(pick(nested, 'ignored').status, 'ok');
});

test('secrets 项：只看文件名，几种名字都认，例外和跳过目录不算', async t => {
  const c = await core(t);
  assert.equal(pick(await items(c), 'secrets').status, 'ok');
  const bad = ['.env', '.env.local', 'app/.env.production', 'server.pem', 'keys/a.KEY', 'b.p12', 'id_rsa', 'id_rsa_old', 'credentials.json', 'credentials-prod.json', 'service-account.json', 'service-account-x.json', '.npmrc', '.netrc'];
  const fine = ['.env.example', '.env.sample', 'id_rsa.pub', 'keys/id_rsa_old.pub', 'notes.txt', 'keyboard.md', 'environment.ts', 'node_modules/pkg/.env', 'node_modules/pkg/a.pem', 'web/node_modules/.env', '.git/fake.pem', '.worktrees/xa-1/.env', '.worktrees/xa-1/x.key'];
  await touch(c, ...bad, ...fine);
  await chmod(join(c.repo, '.env'), 0o000); // 读不了也认得出来，说明没有读内容
  // 一次最多列 10 个，所以分两批用 denyReadExtra 挡掉一半来逐个核对。
  const first = pick(await items(c, { denyReadExtra: bad.slice(7) }), 'secrets'), second = pick(await items(c, { denyReadExtra: bad.slice(0, 7) }), 'secrets');
  for (const [found, names] of [[first, bad.slice(0, 7)], [second, bad.slice(7)]] as const) {
    assert.equal(found.status, 'warn');
    for (const name of names) assert.ok(found.detail.includes(name), `应该认出 ${name}：${found.detail}`);
    for (const name of fine) assert.ok(!found.detail.includes(name), `不该认 ${name}：${found.detail}`);
    assert.doesNotMatch(found.detail, /等 \d+ 个/);
  }
  const all = pick(await items(c), 'secrets');
  assert.match(all.detail, /等 14 个/);
  assert.match(first.fix!, /xagents project add 测试 '[^']*repo with spaces' .*--deny-read \.env /);
});

test('secrets 项：已在 denyReadExtra 里的不算（文件或目录），全都在里面就正常', async t => {
  const c = await core(t);
  await touch(c, '.env', 'secrets/a.pem', 'secrets/deep/b.key', 'other.pem');
  const some = pick(await items(c, { denyReadExtra: ['.env', './secrets/'] }), 'secrets');
  assert.equal(some.status, 'warn'); assert.match(some.detail, /other\.pem/);
  assert.doesNotMatch(some.detail, /\.env|secrets/);
  assert.match(some.fix!, /--deny-read \.env --deny-read '?\.\/secrets\/'? --deny-read other\.pem/, '重新登记的命令要带上已有的禁读');
  const none = pick(await items(c, { denyReadExtra: ['.env', 'secrets', 'other.pem'] }), 'secrets');
  assert.equal(none.status, 'ok');
});

test('secrets 项：超过 10 个只列 10 个并写“等 N 个”，恰好 10 个不写；带空格的路径在命令里加引号；命令带上原有登记', async t => {
  const c = await core(t);
  const names = Array.from({ length: 12 }, (_, i) => `k${String(i + 1).padStart(2, '0')}.pem`);
  await touch(c, ...names);
  const many = pick(await items(c, { setup: ['npm ci'], verify: ['npm test'] }), 'secrets');
  assert.match(many.detail, /k01\.pem/); assert.match(many.detail, /k10\.pem/); assert.doesNotMatch(many.detail, /k11\.pem|k12\.pem/);
  assert.match(many.detail, /等 12 个/);
  assert.match(many.fix!, /--setup 'npm ci' --verify 'npm test' --deny-read k01\.pem/);
  assert.doesNotMatch(many.fix!, /k11\.pem/);
  const ten = await core(t);
  await touch(ten, ...names.slice(0, 10), 'my secret.pem');
  const exact = pick(await items(ten, { denyReadExtra: ['k01.pem'] }), 'secrets');
  assert.doesNotMatch(exact.detail, /等 \d+ 个/); assert.match(exact.detail, /my secret\.pem/);
  assert.match(exact.fix!, /--deny-read 'my secret\.pem'/);
});

test('setup 和 verify 项：登记与否', async t => {
  const c = await core(t);
  const none = await items(c);
  assert.equal(pick(none, 'setup').status, 'ok'); assert.match(pick(none, 'setup').detail, /没登记/); assert.match(pick(none, 'setup').title, /没有装依赖的命令/);
  assert.equal(pick(none, 'verify').status, 'warn'); assert.equal(pick(none, 'verify').detail, '没有验收命令，交回的活只能靠人看'); assert.ok(pick(none, 'verify').fix);
  const set = await items(c, { setup: ['npm ci'], verify: ['npm test'] });
  assert.equal(pick(set, 'setup').status, 'ok'); assert.equal(pick(set, 'verify').status, 'ok');
  assert.deepEqual(set.map(i => i.id), ['git', 'clean', 'ignored', 'secrets', 'setup', 'verify']);
});

test('体检不改被检查的仓库；quick 写回登记且不跑动态检查，其他字段不丢', async t => {
  const c = await core(t);
  await touch(c, 'new.txt', '.env');
  await writeFile(join(c.repo, 'base.txt'), '改过\n');
  const before = await snapshot(c);
  await staticChecks(await register(c));
  assert.deepEqual(await snapshot(c), before);

  const baseline = { at: '2026-01-01T00:00:00.000Z', ok: false, steps: [{ cmd: 'npm test', ok: false, exit: 1, summary: '没过' }] };
  await register(c, { rules: '/tmp/rules.md', verifyTimeoutMinutes: 7, something: { nested: [1, 2] }, verify: ['npm test'], baseline });
  const result = await checkProject('测试', { quick: true }, { dynamic: async () => { throw new Error('quick 不许跑动态检查'); } });
  assert.deepEqual(await snapshot(c), before, '体检前后仓库一样');
  assert.equal(result.ok, true); assert.ok(Date.parse(result.at)); assert.equal(typeof result.seconds, 'number');
  const saved = JSON.parse(await readFile(join(c.home, 'projects/测试.json'), 'utf8'));
  assert.deepEqual(saved.check, result);
  assert.deepEqual(saved.baseline, baseline, 'quick 不动验收底子');
  assert.deepEqual({ ...saved, check: undefined }, { repo: c.repo, worktreeRoot: '.worktrees', setup: [], verify: ['npm test'], denyReadExtra: [], rules: '/tmp/rules.md', verifyTimeoutMinutes: 7, something: { nested: [1, 2] }, baseline, check: undefined });
  assert.deepEqual((await loadProject('测试')).check, result);
  assert.ok(result.items.some(i => i.id === 'secrets' && i.status === 'warn'));
  await assert.rejects(() => checkProject('../外面', { quick: true }));
});

test('quick 遇到 fail：ok 为 false 也照样写回', async t => {
  const c = await core(t, false);
  await register(c);
  const result = await checkProject('测试', { quick: true });
  assert.equal(result.ok, false);
  assert.equal((await loadProject('测试')).check?.ok, false);
});

test('完整体检：合并动态检查（同名项替换、新项接在后面），保存验收底子；没有底子就清掉旧的', async t => {
  const c = await core(t);
  await register(c, { verify: ['npm test'], baseline: { at: 'old', ok: true, steps: [] } });
  const baseline = { at: '2026-02-02T00:00:00.000Z', ok: false, steps: [{ cmd: 'npm test', ok: false, exit: 1, summary: '没过 2 项' }] };
  const calls: string[] = [];
  const dynamic: DynamicChecks = async project => {
    calls.push(project.name);
    return { items: [{ id: 'verify', title: '主干本来就没过', status: 'warn', detail: '有 1 项没过' }, { id: 'extra', title: '另一项', status: 'fail', detail: '不行', fix: '修一下' }], baseline };
  };
  const result = await checkProject('测试', {}, { dynamic });
  assert.deepEqual(calls, ['测试']);
  assert.deepEqual(result.items.map(i => i.id), ['git', 'clean', 'ignored', 'secrets', 'setup', 'verify', 'extra']);
  assert.equal(pick(result.items, 'verify').title, '主干本来就没过');
  assert.equal(result.ok, false);
  const saved = await loadProject('测试');
  assert.deepEqual(saved.check, result); assert.deepEqual(saved.baseline, baseline);

  const second = await checkProject('测试', {}, { dynamic: async () => ({ items: [] }) });
  assert.equal(second.ok, true);
  assert.equal((await loadProject('测试')).baseline, undefined);
});

test('命令行：project add 后打印快速体检；project check 人话输出、--json、退出码', async t => {
  const c = await context(t);
  const add = await c.add(['--verify', 'true']);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /已登记项目 测试/);
  assert.match(add.stdout, /接入体检（快速）/);
  assert.match(add.stdout, /✓ 是 git 仓库并且有提交\n {4}当前分支 main/);
  assert.match(add.stdout, /! 副本目录没被 git 忽略\n {4}.*\n {4}怎么修：/);
  assert.match(add.stdout, /xagents project check 测试/);
  assert.match(add.stdout, /可以派活/);
  assert.ok(JSON.parse(await readFile(join(c.home, 'projects/测试.json'), 'utf8')).check.items.length >= 5, '登记后已写入体检结果');

  const human = await c.cli(['project', 'check', '测试', '--quick']);
  assert.equal(human.code, 0, human.stderr);
  const lines = human.stdout.trim().split('\n');
  assert.equal(lines[0], '✓ 是 git 仓库并且有提交');
  assert.equal(lines.at(-1), '可以派活');
  assert.ok(lines.some(l => /^! /.test(l)));

  const json = await c.cli(['project', 'check', '测试', '--quick', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.equal(data.ok, true); assert.ok(Array.isArray(data.items)); assert.ok(data.at); assert.equal(typeof data.seconds, 'number');
  assert.equal(data.items[0].id, 'git');
  assert.ok(!('baseline' in data), '还没有验收底子时不带 baseline');

  const file = join(c.home, 'projects/测试.json'), record = JSON.parse(await readFile(file, 'utf8'));
  record.baseline = { at: '2026-02-02T00:00:00.000Z', ok: true, steps: [] };
  await writeFile(file, JSON.stringify(record));
  const withBaseline = JSON.parse((await c.cli(['project', 'check', '测试', '--quick', '--json'])).stdout);
  assert.deepEqual(withBaseline.baseline, record.baseline);

  assert.equal((await c.cli(['project', 'check', '没这个项目', '--quick'])).code, 1);
  assert.equal((await c.cli(['project', 'check'])).code, 1);
  assert.match((await c.cli(['--help'])).stdout, /xagents project check <名字> \[--quick\] \[--json\]/);
});

test('命令行：有不行的项退出码为 1，登记本身仍成功', async t => {
  const c = await context(t, false);
  await c.git(['init', '-b', 'main']);
  const add = await c.add();
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /✗ 是 git 仓库并且有提交\n {4}仓库里还没有任何提交/);
  assert.match(add.stdout, /先处理 1 个问题再派活/);
  const check = await c.cli(['project', 'check', '测试', '--quick']);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /先处理 1 个问题再派活\s*$/);
  const json = await c.cli(['project', 'check', '测试', '--quick', '--json']);
  assert.equal(json.code, 1); assert.equal(JSON.parse(json.stdout).ok, false);
});
