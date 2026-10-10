import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, stat, mkdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { selection, command, refreshGrokLogin, checkDeepseekLogin, loginDeepseek, KEY_VARS, cursorToken, checkCursorLogin } from '../src/core/workers.ts';
import { codexEnvPolicy, isSecretName, PLATFORM_SWITCHES } from '../src/core/env.ts';
import { extraDenyRead } from '../src/core/settings.ts';
import { whos, workerDisplay, isolationOf, allowedEfforts, launchModels, vendorOf } from '../src/core/roster.ts';
import { sandbox, codexPermissions, grokSessionDirs, cursorStateDir, jobTmpDir, keychainDirs, SHELL_FILES, CREDENTIAL_FILES } from '../src/core/sandbox.ts';
import type { Job, Who } from '../src/core/job.ts';
import type { Project } from '../src/core/project.ts';
import { context, root } from './helpers.ts';

function job(who: Who, ro = false, spec = `${who}:high`): Job {
  const s = selection(spec);
  return { id: '0929-1000-test', batch: 'batch', who, model: s.model, effort: s.effort, ...(s.fast ? { fast: true } : {}), repo: '/test/repo', worktree: '/test/repo/worktree', branch: 'xa/test', base: '123', project: '测试', title: '测试', kind: '实现', mode: ro ? 'read-only' : 'workspace-write', state: 'queued', created: new Date().toISOString() };
}
test('推理强度只开中档、高档、超高档，不许 max 和 low；DeepSeek 只开高档（它的超高档会被换算成拉满）', () => {
  const native = whos.filter(w => !w.startsWith('deepseek'));
  for (const who of native) for (const effort of ['medium', 'high', 'xhigh']) assert.equal(selection(`${who}:${effort}`).effort, effort);
  for (const who of native) for (const effort of ['max', 'low', 'minimal', '', 'HIGH']) assert.throws(() => selection(`${who}:${effort}`), /推理强度只允许：medium（中档）、high（高档）、xhigh（超高档）/);
  for (const who of ['deepseek', 'deepseek-flash']) {
    assert.equal(selection(`${who}:high`).effort, 'high');
    for (const effort of ['medium', 'xhigh', 'max', 'low']) assert.throws(() => selection(`${who}:${effort}`), /推理强度只允许：high（高档）/);
    assert.throws(() => selection(`${who}:high:fast`), /DeepSeek 没有快速版/);
  }
  assert.equal(selection('deepseek:high').model, 'deepseek-v4-pro'); assert.equal(selection('deepseek-flash:high').model, 'deepseek-flash');
  for (const spec of ['codex', 'unknown:high', '__proto__:high', 'codex:high:fast:x', 'grok:high:slow', 'grok:high:', 'grok:high:FAST']) assert.throws(() => selection(spec));
  assert.throws(() => selection('unknown:high'), /codex、codex-luna、grok、cursor-grok、cursor-opus、cursor-sonnet、deepseek、deepseek-flash/);
});
test('各选手 × 强度 × 快速版：模型名正确，任务里记下 fast', () => {
  const expected: Record<string, [string, string]> = {
    codex: ['gpt-6-astra', ''], grok: ['grok-4.7', 'grok-4.7-build-fast'],
    'cursor-grok': ['grok-4.7-<e>', 'grok-4.7-<e>-fast'], 'cursor-opus': ['claude-opus-5-5-<e>', 'claude-opus-5-5-<e>-fast'], 'cursor-sonnet': ['claude-sonnet-5-5-<e>', ''],
  };
  for (const [who, [plain, fast]] of Object.entries(expected)) for (const effort of ['medium', 'high', 'xhigh']) {
    assert.deepEqual(selection(`${who}:${effort}`), { who, effort, model: plain.replace('<e>', effort) });
    if (fast) assert.deepEqual(selection(`${who}:${effort}:fast`), { who, effort, model: fast.replace('<e>', effort), fast: true });
    else assert.throws(() => selection(`${who}:${effort}:fast`), /没有快速版/);
  }
  assert.equal(selection('grok:medium:fast').model, 'grok-4.7-build-fast');
  assert.equal(selection('cursor-grok:high:fast').model, 'grok-4.7-high-fast');
  assert.equal(selection('cursor-opus:high:fast').model, 'claude-opus-5-5-high-fast');
  assert.throws(() => selection('codex:high:fast'), /还没核实官方文档/);
  assert.throws(() => selection('cursor-sonnet:medium:fast'), /Sonnet 5.5 没有快速版[\s\S]*grok、cursor-grok、cursor-opus/);
  assert.throws(() => selection('grok:high:slow'), /第三段只能写 fast/);
});
test('选手清单是唯一出处：展示表、隔离、额度池都从它派生，Cursor 只用三家模型，强度过底线', () => {
  assert.deepEqual(whos, ['codex', 'codex-luna', 'grok', 'cursor-grok', 'cursor-opus', 'cursor-sonnet', 'deepseek', 'deepseek-flash']);
  assert.deepEqual(workerDisplay.deepseek, { name: 'DeepSeek', model: 'DeepSeek V4 Pro', icon: 'deepseek' });
  assert.deepEqual(whos.map(vendorOf), ['codex', 'codex', 'grok', 'cursor', 'cursor', 'cursor', 'deepseek', 'deepseek']);
  assert.deepEqual(workerDisplay['codex-luna'], { name: 'Codex · Luna', model: 'GPT-6 Luna', icon: 'codex' });
  assert.deepEqual(workerDisplay['cursor-sonnet'], { name: 'Cursor · Sonnet', model: 'Claude Sonnet 5.5', icon: 'cursor', badge: 'claude' });
  assert.deepEqual(workerDisplay.grok, { name: 'Grok', model: 'Grok 4.7', icon: 'grok' });
  assert.deepEqual(whos.map(isolationOf), ['codex', 'codex', 'grok', 'cursor', 'cursor', 'cursor', 'codex', 'codex']);
  for (const who of whos) {
    assert.deepEqual(allowedEfforts(who), who.startsWith('deepseek') ? ['high'] : ['medium', 'high', 'xhigh']);
    for (const m of launchModels().filter(x => x.who === who)) if (isolationOf(who) === 'cursor') assert.match(m.model, /^(claude|gpt|grok)-/);
  }
  assert.ok(launchModels().every(m => !/max|low/.test(m.model.replace('build', ''))));
});
test('srt 模板保留安全设置，只读不开放副本，额外敏感路径加两份', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home;
  const p = { denyReadExtra: ['.data', 'secret-dir'] } as Project;
  for (const who of whos.filter(w => w !== 'codex')) {
    const writable = await sandbox(job(who), p), readonly = await sandbox(job(who, true), p);
    assert.ok(writable.filesystem.allowWrite.includes('/test/repo/worktree'));
    assert.ok(!readonly.filesystem.allowWrite.includes('/test/repo/worktree'));
    // 只读题也有任务自己的 tmp；公用临时目录一律不放开。
    assert.ok(readonly.filesystem.allowWrite.includes(jobTmpDir(job(who, true))));
    for (const shared of ['/private/tmp', '/private/var/folders', '/tmp']) assert.ok(!readonly.filesystem.allowWrite.includes(shared), shared);
    assert.ok(readonly.filesystem.denyRead.includes('/test/repo/.data'));
    assert.ok(readonly.filesystem.denyRead.includes('/test/repo/worktree/.data'));
    assert.ok(readonly.filesystem.denyRead.includes('~/.ssh'));
    assert.deepEqual(writable.network, readonly.network);
    assert.equal(readonly.network.allowLocalBinding, undefined);
  }
});
test('cursor-sonnet 沿用 Cursor 的隔离模板，不新开模板', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home;
  const p = { denyReadExtra: ['.data'] } as Project;
  for (const ro of [false, true]) assert.deepEqual(await sandbox(job('cursor-sonnet', ro), p), await sandbox(job('cursor-grok', ro), p));
  const file = JSON.parse(await readFile(join(root, 'sandbox/cursor.json'), 'utf8'));
  // 整个 ~/.grok 都禁读：没登录 Grok 时自检能凭“文件夹也读不到”确认挡住（2026-10-08）。
  assert.ok(file.filesystem.denyRead.includes('~/.grok') && file.filesystem.denyRead.includes('~/.ssh') && file.filesystem.denyRead.includes('~/.npmrc'));
  assert.ok(!file.filesystem.denyRead.includes('~/.cursor/cli-config.json'));
  assert.deepEqual((await readdir(join(root, 'sandbox'))).sort(), ['cursor.json', 'grok.json']);
});
test('四种命令使用指定安全参数、模型、输入输出和环境变量', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home;
  const oldFake = process.env.XAGENTS_FAKE_WORKER, oldSrt = process.env.XAGENTS_SRT, oldCodex = process.env.XAGENTS_CODEX;
  t.after(() => {
    for (const [key, value] of Object.entries({ XAGENTS_FAKE_WORKER: oldFake, XAGENTS_SRT: oldSrt, XAGENTS_CODEX: oldCodex })) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  delete process.env.XAGENTS_FAKE_WORKER;
  process.env.XAGENTS_SRT = join(c.temp, 'fake-srt.js'); await writeFile(process.env.XAGENTS_SRT, '');
  process.env.XAGENTS_CODEX = '/test/codex';
  const codex = await command(job('codex', true), '题目', { denyReadExtra: [] });
  assert.equal(codex.file, '/test/codex'); assert.equal(codex.stdin, 'prompt');
  for (const feature of ['plugins', 'apps', 'remote_plugin', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'hooks', 'memories']) {
    assert.ok(codex.args.some((v, i) => v === '--disable' && codex.args[i + 1] === feature));
  }
  assert.ok(codex.args.includes('--ignore-user-config')); assert.ok(codex.args.includes(codexPermissions(job('codex', true), { denyReadExtra: [] })));
  // Codex 的 :workspace 放开 $TMPDIR：指向任务的 tmp，并由启动前建好。
  const tmp = join(c.home, 'jobs', '0929-1000-test', 'tmp');
  assert.deepEqual(codex.env, { TMPDIR: tmp }); assert.ok((await stat(tmp)).isDirectory());
  assert.ok(codex.args.includes('model_reasoning_effort="high"'));
  // 普通 Codex 不带 DeepSeek 的配置，Codex 文件夹仍是主人自己的。
  assert.ok(!codex.args.some(v => v.includes('model_provider') || v.includes('api.deepseek.com'))); assert.equal(codex.env.CODEX_HOME, undefined);
  // DeepSeek 借 Codex 跑：同一套隔离，Codex 文件夹换成登记处下单独的那个，连 DeepSeek 的接口，选手的命令去掉带钥匙的环境变量。
  const ds = await command(job('deepseek', true, 'deepseek:high'), '题目', { denyReadExtra: [] });
  assert.equal(ds.file, '/test/codex'); assert.equal(ds.stdin, 'prompt');
  assert.deepEqual(ds.env, { TMPDIR: tmp, CODEX_HOME: join(c.home, 'deepseek') });
  for (const value of ['model_provider="deepseek"', 'forced_login_method="api"', 'cli_auth_credentials_store="file"', 'web_search="disabled"', 'default_permissions="xa"', 'deepseek-v4-pro', 'model_reasoning_effort="high"']) assert.ok(ds.args.includes(value), value);
  assert.ok(ds.args.some(v => v.startsWith('model_providers.deepseek=') && v.includes('base_url="https://api.deepseek.com/"') && v.includes('requires_openai_auth=true')));
  // Codex 自己那一层：选手的命令去掉带密钥字样的变量，DeepSeek 另外点名去掉 KEY_VARS（有两个不带这些字样）。
  assert.ok(ds.args.includes(codexEnvPolicy(KEY_VARS))); assert.ok(codex.args.includes(codexEnvPolicy()));
  for (const name of ['OPENAI_FEDERATION_RULE_ID', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT']) assert.ok(codexEnvPolicy(KEY_VARS).includes(`"${name}"`), name);
  // Codex 主进程本身也不能继承别家的钥匙（这些变量在 Codex 里比登录文件优先）；普通 Codex 不受影响。
  assert.deepEqual(ds.unset, KEY_VARS); assert.equal(codex.unset, undefined);
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT']) assert.ok(KEY_VARS.includes(name), name);
  assert.ok(ds.args.includes('--ignore-user-config')); assert.ok(ds.args.includes(codexPermissions(job('deepseek', true, 'deepseek:high'), { denyReadExtra: [] })));
  // 三种隔离都禁读终端配置文件和命令历史（主人常把钥匙写在里面，Grok 的登录式 bash 还会自动读），以及常见的登录凭据文件。
  for (const f of [...SHELL_FILES, ...CREDENTIAL_FILES]) {
    assert.ok(codexPermissions(job('codex', true), { denyReadExtra: [] }).includes(`"${join(homedir(), f)}"="deny"`), f);
    for (const who of ['grok', 'cursor-grok'] as Who[]) assert.ok((await sandbox(job(who), { denyReadExtra: [] })).filesystem.denyRead.includes(join(homedir(), f)), `${who} ${f}`);
  }
  // 三种隔离都禁读 DeepSeek 的登录文件夹。
  assert.ok(codexPermissions(job('codex', true), { denyReadExtra: [] }).includes(`"${join(c.home, 'deepseek')}"="deny"`));
  const grok = await command(job('grok'), '题目', { denyReadExtra: [] });
  assert.equal(Object.keys(grok.env).length, 13); assert.equal(Object.values(grok.env).filter(v => v === 'false').length, 10);
  // srt 用 CLAUDE_CODE_TMPDIR 给选手设 TMPDIR（不设就是公用的 /tmp/claude）。
  assert.equal(grok.env.CLAUDE_CODE_TMPDIR, tmp);
  assert.equal(grok.env.GROK_MEMORY, '0'); assert.equal(grok.env.GROK_DISABLE_AUTOUPDATER, '1');
  assert.ok(grok.args.includes('--always-approve')); assert.equal(grok.output, 'run.log');
  assert.equal(grok.args[grok.args.indexOf('--output-format') + 1], 'streaming-json');
  // 推理强度跟随任务，不写死；快速版换成 grok-4.7-build-fast；Codex 的中档同样传下去。
  for (const effort of ['medium', 'high', 'xhigh']) {
    const g = await command(job('grok', false, `grok:${effort}`), '题目', { denyReadExtra: [] });
    assert.equal(g.args[g.args.indexOf('--effort') + 1], effort); assert.equal(g.args[g.args.indexOf('-m') + 1], 'grok-4.7');
    const c2 = await command(job('codex', false, `codex:${effort}`), '题目', { denyReadExtra: [] });
    assert.ok(c2.args.includes(`model_reasoning_effort="${effort}"`)); assert.equal(c2.args[c2.args.indexOf('-m') + 1], 'gpt-6-astra');
  }
  const gf = await command(job('grok', false, 'grok:medium:fast'), '题目', { denyReadExtra: [] });
  assert.equal(gf.args[gf.args.indexOf('-m') + 1], 'grok-4.7-build-fast'); assert.equal(gf.args[gf.args.indexOf('--effort') + 1], 'medium');
  // 任务专用 TMPDIR 可能很长，参数测试用替身跳过长度限制；真实长度边界在下面单独验证。
  process.env.XAGENTS_FAKE_WORKER = join(root, 'test/fixtures/worker.ts');
  for (const [spec, model] of [['cursor-sonnet:medium', 'claude-sonnet-5-5-medium'], ['cursor-sonnet:xhigh', 'claude-sonnet-5-5-xhigh'], ['cursor-grok:high:fast', 'grok-4.7-high-fast'], ['cursor-opus:medium:fast', 'claude-opus-5-5-medium-fast']]) {
    const cursor = await command(job(spec.split(':')[0] as Who, false, spec), '题目', { denyReadExtra: [] });
    assert.equal(cursor.args[cursor.args.indexOf('--model') + 1], model);
    assert.ok(cursor.args.includes('--force')); assert.ok(!cursor.args.includes('--mode')); assert.equal(cursor.args.at(-1), '题目');
  }
  for (const who of ['cursor-grok', 'cursor-opus', 'cursor-sonnet'] as Who[]) {
    const cursor = await command(job(who, true), '保留空格、引号和 $() 的题目', { denyReadExtra: [] });
    // Cursor 会变的状态搬进登记处的短目录，只读题也一样；目录由启动前建好。
    const state = cursorStateDir(job(who, true));
    // 登录不在命令里：看管进程启动前现取（login: 'cursor'），Cursor 只在内存里记登录。
    assert.deepEqual(cursor.env, { CLAUDE_CODE_TMPDIR: jobTmpDir(job(who, true)), CURSOR_CONFIG_DIR: join(state, 'config'), CURSOR_DATA_DIR: join(state, 'data'), AGENT_CLI_CREDENTIAL_STORE: 'memory' });
    assert.equal(cursor.login, 'cursor');
    for (const dir of [cursor.env.CLAUDE_CODE_TMPDIR, cursor.env.CURSOR_CONFIG_DIR, cursor.env.CURSOR_DATA_DIR]) assert.ok((await stat(dir)).isDirectory());
    assert.ok(cursor.args.includes('--force')); assert.ok(cursor.args.includes('--trust')); assert.ok(cursor.args.includes('ask'));
    assert.equal(cursor.output, 'run.log');
    assert.equal(cursor.args[cursor.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(cursor.args.at(-1), '保留空格、引号和 $() 的题目');
  }
  // 平台自己给选手设的变量照给（不过 env.ts 的过滤），所以名字都不许带密钥字样；要加这种变量先改 env.ts 的说明。
  for (const who of whos) for (const ro of [false, true]) {
    const cmd = await command(job(who, ro), '题目', { denyReadExtra: [] });
    for (const name of Object.keys(cmd.env)) assert.ok(!isSecretName(name) || PLATFORM_SWITCHES.includes(name), `${who}: ${name}`);
  }
  delete process.env.XAGENTS_FAKE_WORKER;
  process.env.XAGENTS_SRT = join(c.temp, 'missing.js');
  await assert.rejects(command(job('grok'), '', { denyReadExtra: [] }), /找不到 srt/);
  process.env.XAGENTS_FAKE_WORKER = join(root, 'test/fixtures/worker.ts');
  const fake = await command(job('grok'), '', { denyReadExtra: [] });
  assert.equal(fake.file, process.execPath); assert.equal(fake.args[0], process.env.XAGENTS_FAKE_WORKER);
  assert.ok(fake.args.includes('--settings')); assert.equal(Object.keys(fake.env).length, 13);
});

test('Codex 权限表完整禁读、开口 tmp、合并项目双份路径并去重', async () => {
  const { homedir } = await import('node:os');
  const p = { denyReadExtra: ['.data', 'secret-dir', '.data'] };
  for (const ro of [false, true]) {
    const j = job('codex', ro), table = codexPermissions(j, p);
    assert.ok(table.startsWith(`permissions.xa={extends="${ro ? ':read-only' : ':workspace'}",filesystem={`));
    for (const entry of ['.ssh', '.codex', '.grok', '.cursor', '.aws', '.claude', '.config/gh', '.npmrc']) assert.ok(table.includes(`${JSON.stringify(join(homedir(), entry))}="deny"`), entry);
    assert.ok(table.includes(`${JSON.stringify(join(homedir(), '.codex/tmp'))}="read"`));
    // 钥匙串的两个文件夹（本用户的、系统的）都禁读。
    for (const dir of keychainDirs()) assert.ok(table.includes(`${JSON.stringify(dir)}="deny"`), dir);
    // 公用的 /tmp 只读，只有任务自己的 tmp 可写。
    assert.ok(table.includes(`":slash_tmp"="read"`)); assert.ok(table.includes(`":tmpdir"="read"`)); assert.ok(table.includes(`${JSON.stringify(jobTmpDir(j))}="write"`));
    for (const base of [j.repo, j.worktree]) for (const extra of p.denyReadExtra) {
      assert.equal(table.split(`${JSON.stringify(join(base, extra))}="deny"`).length - 1, 1);
    }
  }
});

test('Codex TOML 路径转义引号和反斜杠，保留空格中文，拒绝控制字符和越界路径', () => {
  const j = { ...job('codex'), repo: '/仓库 空格"反\\斜', worktree: '/副本 空格"反\\斜' };
  const extra = '目录 空格"反\\斜';
  const table = codexPermissions(j, { denyReadExtra: [extra] });
  for (const root of [j.repo, j.worktree]) assert.ok(table.includes(`${JSON.stringify(join(root, extra))}="deny"`));
  for (const char of ['\n', '\r', '\t', '\0', '\x1f', '\x7f', '\x85']) {
    assert.throws(() => codexPermissions(j, { denyReadExtra: [`secret${char}/..hidden`] }), /控制字符/);
    assert.throws(() => codexPermissions({ ...j, repo: `/repo${char}` }, { denyReadExtra: ['secret'] }), /控制字符/);
    assert.throws(() => codexPermissions({ ...j, worktree: `/worktree${char}` }, { denyReadExtra: ['secret'] }), /控制字符/);
  }
  for (const extra of ['../escape', '/absolute', '.', '', 'x/../../escape', '..\\escape']) assert.throws(() => codexPermissions(j, { denyReadExtra: [extra] }), /路径必须/);
});

test('Codex 最终参数只换权限档，其余完全保留，绝不混用 -s 或 sandbox_mode', async t => {
  const c = await context(t, false);
  const oldHome = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (oldHome === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = oldHome; });
  const oldFake = process.env.XAGENTS_FAKE_WORKER; delete process.env.XAGENTS_FAKE_WORKER;
  t.after(() => { if (oldFake !== undefined) process.env.XAGENTS_FAKE_WORKER = oldFake; });
  const p = { denyReadExtra: ['秘密 目录'] };
  for (const ro of [false, true]) {
    const j = job('codex', ro);
    const actual = await command(j, '题目', p);
    assert.deepEqual(actual.args, ['exec', '--ignore-user-config',
      '--disable', 'plugins', '--disable', 'apps', '--disable', 'remote_plugin', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'in_app_browser', '--disable', 'hooks', '--disable', 'memories',
      '-c', codexEnvPolicy(), '-m', j.model, '-c', 'model_reasoning_effort="high"', '-c', 'default_permissions="xa"', '-c', codexPermissions(j, p),
      '-C', j.worktree, '--json', '-o', join(c.home, 'jobs', j.id, 'final.md'), '-']);
    assert.ok(!actual.args.includes('-s')); assert.ok(!actual.args.includes('--sandbox'));
    assert.ok(!actual.args.some(arg => arg.includes('sandbox_mode')));
  }
});

test('srt 新增 npmrc 禁读且不丢失任何已有禁读条目；选手自己的登录文件必须能读', async () => {
  const own = { grok: '~/.grok/auth.json', 'cursor-grok': '~/.cursor/cli-config.json' } as Record<string, string>;
  const other = { grok: '~/.cursor/cli-config.json', 'cursor-grok': '~/.grok' } as Record<string, string>;
  for (const who of ['grok', 'cursor-grok'] as Who[]) {
    const config = await sandbox(job(who), { denyReadExtra: [] } as unknown as Project);
    for (const path of ['~/.ssh', '~/.codex', '~/.aws', '~/.claude', '~/.config/gh', '~/.npmrc', '~/Library/Keychains', '/Library/Keychains', other[who]]) assert.ok(config.filesystem.denyRead.includes(path), `${who}: ${path}`);
    // 整个选手跑在外层隔离里，禁读自己的登录文件它就启动不了。
    assert.ok(!config.filesystem.denyRead.includes(own[who]), `${who} 不能禁读自己的登录文件`);
  }
});

test('各家全局配置和公用临时目录对选手只读：模板只放开副本、任务的 tmp 和各自搬走的状态', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home;
  const p = { denyReadExtra: [] } as unknown as Project;
  for (const name of ['cursor', 'grok']) {
    const file = JSON.parse(await readFile(join(root, `sandbox/${name}.json`), 'utf8'));
    assert.ok(file.filesystem.allowWrite.every((path: string) => !path.startsWith('~') && !path.startsWith(homedir())), name);
    // srt 自己默认放开的公用 /tmp/claude 和 ~/.npm/_logs 显式禁写。
    assert.deepEqual(file.filesystem.denyWrite, ['/private/tmp/claude', '~/.npm/_logs']);
  }
  const tmp = jobTmpDir(job('cursor-sonnet'));
  const cursor = await sandbox(job('cursor-sonnet'), p);
  assert.deepEqual(cursor.filesystem.allowWrite, ['/test/repo/worktree', cursorStateDir(job('cursor-sonnet')), tmp]);
  assert.deepEqual((await sandbox(job('cursor-sonnet', true), p)).filesystem.allowWrite, [cursorStateDir(job('cursor-sonnet')), tmp]);
  const grok = await sandbox(job('grok'), p), session = join(homedir(), '.grok/sessions', '%2Ftest%2Frepo%2Fworktree');
  assert.deepEqual(grok.filesystem.allowWrite, ['/test/repo/worktree', session, tmp]);
  assert.deepEqual((await sandbox(job('grok', true), p)).filesystem.allowWrite, [session, tmp]);
  for (const config of [cursor, grok]) for (const path of config.filesystem.allowWrite) {
    assert.ok(!['.cursor', '.grok', '.local', '.claude', '.agents', '.codex'].some(dir => path === join(homedir(), dir)), path);
  }
});
test('Grok 会话文件夹按副本路径逐段转义；中文、特殊字符两种写法、真实路径都覆盖', async t => {
  const c = await context(t, false);
  const sessions = join(homedir(), '.grok/sessions');
  assert.deepEqual(await grokSessionDirs('/不存在/示例 项目/x.y-z'), [join(sessions, '%2F%E4%B8%8D%E5%AD%98%E5%9C%A8%2F' + encodeURIComponent('示例 项目') + '%2Fx.y-z')]);
  assert.deepEqual(await grokSessionDirs("/a/b(1)!"), [join(sessions, '%2Fa%2Fb(1)!'), join(sessions, '%2Fa%2Fb%281%29%21')]);
  const real = join(c.temp, 'real'), link = join(c.temp, 'link');
  await mkdir(real); await symlink(real, link);
  const dirs = await grokSessionDirs(link);
  assert.ok(dirs.includes(join(sessions, encodeURIComponent(link))) && dirs.includes(join(sessions, encodeURIComponent(await (await import('node:fs/promises')).realpath(real)))));
});

test('可写路径必须是规范绝对路径、不含通配符；会话文件夹名不会比本副本更宽', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home;
  for (const bad of ['', '.', '..', 'relative/wt', '/', '/a/../b', '/a/b/', '/a/*/b', '/a/b?', '/a/[b]']) await assert.rejects(grokSessionDirs(bad), /规范的绝对路径/, JSON.stringify(bad));
  // 带 * 的写法（encodeURIComponent 不转义 *）会被 srt 当通配符，只留严格转义的那一种；此时副本路径本身也不许带 *。
  const p = { denyReadExtra: [] } as unknown as Project;
  await assert.rejects(sandbox({ ...job('grok'), worktree: '/test/repo/wt*' }, p), /规范的绝对路径/);
  await assert.rejects(sandbox({ ...job('cursor-sonnet'), worktree: '/test/repo/wt*' }, p), /规范的绝对路径/);
  await assert.rejects(sandbox(job('cursor-sonnet'), p, '/state/*'), /规范的绝对路径/);
  for (const dir of await grokSessionDirs("/a/b(1)!'~")) assert.equal(dir.slice(0, dir.lastIndexOf('/')), join(homedir(), '.grok/sessions'));
});
test('派 Grok 活前在隔离外刷新登录：排队、带 5 小时阈值、失败就不派', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home;
  const calls: any[] = [];
  const ok = async (file: string, args: string[], cwd: string, timeout: number, _: unknown, env?: NodeJS.ProcessEnv) => { calls.push({ file, args, timeout, env }); return { exit: 0, output: '账号信息', timedOut: false }; };
  await refreshGrokLogin(ok as any);
  assert.equal(calls[0].file, 'grok'); assert.deepEqual(calls[0].args, ['models']);
  assert.equal(calls[0].env.GROK_AUTH_EARLY_INVALIDATION_SECS, '18000'); assert.equal(calls[0].env.GROK_CLAUDE_HOOKS_ENABLED, 'false');
  for (const r of [{ exit: 1, output: '', timedOut: false }, { exit: null, output: '', timedOut: true }, { exit: null, output: '', timedOut: false, error: 'ENOENT' }, { exit: null, output: '', timedOut: false, signal: 'SIGKILL' }]) {
    await assert.rejects(refreshGrokLogin((async () => r) as any), (e: Error) => /刷新 Grok 登录没成功/.test(e.message) && !e.message.includes('账号信息'));
  }
  // 两个派活同时刷新时排队，不会重叠。
  let running = 0, most = 0;
  const slow = async () => { running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 30)); running--; return { exit: 0, output: '', timedOut: false }; };
  await Promise.all([refreshGrokLogin(slow as any), refreshGrokLogin(slow as any)]);
  assert.equal(most, 1);
  // 排队要等得起一次完整的刷新（刷新最多 30 秒，锁至少要等这么久）：前一个跑 12 秒，后一个也不能因等锁失败。
  let clock = 0, started!: () => void, release!: () => void;
  const holding = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  const realNow = Date.now; Date.now = () => realNow() + clock; t.after(() => { Date.now = realNow; });
  const first = refreshGrokLogin((async () => { started(); await gate; return { exit: 0, output: '', timedOut: false }; }) as any);
  await holding;
  const second = refreshGrokLogin(ok as any);
  await new Promise(r => setTimeout(r, 100)); clock += 12_000; await new Promise(r => setTimeout(r, 150));
  release();
  await Promise.all([first, second]);
});
test('设置里额外禁读的家目录位置，三家隔离都加上；写错了就拒绝，不会悄悄少一层保护', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home;
  const p = { denyReadExtra: [] } as unknown as Project;
  await mkdir(c.home, { recursive: true });
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ denyReadHome: ['.my-secrets', 'vault/keys'] }));
  const home = { denyReadExtra: [], denyReadHome: await extraDenyRead() };
  assert.deepEqual(home.denyReadHome, ['.my-secrets', 'vault/keys']);
  for (const who of ['grok', 'cursor-sonnet'] as Who[]) {
    const deny = (await sandbox(job(who), home)).filesystem.denyRead;
    assert.ok(deny.includes(join(homedir(), '.my-secrets')) && deny.includes(join(homedir(), 'vault/keys')), who);
  }
  process.env.XAGENTS_CODEX = '/test/codex';
  const codex = await command(job('codex'), '题目', home);
  assert.ok(codex.args.some(a => a.includes(`${JSON.stringify(join(homedir(), '.my-secrets'))}="deny"`)));
  for (const bad of [['../escape'], ['/abs'], ['~/.x'], ['.'], [''], 'x', [1], ['a\nb']]) {
    await writeFile(join(c.home, 'config.json'), JSON.stringify({ denyReadHome: bad }));
    await assert.rejects(extraDenyRead(), /denyReadHome|路径必须/, JSON.stringify(bad));
  }
});
test('Cursor 状态目录够短：长任务号也不会让 cursor-agent 退到公用的 /tmp/.cursor；登记处路径太长就拒绝派活', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home;
  const { cursorState, checkCursorState, CURSOR_DATA_LIMIT } = await import('../src/core/sandbox.ts');
  const long = { id: '0930-1131-cursor-grok-cursor-worker-probe-with-a-really-long-title-for-testing' };
  const dir = cursorStateDir(long);
  assert.ok(!dir.includes(long.id), '状态目录不能带完整任务号');
  assert.notEqual(dir, cursorStateDir({ id: long.id + 'x' }));
  // 真实家目录下的登记处也要够短（cursor-agent 的阈值是 84 个字符）。
  process.env.XAGENTS_HOME = join(homedir(), '.xagents');
  assert.ok(cursorState(cursorStateDir(long)).data.length <= CURSOR_DATA_LIMIT);
  process.env.XAGENTS_HOME = '/' + 'x'.repeat(80);
  assert.throws(() => checkCursorState(cursorStateDir(long)), /路径太长/);
  process.env.XAGENTS_HOME = c.home;
});

test('DeepSeek 登录和派活前的登录检查：钥匙只经标准输入给 Codex，用单独的 Codex 文件夹，不带别家的钥匙变量', async t => {
  const c = await context(t, false);
  const oldHome = process.env.XAGENTS_HOME, oldCodex = process.env.XAGENTS_CODEX, oldKeys = KEY_VARS.map(k => process.env[k]);
  // 替身 Codex：记下参数、标准输入、Codex 文件夹和继承到的钥匙变量；login status 时按“已登录”回答。
  const fake = join(c.temp, 'fake-codex.mjs'), log = join(c.temp, 'fake-codex.jsonl');
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let input = ''; if (process.argv.includes('--with-api-key')) for await (const chunk of process.stdin) input += chunk;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input, home: process.env.CODEX_HOME, keys: ${JSON.stringify(KEY_VARS)}.filter(k => k in process.env) }) + '\\n');
if (process.argv.includes('status')) console.log('Logged in using an API key - sk-***test');
`, { mode: 0o755 });
  process.env.XAGENTS_HOME = c.home; process.env.XAGENTS_CODEX = fake;
  for (const k of KEY_VARS) process.env[k] = 'inherited-' + k;
  t.after(() => {
    if (oldHome === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = oldHome;
    if (oldCodex === undefined) delete process.env.XAGENTS_CODEX; else process.env.XAGENTS_CODEX = oldCodex;
    KEY_VARS.forEach((k, i) => { if (oldKeys[i] === undefined) delete process.env[k]; else process.env[k] = oldKeys[i]; });
  });
  await assert.rejects(loginDeepseek('not-a-key'), /应以 sk- 开头/);
  await loginDeepseek('  sk-test1234567890  ');
  await checkDeepseekLogin();
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 3); // 登录、登录后查一次、派活前查一次
  assert.deepEqual(calls[0].args.slice(0, 2), ['login', '--with-api-key']); assert.equal(calls[0].input, 'sk-test1234567890\n');
  for (const call of calls) {
    assert.equal(call.home, join(c.home, 'deepseek')); assert.deepEqual(call.keys, []);
    assert.ok(call.args.includes('forced_login_method="api"') && call.args.includes('cli_auth_credentials_store="file"'));
    assert.ok(!call.args.some((a: string) => a.includes('sk-test')));
  }
  assert.deepEqual(calls[1].args.slice(0, 2), ['login', 'status']);
});

test('Cursor 的登录：在隔离外从钥匙串取，取不到、快过期都报错让主人登录；不是 JWT 的令牌照用', async () => {
  const token = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
  const now = Date.UTC(2026, 9, 2);
  const calls: string[][] = [];
  const run = (exit: number, output: string) => (async (file: string, args: string[]) => { calls.push([file, ...args]); return { exit, output, timedOut: false }; }) as any;
  const good = token(now / 1000 + 30 * 86400);
  assert.equal(await cursorToken(run(0, good + '\n'), now), good);
  assert.deepEqual(calls[0], ['/usr/bin/security', 'find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w']);
  assert.equal(await cursorToken(run(0, 'plain-api-token'), now), 'plain-api-token');
  await assert.rejects(cursorToken(run(44, ''), now), /没在钥匙串里找到 Cursor 的登录[\s\S]*cursor-agent login/);
  // 超时、退出码不对：说读没成功、请重试，不冒充“没登录”。
  await assert.rejects(cursorToken((async () => ({ exit: null, output: '', timedOut: true })) as any, now), /读 Cursor 的登录没成功（超时）/);
  await assert.rejects(cursorToken(run(51, ''), now), /读 Cursor 的登录没成功（退出码 51）/);
  await assert.rejects(cursorToken(run(0, 'security: 出错了 有空格'), now), /格式不对/);
  // 正好剩 2 小时照派，少 1 秒就不派。
  assert.ok(await cursorToken(run(0, token(now / 1000 + 7200)), now));
  await assert.rejects(cursorToken(run(0, token(now / 1000 + 7199)), now), /剩不到 2 小时[\s\S]*cursor-agent login/);
  await assert.rejects(checkCursorLogin(run(44, '')), /这件没有派出：没在钥匙串里找到/);
});
