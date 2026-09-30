import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { probeSource, expectedProbes, globalTargets } from '../src/core/selfcheck.ts';
import type { Isolation, Probe, TempPaths } from '../src/core/selfcheck.ts';

// 公用临时位置（假路径）；任务专用临时目录是 /fake/job/tmp。
const temp: TempPaths = { 'tmp-lead': '/fake/tmp/claude-501', 'tmp-shared': '/fake/tmp', 'tmp-srt': '/fake/tmp/claude', 'tmp-user': '/fake/folders/T', 'tmp-cache': '/fake/folders/C', 'npm-logs': '/fake/home/.npm/_logs' };

// 执行最终生成的探针，只注入内存里的文件与网络替身，绝不打开真实敏感文件或端口。
async function runProbe(mode: Isolation, options: { linkable?: boolean; proxy?: string; status?: number; socksAuth?: number; socksMethod?: number; npmrc?: string; direct?: string; noListener?: boolean; closed?: boolean; writable?: string[]; missing?: string[]; noDelete?: boolean; tmpdir?: string; temp?: Partial<TempPaths> } = {}) {
  const opened: string[] = [], closed: string[] = [], requests: any[] = [], packets: Buffer[] = [], written: string[] = [], removed: string[] = [], made: string[] = [], flags: unknown[] = [];
  // writable：隔离意外放行的位置（相对假家目录，或绝对路径）；missing：还不存在的位置。
  const under = (list: string[] | undefined, path: string) => (list ?? []).some(w => { const base = w.startsWith('/') ? w : `/fake/home/${w}`; return path === base || path.startsWith(`${base}/`); });
  const open = (path: string) => under(options.writable, path);
  const absent = (path: string) => under(options.missing, path);
  let output = '';
  const denied = (code = 'EPERM') => Object.assign(new Error(), { code });
  const directError = options.direct ?? 'EPERM';
  function socket() {
    const s = new EventEmitter() as any;
    s.setTimeout = () => s; s.destroy = () => {};
    return s;
  }
  const net = { connect: ({ host }: { host: string }) => {
    const s = socket();
    if (host !== 'proxy.invalid') { queueMicrotask(() => directError === 'allowed' ? s.emit('connect') : s.emit('error', denied(directError))); return s; }
    let step = 0;
    const reply = (data: number[]) => queueMicrotask(() => { for (const byte of data) s.emit('data', Buffer.from([byte])); });
    s.write = (data: Buffer) => {
      packets.push(data);
      if (step++ === 0) {
        if (options.closed) { queueMicrotask(() => s.emit('end')); return; }
        reply([5, options.socksMethod ?? data[2]]);
      } else if (data[0] === 1) reply([1, options.socksAuth ?? 0]);
      else reply([5, options.status ?? 2, 0, 1, 0, 0, 0, 0, 0, 0]);
    };
    queueMicrotask(() => s.emit('connect'));
    return s;
  } };
  const http = { request: (request: any) => {
    requests.push(request);
    const req = new EventEmitter() as any;
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => { req.emit('connect', { statusCode: options.status ?? 403 }, socket()); req.emit('close'); });
    return req;
  } };
  const https = { get: () => {
    const req = new EventEmitter() as any; req.destroy = () => {};
    queueMicrotask(() => { req.emit('error', denied(directError)); req.emit('close'); });
    return req;
  } };
  const source = probeSource(mode, '/fake/worktree', '/fake/outside', options.noListener ? null : 1234, 'RESULT:', 'TOKEN', { ...temp, ...options.temp }, '/fake/job/tmp', '/fake/outside-file').replace(/^import .*;\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const handle = (path: string) => ({ close: async () => { closed.push(path); }, stat: async () => ({ ino: 42 }) });
  const unlink = async (path: string) => { if (options.noDelete) throw denied(); removed.push(path); };
  const linked: string[][] = [];
  await new AsyncFunction('writeFile', 'rm', 'readdir', 'open', 'mkdir', 'rmdir', 'stat', 'link', 'constants', 'homedir', 'join', 'net', 'https', 'http', 'process', 'console', source)(
    async (path: string) => { if (!path.startsWith('/fake/worktree/') && !path.startsWith('/fake/job/tmp/')) throw denied(); written.push(path); },
    unlink, async (path: string) => { opened.push(path); throw denied(); },
    async (path: string, flag?: string | number) => {
      opened.push(path); flags.push([path, flag]);
      if (path.endsWith('/.npmrc') && options.npmrc === 'allowed') return handle(path);
      if (flag === 'wx' && absent(path.slice(0, path.lastIndexOf('/')))) throw denied('ENOENT');
      if (flag !== 'wx' && flag !== 'r' && absent(path)) throw denied('ENOENT');
      if (open(path)) { if (flag === 'wx') written.push(path); return handle(path); }
      throw denied(path.endsWith('/.npmrc') ? options.npmrc : undefined);
    },
    async (path: string) => { if (!open(path)) throw denied(); made.push(path); },
    unlink, async () => ({ ino: 7 }),
    async (from: string, to: string) => { if (!options.linkable) throw denied(); linked.push([from, to]); },
    { O_WRONLY: 1 },
    () => '/fake/home', join, net, https, http,
    { env: { TMPDIR: options.tmpdir ?? '/fake/job/tmp/', ...(options.proxy ? { HTTPS_PROXY: options.proxy, HTTP_PROXY: options.proxy } : {}) } },
    { log: (line: string) => { output = line; } },
  );
  const probes = JSON.parse(output.slice('RESULT:'.length)) as Probe[];
  assert.deepEqual(probes.map(p => p.name).sort(), expectedProbes(mode).sort());
  assert.ok(!output.includes('secret-password'));
  return { probes, opened, closed, requests, packets, written, removed, made, flags, linked };
}

for (const mode of ['codex', 'grok', 'cursor'] as Isolation[]) test(`${mode} 最终探针测 SSH、npmrc 和规定的登录文件，文件缺失算拿不准`, async () => {
  const { probes, opened } = await runProbe(mode, { npmrc: 'ENOENT' });
  assert.ok(opened.includes('/fake/home/.npmrc')); assert.ok(opened.includes('/fake/home/.ssh'));
  for (const name of expectedProbes(mode).filter(n => n.startsWith('login-'))) {
    const path = { 'login-codex': '.codex/auth.json', 'login-grok': '.grok/auth.json', 'login-cursor': '.cursor/cli-config.json' }[name];
    assert.ok(opened.includes(`/fake/home/${path}`));
    assert.equal(probes.find(p => p.name === name)!.outcome, 'denied');
  }
  assert.equal(probes.find(p => p.name === 'npmrc')!.outcome, 'unknown');
  const allowed = await runProbe(mode, { npmrc: 'allowed', noListener: true });
  assert.equal(allowed.probes.find(p => p.name === 'npmrc')!.outcome, 'allowed');
  assert.deepEqual(allowed.closed, ['/fake/home/.npmrc']);
  assert.equal(allowed.probes.find(p => p.name === 'listener')!.outcome, 'unknown');
});

for (const mode of ['grok', 'cursor'] as Isolation[]) test(`${mode} HTTP 代理发送 URL 解码后的 Basic 认证，403 挡住，407 拿不准，200 可通`, async () => {
  for (const [status, outcome] of [[403, 'denied'], [407, 'unknown'], [200, 'allowed']] as const) {
    const { requests, probes } = await runProbe(mode, { proxy: 'http://%E7%94%A8%E6%88%B7%20name:secret-password%40%3A@proxy.invalid:8080', status });
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.method, 'CONNECT'); assert.equal(request.hostname, 'proxy.invalid');
      assert.equal(request.headers['Proxy-Authorization'], 'Basic ' + Buffer.from('用户 name:secret-password@:').toString('base64'));
    }
    assert.deepEqual(requests.map(r => r.path), ['127.0.0.1:9222', '127.0.0.1:1234', '1.1.1.1:443']);
    for (const name of ['chrome', 'listener', 'internet']) assert.equal(probes.find(p => p.name === name)!.outcome, outcome);
  }
});

test('HTTP 无凭据不加认证；直连可通或拿不准时不能用代理 403 冒充隔离通过', async () => {
  const anonymous = await runProbe('grok', { proxy: 'http://proxy.invalid:8080' });
  assert.deepEqual(anonymous.requests[0].headers, {});
  for (const [direct, outcome] of [['allowed', 'allowed'], ['ECONNREFUSED', 'unknown']]) {
    const r = await runProbe('grok', { proxy: 'http://u:p@proxy.invalid', direct });
    assert.equal(r.probes.find(p => p.name === 'chrome')!.outcome, outcome);
  }
});

for (const scheme of ['socks5', 'socks5h']) test(`${scheme} 用户名密码握手、分片回复与目标请求；明确拒绝才算挡住`, async () => {
  for (const [status, outcome] of [[2, 'denied'], [0, 'allowed'], [5, 'unknown']] as const) {
    const { packets, probes } = await runProbe('cursor', { proxy: `${scheme}://user%20name:secret-password%40@proxy.invalid:1080`, status });
    assert.equal(packets.length, 9);
    for (let i = 0; i < packets.length; i += 3) {
      assert.deepEqual([...packets[i]], [5, 1, 2]);
      assert.deepEqual(packets[i + 1], Buffer.concat([Buffer.from([1, 9]), Buffer.from('user name'), Buffer.from([16]), Buffer.from('secret-password@')]));
      assert.deepEqual([...packets[i + 2].subarray(0, 4)], [5, 1, 0, 3]);
      const target = packets[i + 2];
      assert.equal(target.subarray(5, 5 + target[4]).toString(), i === 6 ? '1.1.1.1' : '127.0.0.1');
      assert.equal(target.readUInt16BE(target.length - 2), [9222, 1234, 443][i / 3]);
    }
    for (const name of ['chrome', 'listener', 'internet']) assert.equal(probes.find(p => p.name === name)!.outcome, outcome);
  }
});

test('SOCKS5 认证失败、方法不匹配、连接关闭都拿不准，不发送目标请求', async () => {
  for (const options of [{ socksAuth: 1 }, { socksMethod: 255 }, { socksMethod: 0 }, { closed: true }]) {
    const { packets, probes } = await runProbe('grok', { proxy: 'socks5://u:secret-password@proxy.invalid', ...options });
    assert.ok(packets.every(p => p[0] === 1 || p.equals(Buffer.from([5, 1, 2]))));
    for (const name of ['chrome', 'listener', 'internet']) assert.equal(probes.find(p => p.name === name)!.outcome, 'unknown');
  }
  const anonymous = await runProbe('grok', { proxy: 'socks5://proxy.invalid' });
  assert.deepEqual([...anonymous.packets[0]], [5, 1, 0]);
  assert.equal(anonymous.packets.length, 6);
  const invalid = await runProbe('grok', { proxy: `socks5://u:${'x'.repeat(256)}@proxy.invalid` });
  assert.equal(invalid.packets.length, 0);
  assert.equal(invalid.probes.find(p => p.name === 'internet')!.outcome, 'unknown');
});

for (const mode of ['codex', 'grok', 'cursor'] as Isolation[]) test(`${mode} 全局配置探针：挡住算通过；意外能写就报出来并马上删掉，已有文件不改内容`, async () => {
  const blocked = await runProbe(mode);
  for (const t of globalTargets) assert.equal(blocked.probes.find(p => p.name === t.name)!.outcome, 'denied', t.name);
  assert.deepEqual(blocked.written, ['/fake/worktree/write-probe', '/fake/job/tmp/write-probe']);
  const leaky = await runProbe(mode, { writable: ['.cursor', '.grok/skills'], missing: ['.cursor/hooks.json', '.cursor/rules'] });
  const outcome = (name: string) => leaky.probes.find(p => p.name === name)!.outcome;
  for (const name of ['cursor-hooks', 'cursor-rules', 'cursor-skills', 'cursor-config', 'grok-skills']) assert.equal(outcome(name), 'allowed', name);
  for (const name of ['grok-agents', 'grok-hooks', 'claude-config', 'agents-skills']) assert.equal(outcome(name), 'denied', name);
  // 不存在的钩子文件按真实路径建出再删；不存在的目录建出再删；已有目录里只建随机名文件；已有文件只以读写方式打开。
  assert.ok(leaky.written.includes('/fake/home/.cursor/hooks.json') && leaky.removed.includes('/fake/home/.cursor/hooks.json'));
  assert.ok(leaky.made.includes('/fake/home/.cursor/rules') && leaky.removed.includes('/fake/home/.cursor/rules'));
  assert.ok(leaky.written.includes('/fake/home/.grok/skills/TOKEN') && leaky.removed.includes('/fake/home/.grok/skills/TOKEN'));
  assert.ok(!leaky.written.includes('/fake/home/.cursor/cli-config.json'));
  // 已有文件用只写方式打开（不截断、不新建），不用读写方式：读被禁时不能冒充写被挡。
  assert.deepEqual(leaky.flags.filter(([path, flag]: any) => path === '/fake/home/.cursor/cli-config.json' && flag !== 'r'), [['/fake/home/.cursor/cli-config.json', 1]]);
  assert.ok(!leaky.flags.some(([, flag]: any) => flag === 'r+'));
  // 建出来的东西连同文件编号报给外面。
  assert.deepEqual(leaky.probes.find(p => p.name === 'cursor-hooks')!.created, [{ path: '/fake/home/.cursor/hooks.json', dir: false, ino: 42 }]);
  assert.deepEqual(leaky.probes.find(p => p.name === 'cursor-rules')!.created, [{ path: '/fake/home/.cursor/rules', dir: true, ino: 7 }]);
  // 写成了但删不掉：仍然是放行，原因里写明清理失败。
  const stuck = await runProbe(mode, { writable: ['.cursor', '.grok/skills'], missing: ['.cursor/hooks.json', '.cursor/rules'], noDelete: true });
  for (const name of ['cursor-hooks', 'cursor-rules', 'grok-skills']) {
    const p = stuck.probes.find(p => p.name === name)!;
    assert.equal(p.outcome, 'allowed', name); assert.match(p.reason, /清理失败：EPERM/);
  }
});

for (const mode of ['codex', 'grok', 'cursor'] as Isolation[]) test(`${mode} 临时目录探针：TMPDIR 必须指向任务的 tmp 且可写，公用临时位置都要挡住`, async () => {
  const blocked = await runProbe(mode);
  assert.equal(blocked.probes.find(p => p.name === 'tmpdir')!.outcome, 'allowed');
  for (const name of Object.keys(temp)) assert.equal(blocked.probes.find(p => p.name === name)!.outcome, 'denied', name);
  // 在已有目录里只建随机名文件，写成了就算放行并马上删掉。
  const leaky = await runProbe(mode, { writable: ['/fake/tmp'] });
  for (const name of ['tmp-lead', 'tmp-shared', 'tmp-srt']) assert.equal(leaky.probes.find(p => p.name === name)!.outcome, 'allowed', name);
  assert.equal(leaky.probes.find(p => p.name === 'tmp-user')!.outcome, 'denied');
  assert.ok(leaky.written.includes('/fake/tmp/TOKEN') && leaky.removed.includes('/fake/tmp/TOKEN'));
  // 负责人会话的临时目录还不存在：按真实路径建，挡住才算通过。
  const missing = await runProbe(mode, { missing: ['/fake/tmp/claude-501'] });
  assert.equal(missing.probes.find(p => p.name === 'tmp-lead')!.outcome, 'denied');
  // TMPDIR 没指向任务的 tmp、查不到的位置，都算拿不准。
  const other = await runProbe(mode, { tmpdir: '/fake/tmp', temp: { 'tmp-user': null } });
  assert.equal(other.probes.find(p => p.name === 'tmpdir')!.outcome, 'unknown');
  assert.equal(other.probes.find(p => p.name === 'tmp-user')!.outcome, 'unknown');
});

test('硬链接探针：在任务 tmp 里给外面的文件建硬链接，挡住才算通过；建成了就算放行并删掉', async () => {
  const blocked = await runProbe('grok');
  assert.equal(blocked.probes.find(p => p.name === 'hardlink')!.outcome, 'denied');
  const leaky = await runProbe('codex', { linkable: true });
  assert.equal(leaky.probes.find(p => p.name === 'hardlink')!.outcome, 'allowed');
  assert.deepEqual(leaky.linked, [['/fake/outside-file', '/fake/job/tmp/TOKEN']]);
  assert.ok(leaky.removed.includes('/fake/job/tmp/TOKEN'));
});
test('公用临时目录里探针建出的固定名目录不删，只报出来；随机名文件照删', async () => {
  const r = await runProbe('cursor', { writable: ['/fake/tmp'], missing: ['/fake/tmp/claude-501'] });
  const lead = r.probes.find(p => p.name === 'tmp-lead')!;
  assert.equal(lead.outcome, 'allowed'); assert.match(lead.reason, /建出的公用目录没有删/);
  assert.ok(r.made.includes('/fake/tmp/claude-501') && !r.removed.includes('/fake/tmp/claude-501'));
  assert.ok(r.removed.includes('/fake/tmp/TOKEN'));
});
