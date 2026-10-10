import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { compareVersions, MAX_FEED_SIZE, selectUpdate, verifyFeed } from '../app/main/update-feed.ts';
import { feed, pkg, publicKey, signed } from './update-helpers.ts';

test('清单按原文 UTF-8 验签：合法、换空格、改一个字节、错签名、错公钥', () => {
  assert.deepEqual(verifyFeed(signed(), publicKey), feed());
  const body = JSON.stringify(feed(), null, 2);
  assert.deepEqual(verifyFeed(signed(undefined, body), publicKey), feed());
  const envelope = JSON.parse(signed().toString());
  envelope.body = envelope.body.replace('0.2.0', '0.2.1'); // 只改一个 ASCII 字节。
  assert.throws(() => verifyFeed(JSON.stringify(envelope), publicKey), /签名不对/);
  envelope.body = JSON.stringify(feed(), null, 2);
  assert.throws(() => verifyFeed(JSON.stringify(envelope), publicKey), /签名不对/);
  envelope.signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => verifyFeed(JSON.stringify(envelope), publicKey), /签名不对/);
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
  assert.throws(() => verifyFeed(signed(), Buffer.from(other, 'base64url').toString('base64')), /签名不对/);
});

test('外壳、编码、长度、公钥和签名格式严格检查', () => {
  for (const text of ['{}', '[]', 'null', '{broken', JSON.stringify({ ...JSON.parse(signed().toString()), extra: 1 }), JSON.stringify({ body: 1, signature: 'x' }), JSON.stringify({ body: 'x'.repeat(65537), signature: 'x' }), JSON.stringify({ body: '\ud800', signature: 'x' })]) assert.throws(() => verifyFeed(text, publicKey));
  assert.throws(() => verifyFeed(Buffer.alloc(MAX_FEED_SIZE + 1), publicKey), /太大/);
  assert.throws(() => verifyFeed(Buffer.from([0xff]), publicKey), /UTF-8/);
  for (const key of ['', 'x'.repeat(44), publicKey + '\n', Buffer.alloc(31).toString('base64')]) assert.throws(() => verifyFeed(signed(), key));
  for (const signature of ['bad', Buffer.alloc(63).toString('base64')]) assert.throws(() => verifyFeed(JSON.stringify({ body: '{}', signature }), publicKey), /签名格式/);
});

const badFields: [string, unknown][] = [
  ['version', '01.2.3'], ['version', '1.2'], ['version', 'v1.2.3'], ['version', '1.2.3-beta'], ['version', 123], ['version', '9007199254740992.0.0'],
  ['minimumVersion', '9.0.0'], ['publishedAt', '2026-02-30T12:00:00.000Z'], ['publishedAt', '2026-10-10'], ['publishedAt', null],
  ['notes', ''], ['notes', ' '.repeat(3)], ['notes', 'x'.repeat(8001)], ['notes', '\u0000'], ['notes', 1], ['notes', '\u202e'],
  ['packages', []], ['packages', {}], ['packages', { bad: pkg }], ['packages', Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`os-${i}`, pkg]))],
];
for (const [name, value] of badFields) test(`拒绝坏清单字段 ${name} / ${JSON.stringify(value).slice(0, 40)}`, () => {
  assert.throws(() => verifyFeed(signed({ ...feed(), [name]: value }), publicKey));
});
test('未知字段、缺字段和所有坏包字段整份拒绝（包括非本平台）', () => {
  const original = feed();
  for (const name of Object.keys(original)) { const changed = { ...original } as Record<string, unknown>; delete changed[name]; assert.throws(() => verifyFeed(signed(changed), publicKey)); }
  assert.throws(() => verifyFeed(signed({ ...feed(), extra: 1 }), publicKey), /字段/);
  for (const change of [{ url: 'http://updates.example.invalid/a' }, { url: 'https://u:p@updates.example.invalid/a' }, { url: 'https://updates.example.invalid/a#b' }, { url: 'https://updates.example.invalid/ a' }, { url: null }, { size: 0 }, { size: 1.5 }, { size: 1024 ** 3 + 1 }, { size: '12' }, { sha256: 'x'.repeat(64) }, { sha256: 'a'.repeat(63) }, { sha256: null }, { extra: 1 }]) {
    assert.throws(() => verifyFeed(signed(feed({ packages: { 'darwin-arm64': pkg, 'other-x64': { ...pkg, ...change } as never } })), publicKey));
  }
});
test('只认严格更新：相等、更旧不动，数值比较、最低版本、缺平台', () => {
  for (const version of ['0.1.0', '0.0.9']) assert.equal(selectUpdate(feed({ version, minimumVersion: '0.0.0' }), '0.1.0', 'darwin', 'arm64'), null);
  assert.deepEqual(selectUpdate(feed(), '0.1.0', 'darwin', 'arm64'), pkg);
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'), /版本号/);
  assert.throws(() => selectUpdate(feed(), '0.0.9', 'darwin', 'arm64'), /手动安装/);
  assert.throws(() => selectUpdate(feed(), '0.1.0', 'darwin', 'x64'), /这个平台暂时没有更新包/);
});
