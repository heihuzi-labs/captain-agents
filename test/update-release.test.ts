import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { verifyFeed } from '../app/main/update-feed.ts';
import { context, exec, root } from './helpers.ts';

test('发布 CLI：生成权限 600 的密钥、不覆盖，签好的多平台清单能被应用接受、改单字节拒绝', async t => {
  const c = await context(t, false), privateFile = join(c.temp, 'private.pem'), publicFile = join(c.temp, 'public.txt');
  const generate = () => exec(process.execPath, ['scripts/release/generate-update-key.mjs', privateFile, publicFile], root);
  const first = await generate(); assert.equal(first.code, 0, first.stderr);
  assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
  const raw = (await readFile(publicFile, 'utf8')).trim(); assert.equal(Buffer.from(raw, 'base64').length, 32);
  const key = createPrivateKey(await readFile(privateFile)); assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.ok(verify(null, Buffer.from('test'), createPublicKey(key), sign(null, Buffer.from('test'), key)));
  const before = await readFile(privateFile); assert.equal((await generate()).code, 1); assert.deepEqual(await readFile(privateFile), before);
  const arm = join(c.temp, '中文 arm.zip'), intel = join(c.temp, 'intel.zip'), notes = join(c.temp, 'notes.txt'), output = join(c.temp, 'latest.json');
  await writeFile(arm, 'fake arm'); await writeFile(intel, 'fake intel'); await writeFile(notes, '发布说明\n另一行');
  const args = ['scripts/release/make-update.mjs', '--version', '0.2.0', '--minimum-version', '0.1.0', '--package', `darwin-arm64=${arm}`, '--package', `darwin-x64=${intel}`, '--notes', notes, '--base-url', 'https://updates.example.invalid/releases/0.2.0', '--private-key', privateFile, '--out', output];
  const made = await exec(process.execPath, args, root); assert.equal(made.code, 0, made.stderr);
  const serialized = await readFile(output), feed = verifyFeed(serialized, raw);
  assert.equal(feed.version, '0.2.0'); assert.equal(feed.packages['darwin-arm64'].size, 8);
  assert.equal(feed.packages['darwin-arm64'].url, 'https://updates.example.invalid/releases/0.2.0/%E4%B8%AD%E6%96%87%20arm.zip');
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
