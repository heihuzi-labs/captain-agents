import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, desktopView, root } from './helpers.ts';

test('归档在派活的所有副作用前拦截：指定或推断项目、force 均不能绕过；取消后能派活', async t => {
  const c = await context(t); assert.equal((await c.add()).code, 0);
  const config = join(c.home, 'config.json');
  await writeFile(config, JSON.stringify({ archivedProjects: ['测试'] }));
  const before = await readdir(c.home, { recursive: true });
  const worktrees = await c.git(['worktree', 'list', '--porcelain']);
  const marker = join(c.temp, 'queries');
  const extra = { XAGENTS_QUERY_EXEC: join(root, 'test/fixtures/quota/query.ts'), XAGENTS_CODEX_SESSIONS: join(root, 'test/fixtures/quota'), XA_QUERY_MARKER: marker };
  const run = ['run', c.task, '--summary', '验证归档派活拦截', '--who', 'codex:high'];
  for (const project of [[], ['--project', '测试']]) {
    for (const force of [[], ['--force']]) {
      const denied = await c.cli([...run, ...project, ...force], extra);
      assert.equal(denied.code, 1);
      assert.match(denied.stderr, /项目 测试 已归档。要派活先取消归档：xagents project unarchive 测试/);
    }
  }
  assert.deepEqual(await readdir(c.home, { recursive: true }), before, '不能留下任务、批次、额度缓存、图标或锁目录');
  assert.deepEqual(await c.jobs(), []);
  assert.equal(await c.git(['worktree', 'list', '--porcelain']), worktrees);
  await assert.rejects(access(join(c.repo, '.worktrees')), { code: 'ENOENT' });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  await writeFile(config, JSON.stringify({ archivedProjects: [] }));
  const launched = await c.cli(run, extra);
  assert.equal(launched.code, 0, launched.stderr);
  const [job] = await c.jobs(); assert.ok(job);
  assert.equal((await c.cli(['wait', job.id])).code, 0);
  assert.ok((await readFile(marker, 'utf8')).trim(), '取消归档后确实走到额度查询');
});

test('project list 标明归档、guide 机器情况有归档才写，看板字段随设置变化', async t => {
  const c = await context(t); assert.equal((await c.add()).code, 0);
  const config = join(c.home, 'config.json');
  for (const archived of [true, false]) {
    await writeFile(config, JSON.stringify({ archivedProjects: archived ? ['测试'] : [] }));
    const list = await c.cli(['project', 'list']); assert.equal(list.code, 0, list.stderr);
    assert.equal(list.stdout.includes('测试（已归档）'), archived);
    const guide = await c.cli(['guide']); assert.equal(guide.code, 0, guide.stderr);
    const appendix = guide.stdout.split('## 这台机器现在的情况')[1];
    assert.ok(appendix); assert.equal(appendix.includes('已归档项目：测试。'), archived);
    assert.equal((await desktopView(c.home)).projects.find(p => p.name === '测试')?.archived, archived);
  }
});

test('project archive/unarchive：记进设置、重复操作不报错；任务里出现过的项目也能归档；不存在、坏名字用人话报错；并发不丢', async t => {
  const c = await context(t); assert.equal((await c.add()).code, 0);
  const archived = async () => JSON.parse(await readFile(join(c.home, 'config.json'), 'utf8')).archivedProjects;
  for (let i = 0; i < 2; i++) { const r = await c.cli(['project', 'archive', '测试']); assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /已归档 测试/); }
  assert.deepEqual(await archived(), ['测试']);
  for (let i = 0; i < 2; i++) assert.equal((await c.cli(['project', 'unarchive', '测试'])).code, 0);
  assert.deepEqual(await archived(), []);
  const missing = await c.cli(['project', 'archive', '没有这个']); assert.equal(missing.code, 1); assert.match(missing.stderr, /没有叫 没有这个 的项目/);
  const bad = await c.cli(['project', 'archive', '../坏']); assert.equal(bad.code, 1); assert.match(bad.stderr, /名字只能包含/);
  // 任务里出现过、没登记的项目也能归档。
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(c.home, 'jobs', 'ghost'), { recursive: true });
  await writeFile(join(c.home, 'jobs', 'ghost', 'job.json'), JSON.stringify({ id: 'ghost', batch: '', project: '旧项目', repo: c.repo, base: 'x', worktree: '/tmp/none', branch: 'x', who: 'codex', model: 'm', effort: 'high', mode: 'read-only', kind: '实现', title: '旧活', summary: '旧活', state: 'done', created: new Date().toISOString(), ended: new Date().toISOString() }));
  // 两个项目同时归档：名单里两个都在（在设置的锁里读改写）。
  const [a, b] = await Promise.all([c.cli(['project', 'archive', '测试']), c.cli(['project', 'archive', '旧项目'])]);
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(await archived(), ['测试', '旧项目'].sort((x, y) => x.localeCompare(y, 'zh-CN')));
  assert.deepEqual((await desktopView(c.home)).projects.filter((p: { archived: boolean }) => p.archived).map((p: { name: string }) => p.name).sort(), ['旧项目', '测试'].sort());
});
