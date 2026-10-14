import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { verifyFeed, verifyLegacyFeed } from '../app/main/update-feed.ts';
import { context, exec, root } from './helpers.ts';

test('发布 CLI：生成权限 600 的密钥、不覆盖，签好的多平台清单能被应用接受、改单字节拒绝', async t => {
  const c = await context(t, false), privateFile = join(c.temp, 'private.pem'), publicFile = join(c.temp, 'public.txt');
  const generate = () => exec(process.execPath, ['scripts/release/generate-update-key.mjs', privateFile, publicFile], root);
  const first = await generate(); assert.equal(first.code, 0, first.stderr);
  if (process.platform !== 'win32') assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
  const raw = (await readFile(publicFile, 'utf8')).trim(); assert.equal(Buffer.from(raw, 'base64').length, 32);
  const key = createPrivateKey(await readFile(privateFile)); assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.ok(verify(null, Buffer.from('test'), createPublicKey(key), sign(null, Buffer.from('test'), key)));
  const before = await readFile(privateFile); assert.equal((await generate()).code, 1); assert.deepEqual(await readFile(privateFile), before);
  const arm = join(c.temp, '中文 arm.zip'), intel = join(c.temp, 'intel.zip'), notes = join(c.temp, 'notes.txt'), output = join(c.temp, 'latest-v2.json'), legacyOut = join(c.temp, 'latest.json');
  await writeFile(arm, 'fake arm'); await writeFile(intel, 'fake intel'); await writeFile(notes, '发布说明\n另一行');
  const args = ['scripts/release/make-update.mjs', '--version', '0.2.0', '--minimum-version', '0.1.0', '--package', `darwin-arm64=${arm}`, '--package', `darwin-x64=${intel}`, '--notes', notes, '--base-url', 'https://updates.example.invalid/releases/0.2.0', '--base-url', 'https://cdn.example.invalid/v0.2.0/', '--private-key', privateFile, '--out', output, '--legacy-base-url', 'https://legacy.example.invalid/v0.2.0/', '--legacy-out', legacyOut];
  const made = await exec(process.execPath, args, root); assert.equal(made.code, 0, made.stderr);
  const serialized = await readFile(output), feed = verifyFeed(serialized, raw);
  assert.equal(feed.version, '0.2.0'); assert.equal(feed.packages['darwin-arm64'].size, 8);
  assert.deepEqual(feed.packages['darwin-arm64'].urls, ['https://updates.example.invalid/releases/0.2.0/%E4%B8%AD%E6%96%87%20arm.zip', 'https://cdn.example.invalid/v0.2.0/%E4%B8%AD%E6%96%87%20arm.zip']);
  const legacy = verifyLegacyFeed(await readFile(legacyOut), raw);
  assert.deepEqual(legacy, { ...feed, packages: Object.fromEntries(Object.entries(feed.packages).map(([platform, { urls, ...info }]) => [platform, { ...info, url: urls[1].replace('cdn.example', 'legacy.example') }])) });
  assert.equal(Object.keys(feed.packages).length, 2);
  assert.equal((await exec(process.execPath, args, root)).code, 1); assert.deepEqual(await readFile(output), serialized);
  const tampered = JSON.parse(serialized.toString()); tampered.body = tampered.body.replace('0.2.0', '0.2.1');
  assert.throws(() => verifyFeed(JSON.stringify(tampered), raw), /签名不对/);
});
test('发布 CLI 拒绝坏参数、覆盖公钥时清理自己新建的私钥', async t => {
  const c = await context(t, false), priv = join(c.temp, 'priv'), pub = join(c.temp, 'pub'); await writeFile(pub, '已有公钥');
  assert.equal((await exec(process.execPath, ['scripts/release/generate-update-key.mjs', priv, pub], root)).code, 1);
  await assert.rejects(stat(priv)); assert.equal(await readFile(pub, 'utf8'), '已有公钥');
  for (const args of [[], ['--unknown', 'value'], ['--version', '0.2.0', '--version', '0.3.0'], ['--package', 'broken']]) {
    const result = await exec(process.execPath, ['scripts/release/make-update.mjs', ...args], root); assert.equal(result.code, 1); assert.match(result.stderr, /参数|格式/);
  }
});
test('传到共用下载桶：对不上清单不传，已有的不覆盖，传完从公网取回核对', async t => {
  const { generateUpdateKey } = await import('../scripts/release/generate-update-key.mjs');
  const { makeUpdate } = await import('../scripts/release/make-update.mjs');
  const { publishStore, parseArguments, storeKey } = await import('../scripts/release/publish-store.mjs');
  const c = await context(t, false), priv = join(c.temp, 'priv.pem'), pub = join(c.temp, 'pub.txt');
  const zip = join(c.temp, 'captain-agents_0.3.0_macos-arm64.zip'), other = join(c.temp, 'other.zip'), notes = join(c.temp, 'notes.txt'), manifest = join(c.temp, 'latest.json');
  await generateUpdateKey(priv, pub); await writeFile(zip, 'real package'); await writeFile(other, 'another one'); await writeFile(notes, '说明');
  await makeUpdate({ version: '0.3.0', minimumVersion: '0.2.0', packages: [{ platform: 'darwin-arm64', file: zip }], notes, baseUrls: ['https://heihuzi-prod-tokyo-downloads.oss-ap-northeast-1.aliyuncs.com/captain-agents/stable/0.3.0/', 'https://updates.example.invalid/v0.3.0/'], privateKey: priv, out: manifest });
  const publicKey = (await readFile(pub, 'utf8')).trim(), key = 'captain-agents/stable/0.3.0/captain-agents_0.3.0_macos-arm64.zip';
  assert.equal(storeKey('0.3.0', 'darwin-arm64'), key); assert.equal(storeKey('0.3.0', 'win32-x64', 'beta'), 'captain-agents/beta/0.3.0/captain-agents_0.3.0_windows-x64.zip');
  assert.throws(() => storeKey('0.3.0', 'solaris-x64'), /平台/); assert.throws(() => storeKey('0.3.0', 'darwin-arm64', 'nightly'), /通道/);
  const sizeAndHash = async (file: string) => { const data = await readFile(file); return { size: data.length, sha256: createHash('sha256').update(data).digest('hex') }; };
  const store = new Map<string, string>(), uploads: string[] = [];
  const deps = {
    remote: async (url: string) => store.has(url) ? sizeAndHash(store.get(url)!) : null,
    upload: async (file: string, to: string) => { uploads.push(to); store.set(`https://heihuzi-prod-tokyo-downloads.oss-ap-northeast-1.aliyuncs.com/${to}`, file); },
  };
  const options = (file: string, extra = {}) => ({ manifest, publicKey, packages: [{ platform: 'darwin-arm64', file }], ...extra });
  await assert.rejects(publishStore(options(other), deps), /对不上，没有上传/);
  await assert.rejects(publishStore({ ...options(zip), packages: [] }, deps), /一一对应/);
  const dry = await publishStore(options(zip, { dryRun: true }), deps);
  assert.equal(dry.items[0].state, '还没上传'); assert.deepEqual(uploads, []);
  const first = await publishStore(options(zip), deps);
  assert.deepEqual(uploads, [key]); assert.match(first.items[0].state, /已上传/); assert.ok(first.items[0].url.endsWith(key));
  const again = await publishStore(options(zip), deps);
  assert.deepEqual(uploads, [key]); assert.match(again.items[0].state, /已在桶里/);
  store.set(first.items[0].url, other);
  await assert.rejects(publishStore(options(zip), deps), /不改不删/); assert.deepEqual(uploads, [key]);
  store.clear();
  await assert.rejects(publishStore(options(zip), { ...deps, upload: async (_file: string, to: string) => { store.set(`https://heihuzi-prod-tokyo-downloads.oss-ap-northeast-1.aliyuncs.com/${to}`, other); } }), /不要给用户/);
  for (const args of [[], ['--manifest', 'a'], ['--manifest', 'a', '--public-key', 'b'], ['--manifest', 'a', '--public-key', 'b', '--package', 'broken'], ['--what', 'x']]) assert.throws(() => parseArguments(args), /参数|格式/);
  assert.equal(parseArguments(['--dry-run', '--manifest', 'a', '--public-key', 'b', '--package', 'darwin-arm64=/x.zip', '--profile', 'p']).dryRun, true);
});

test('双清单失败回收：任一目标已存在、缺父目录、重复目标都不留下另一份', async t => {
  const { generateUpdateKey } = await import('../scripts/release/generate-update-key.mjs');
  const { makeUpdate, parseArguments } = await import('../scripts/release/make-update.mjs');
  const c = await context(t, false), privateKey = join(c.temp, 'private.pem'), pub = join(c.temp, 'public.txt');
  await generateUpdateKey(privateKey, pub);
  const file = join(c.temp, 'app.zip'), notes = join(c.temp, 'notes'); await writeFile(file, 'zip'); await writeFile(notes, '说明');
  const options = { version: '0.3.0', minimumVersion: '0.2.0', packages: [{ platform: 'darwin-arm64', file }], notes, privateKey,
    baseUrls: ['https://bucket.invalid/v/'], legacyBaseUrl: 'https://releases.invalid/v/', out: join(c.temp, 'new.json'), legacyOut: join(c.temp, 'old.json') };
  for (const missing of ['legacyBaseUrl', 'legacyOut']) {
    const partial = { ...options, [missing]: undefined };
    await assert.rejects(makeUpdate(partial), /必须同时提供/);
  }
  const args = ['--version', '0.3.0', '--minimum-version', '0.2.0', '--notes', notes, '--private-key', privateKey, '--out', options.out, '--base-url', options.baseUrls[0]];
  for (const flag of ['--legacy-base-url', '--legacy-out']) assert.throws(() => parseArguments([...args, flag, 'value']), /必须同时提供/);
  for (const count of [0, 5]) await assert.rejects(makeUpdate({ ...options, baseUrls: Array(count).fill(options.baseUrls[0]) }), /1–4/);
  await assert.rejects(makeUpdate({ ...options, baseUrls: [options.baseUrls[0], options.baseUrls[0]] }), /重复/);
  await assert.rejects(makeUpdate({ ...options, legacyOut: options.out }), /同一个文件/);
  await assert.rejects(makeUpdate({ ...options, legacyOut: join(c.temp, 'missing/old.json') }));
  await assert.rejects(stat(options.out));
  for (const existing of ['out', 'legacyOut'] as const) {
    await writeFile(options[existing], '已有内容');
    await assert.rejects(makeUpdate(options));
    assert.equal(await readFile(options[existing], 'utf8'), '已有内容');
    await assert.rejects(stat(options[existing === 'out' ? 'legacyOut' : 'out']));
    const { rm } = await import('node:fs/promises'); await rm(options[existing]);
  }
  assert.equal((await readdir(c.temp)).some(name => name.startsWith('.update-feed-')), false);
});
test('桶地址不在新清单 urls 中时拒绝，连远端查询都不执行', async t => {
  const { makeUpdate } = await import('../scripts/release/make-update.mjs');
  const { generateUpdateKey } = await import('../scripts/release/generate-update-key.mjs');
  const { publishStore } = await import('../scripts/release/publish-store.mjs');
  const c = await context(t, false), privateKey = join(c.temp, 'priv'), pub = join(c.temp, 'pub'), manifest = join(c.temp, 'latest-v2.json');
  await generateUpdateKey(privateKey, pub);
  const file = join(c.temp, 'wrong-name.zip'), notes = join(c.temp, 'notes'); await writeFile(file, 'zip'); await writeFile(notes, '说明');
  const packages = [{ platform: 'darwin-arm64', file }];
  await makeUpdate({ version: '0.3.0', minimumVersion: '0.2.0', notes, privateKey, packages, baseUrls: ['https://heihuzi-prod-tokyo-downloads.oss-ap-northeast-1.aliyuncs.com/captain-agents/stable/0.3.0/'], out: manifest });
  let calls = 0;
  await assert.rejects(publishStore({ manifest, packages, publicKey: (await readFile(pub, 'utf8')).trim() }, { remote: async () => { calls++; return null; }, upload: async () => { calls++; } }), /桶地址.*没有上传/);
  assert.equal(calls, 0);
});

for (const existing of ['没有', '相同', '更高', '更低', '同版不同', '无效']) test(`发布清单：桶里${existing}；预演只报告，实际发布核对原始字节`, async t => {
  const { publishStore, publicUrl, storeKey, parseArguments } = await import('../scripts/release/publish-store.mjs');
  const { feed, signed, publicKey, data, pkg } = await import('./update-helpers.ts');
  const c = await context(t, false), manifest = join(c.temp, 'latest-v2.json'), file = join(c.temp, 'app.zip');
  const channel = existing === '更低' ? 'beta' : 'stable', key = storeKey('0.2.0', 'darwin-arm64', channel);
  const body = feed({ packages: { 'darwin-arm64': { ...pkg, urls: [publicUrl(key)] } } });
  // 尾部空白也必须原样保留，不能重新序列化清单。
  const bytes = Buffer.concat([signed(body), Buffer.from('\n  ')]);
  await writeFile(manifest, bytes); await writeFile(file, data);
  let remoteBytes: Buffer | null = existing === '没有' ? null : existing === '相同' ? bytes : existing === '无效' ? Buffer.from('{}')
    : signed({ ...body, version: existing === '更高' ? '0.10.0' : existing === '更低' ? '0.1.0' : '0.2.0', notes: '不同说明' });
  const feedKey = `captain-agents/${channel}/latest-v2.json`, feedUrl = publicUrl(feedKey);
  const events: string[] = [];
  const deps = {
    remote: async (url: string) => { assert.equal(url, publicUrl(key)); events.push('核对安装包'); return pkg; },
    remoteFeed: async (url: string) => { assert.equal(url, feedUrl); events.push('读取清单'); return remoteBytes; },
    upload: async (source: string, target: string, options: { overwrite: boolean }) => {
      assert.equal(source, manifest); assert.equal(target, feedKey); assert.equal(options.overwrite, true);
      events.push('上传清单'); remoteBytes = await readFile(source);
    },
  };
  const options = { manifest, publicKey, channel, packages: [{ platform: 'darwin-arm64', file }], publishFeed: true };
  const dry = await publishStore({ ...options, dryRun: true }, deps);
  assert.equal(dry.feed?.url, feedUrl);
  assert.equal(dry.feed?.state, existing === '没有' ? '没有' : existing === '相同' ? '相同' : existing === '更高' ? '会被拒绝' : '会覆盖');
  assert.deepEqual(events, ['核对安装包', '读取清单']); events.length = 0;
  if (existing === '更高') {
    await assert.rejects(publishStore(options, deps), /版本更高/);
    assert.deepEqual(events, ['核对安装包', '核对安装包', '读取清单']);
  } else {
    const result = await publishStore(options, deps);
    assert.equal(result.feed?.state, existing === '相同' ? '相同' : '已上传，公网取回核对一致');
    assert.deepEqual(remoteBytes, bytes);
    assert.deepEqual(events, ['核对安装包', '核对安装包', '读取清单', ...(existing === '相同' ? [] : ['上传清单', '读取清单'])]);
  }
  assert.equal(parseArguments(['--publish-feed', '--manifest', manifest, '--public-key', publicKey, '--package', `darwin-arm64=${file}`]).publishFeed, true);
});
test('发布清单必须等全部安装包公网核对通过；读回清单不一致报错；不开开关不碰清单', async t => {
  const { publishStore, publicUrl, storeKey } = await import('../scripts/release/publish-store.mjs');
  const { feed, signed, publicKey, data, pkg } = await import('./update-helpers.ts');
  const c = await context(t, false), manifest = join(c.temp, 'latest-v2.json'), file = join(c.temp, 'app.zip');
  const platforms = ['darwin-arm64', 'darwin-x64'];
  const bytes = signed(feed({ packages: Object.fromEntries(platforms.map(p => [p, { ...pkg, urls: [publicUrl(storeKey('0.2.0', p))] }])) }));
  await writeFile(manifest, bytes); await writeFile(file, data);
  const options = { manifest, publicKey, packages: platforms.map(platform => ({ platform, file })), publishFeed: true };
  for (const scenario of ['安装包失败', '清单不一致', '清单消失', '不开开关']) {
    const events: string[] = []; let packagesRead = 0, feedReads = 0;
    const deps = {
      remote: async () => { events.push('读取安装包'); return ++packagesRead <= 2 ? null : scenario === '安装包失败' && packagesRead === 4 ? { ...pkg, size: 1 } : pkg; },
      remoteFeed: async () => { events.push('读取清单'); return ++feedReads === 1 || scenario === '清单消失' ? null : Buffer.from('不同的清单'); },
      upload: async (_source: string, target: string, opt: { overwrite: boolean }) => {
        const isFeed = target.endsWith('latest-v2.json'); assert.equal(opt.overwrite, isFeed);
        if (isFeed) assert.equal(packagesRead, 4);
        events.push(isFeed ? '上传清单' : '上传安装包');
      },
    };
    const pending = publishStore({ ...options, publishFeed: scenario !== '不开开关' }, deps);
    if (scenario === '不开开关') { const result = await pending; assert.equal(result.feed, undefined); }
    else await assert.rejects(pending, scenario === '安装包失败' ? /签名清单对不上/ : /清单和本地文件不一致/);
    if (scenario === '安装包失败' || scenario === '不开开关') assert.equal(events.some(e => e.includes('清单')), false);
    else assert.deepEqual(events.slice(-3), ['读取清单', '上传清单', '读取清单']);
  }
});
test('发版流水线的输入：配置只读一处，门槛拦住错标签、缺说明和不成对的钥匙，签出的两份清单和包对得上', async t => {
  const { generateUpdateKey } = await import('../scripts/release/generate-update-key.mjs');
  const { readInputs, buildEnvironment, describeTarget, checkRelease, buildFeed, packageName } = await import('../scripts/release/release-inputs.mjs');
  const { verifyLegacyFeed } = await import('../app/main/update-feed.ts');
  // 仓库里真的那份配置读得出来，流水线和应用用的是同一套检查。
  const real = await readInputs();
  assert.deepEqual(Object.keys(buildEnvironment(real)), ['XA_UPDATE_FEED', 'XA_UPDATE_HOSTS', 'XA_UPDATE_PUBLIC_KEY']);
  assert.equal(buildEnvironment(real).XA_UPDATE_FEED.split(',').length, real.config.feeds.length);
  assert.deepEqual(describeTarget(real, 'mac-x64'), { APP_VERSION: real.version, PACKAGE_NAME: `captain-agents_${real.version}_macos-x64.zip`, EXPECTED_TARGET: 'darwin-x64' });
  assert.throws(() => describeTarget(real, 'solaris-x64'), /打包目标/);

  const c = await context(t, false), priv = join(c.temp, 'priv.pem'), pub = join(c.temp, 'pub.txt'), other = join(c.temp, 'other.pem');
  await generateUpdateKey(priv, pub); await generateUpdateKey(other, join(c.temp, 'other.txt'));
  const publicKey = (await readFile(pub, 'utf8')).trim(), env = { XA_UPDATE_PRIVATE_KEY: await readFile(priv, 'utf8') };
  const root = join(c.temp, 'repo'), packages = join(c.temp, 'packages'), out = join(c.temp, 'feeds');
  for (const dir of [join(root, 'release/notes'), packages, out]) await mkdir(dir, { recursive: true });
  const config = { feeds: ['https://store.example.invalid/latest-v2.json', 'https://pages.example.invalid/latest-v2.json'], hosts: ['files.example.invalid'], publicKey,
    minimumVersion: '0.2.0', targets: ['mac-arm64', 'mac-x64'], downloadBases: ['https://store.example.invalid/{version}/', 'https://pages.example.invalid/v{version}/'], legacyBase: 'https://pages.example.invalid/v{version}/' };
  await writeFile(join(root, 'release/config.json'), JSON.stringify(config)); await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  const inputs = await readInputs(root);
  await assert.rejects(checkRelease(inputs, 'v0.3.1', env), /对不上/);
  await assert.rejects(checkRelease(inputs, 'v0.3.0', env), /缺少更新说明/);
  await writeFile(join(root, 'release/notes/0.3.0.txt'), '这一版的说明\n');
  await assert.rejects(checkRelease(inputs, 'v0.3.0', {}), /没有拿到更新私钥/);
  await assert.rejects(checkRelease(inputs, 'v0.3.0', { XA_UPDATE_PRIVATE_KEY: await readFile(other, 'utf8') }), /不是一对/);
  assert.equal(await checkRelease(inputs, 'v0.3.0', env), '0.3.0');

  await writeFile(join(packages, packageName('0.3.0', 'mac-arm64')), 'arm package');
  await assert.rejects(buildFeed(inputs, packages, out, env), /应当正好是/);
  await writeFile(join(packages, packageName('0.3.0', 'mac-x64')), 'intel package');
  const built = await buildFeed(inputs, packages, out, env);
  assert.deepEqual(built.files, ['captain-agents_0.3.0_macos-arm64.zip', 'captain-agents_0.3.0_macos-x64.zip', 'latest-v2.json', 'latest.json']);
  const feed = verifyFeed(await readFile(join(out, 'latest-v2.json')), publicKey), legacy = verifyLegacyFeed(await readFile(join(out, 'latest.json')), publicKey);
  assert.equal(feed.version, '0.3.0'); assert.equal(feed.minimumVersion, '0.2.0'); assert.deepEqual(Object.keys(feed.packages), ['darwin-arm64', 'darwin-x64']);
  assert.deepEqual(feed.packages['darwin-x64'].urls, ['https://store.example.invalid/0.3.0/captain-agents_0.3.0_macos-x64.zip', 'https://pages.example.invalid/v0.3.0/captain-agents_0.3.0_macos-x64.zip']);
  assert.equal(legacy.packages['darwin-arm64'].url, 'https://pages.example.invalid/v0.3.0/captain-agents_0.3.0_macos-arm64.zip');
  assert.equal(legacy.packages['darwin-arm64'].sha256, feed.packages['darwin-arm64'].sha256);
  // 多了一个不该有的文件也不签；配置写错在读的时候就拦下。
  await writeFile(join(packages, 'extra.zip'), 'x');
  await assert.rejects(buildFeed(inputs, packages, join(c.temp, 'feeds2'), env), /应当正好是/);
  await writeFile(join(root, 'release/config.json'), JSON.stringify({ ...config, targets: ['mac-arm64', 'mac-arm64'] }));
  await assert.rejects(readInputs(root), /targets/);
});
