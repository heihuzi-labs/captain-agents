import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexConfigFile, codexEndpoint, official, parseEndpoint } from '../src/core/endpoint.ts';
import { codexEnvPolicy } from '../src/core/env.ts';

test('接口：没写、或写的是官方的，什么都不带', () => {
  for (const text of ['', 'model = "gpt-6-astra"\n', 'model_provider = "openai"\n[features]\nhooks = true\n']) assert.deepEqual(parseEndpoint(text), official);
});

test('接口：自定义接口那一段原样带上，钥匙由 Codex 自己取；别的配置一项不带', () => {
  const got = parseEndpoint([
    '\uFEFFmodel = "x"', 'model_provider = "relay"   # 我的接口', 'notify = ["bad", "program"]', '',
    '[model_providers.relay]', 'name = "Relay"', 'base_url = "https://example.test/v1"', "wire_api = 'responses'", 'requires_openai_auth = true', 'stream_max_retries = 3', 'unknown_key = "x"',
    '', '[model_providers.other]', 'base_url = "https://other.test"', '', '[mcp_servers.trap]', 'command = "bad"', ''].join('\r\n'));
  assert.deepEqual(got, { custom: true, envKey: null, problem: null, args: ['-c', 'model_provider="relay"', '-c',
    'model_providers.relay={name="Relay",base_url="https://example.test/v1",wire_api="responses",requires_openai_auth=true,stream_max_retries=3}'] });
  assert.ok(!got.args.join(' ').includes('bad') && !got.args.join(' ').includes('other.test'), '通知程序、外部连接、别的接口都不带');
});

test('接口：钥匙放在环境变量里的，只点名那一个；地址参数一行写的小表和子表都认', () => {
  const inline = parseEndpoint('model_provider="r"\n[model_providers.r]\nbase_url="http://127.0.0.1:8080/v1"\nenv_key = "RELAY"\nquery_params = { "api-version" = "2026-01-01", a = \'b\' }\n');
  assert.equal(inline.envKey, 'RELAY'); assert.equal(inline.problem, null);
  assert.equal(inline.args.at(-1), 'model_providers.r={base_url="http://127.0.0.1:8080/v1",env_key="RELAY",query_params={api-version="2026-01-01",a="b"}}');
  const table = parseEndpoint('model_provider="r"\n[model_providers.r]\nbase_url="https://x.test"\n[model_providers.r.query_params]\nv = "1"\n');
  assert.equal(table.args.at(-1), 'model_providers.r={base_url="https://x.test",query_params={v="1"}}');
  // 放行的变量名字里没有“KEY”这类字样时，也明写不交给选手跑的命令。
  assert.ok(codexEnvPolicy(['RELAY']).includes('"RELAY"'));
  assert.equal(parseEndpoint('model_provider="r"\n[model_providers.r]\nenv_key = "A B"\n').envKey, null);
});

test('接口：只改了官方接口的地址，也算自定义', () => {
  assert.deepEqual(parseEndpoint('openai_base_url = "https://relay.test/v1"\n'), { custom: true, envKey: null, problem: null, args: ['-c', 'openai_base_url="https://relay.test/v1"'] });
});

test('接口：直接写着钥匙的项不带，说明原因；读不懂的也不带，都按“不是官方接口”算', () => {
  const secret = parseEndpoint('model_provider="r"\n[model_providers.r]\nbase_url="https://x.test"\nexperimental_bearer_token = "sk-secret"\n[model_providers.r.http_headers]\nAuthorization = "Bearer sk-secret"\n');
  assert.ok(!secret.args.join(' ').includes('sk-secret'), '钥匙不进启动参数');
  assert.match(secret.problem!, /直接写着钥匙（experimental_bearer_token、http_headers）.*codex login --with-api-key/);
  assert.equal(secret.custom, true);
  const odd = parseEndpoint('model_provider = """\nrelay"""\n');
  assert.equal(odd.custom, true); assert.deepEqual(odd.args, []); assert.match(odd.problem!, /读不懂 model_provider/);
  const name = parseEndpoint('model_provider = "a b"\n[model_providers."a b"]\nbase_url = "https://x.test"\n');
  assert.deepEqual(name.args, []); assert.match(name.problem!, /平台不认的字符/);
  const value = parseEndpoint('model_provider="r"\n[model_providers.r]\nbase_url = ["a"]\nwire_api="responses"\n');
  assert.equal(value.args.at(-1), 'model_providers.r={wire_api="responses"}'); assert.match(value.problem!, /读不懂 base_url/);
});

test('接口：带进参数的值重新写过，配置里的引号和花括号混不进别的设置', () => {
  const got = parseEndpoint('model_provider="r"\n[model_providers.r]\nname = "a\\"},x={y=\\"z"\nbase_url = \'https://x.test/}",evil="1\'\n');
  assert.equal(got.args.at(-1), 'model_providers.r={name="a\\"},x={y=\\"z",base_url="https://x.test/}\\",evil=\\"1"}');
});

test('接口：读用户的 Codex 文件夹（CODEX_HOME 优先）；没有配置文件就是官方的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xa-endpoint-'));
  try {
    assert.equal(codexConfigFile({ CODEX_HOME: dir }, '/home/me'), join(dir, 'config.toml'));
    assert.equal(codexConfigFile({}, join('/home', 'me')), join('/home', 'me', '.codex', 'config.toml'));
    assert.deepEqual(await codexEndpoint(join(dir, 'config.toml')), official);
    await writeFile(join(dir, 'config.toml'), 'model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://example.test/v1"\n');
    assert.equal((await codexEndpoint(join(dir, 'config.toml'))).custom, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('接口：点名的变量不能是系统或平台自己要用的；同一项写两遍不猜哪个算数', () => {
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'CODEX_HOME', 'NODE_USE_SYSTEM_CA', 'XAGENTS_HOME', 'Path']) {
    const got = parseEndpoint(`model_provider="r"\n[model_providers.r]\nbase_url="https://x.test"\nenv_key = "${name}"\n`);
    assert.equal(got.envKey, null, name); assert.ok(!got.args.join(' ').includes('env_key'), name); assert.match(got.problem!, /系统或平台自己要用的变量/);
  }
  const twice = parseEndpoint('model_provider="r"\n[model_providers.r]\nbase_url="https://a.test"\nbase_url="https://b.test"\n');
  assert.ok(!twice.args.join(' ').includes('.test')); assert.match(twice.problem!, /读不懂 base_url/);
  assert.match(parseEndpoint('model_provider="a"\nmodel_provider="b"\n').problem!, /读不懂 model_provider/);
});

test('接口：地址里自带账号密码、地址参数的名字像钥匙的，都不带进启动参数', () => {
  for (const text of [
    'model_provider="r"\n[model_providers.r]\nbase_url="https://relay.test/v1?api_key=sk-secret"\n',
    'model_provider="r"\n[model_providers.r]\nbase_url="https://user:sk-secret@relay.test/v1"\n',
    'model_provider="r"\n[model_providers.r]\nbase_url="https://relay.test/v1"\nquery_params = { api_key = "sk-secret" }\n',
    'model_provider="r"\n[model_providers.r]\nbase_url="https://relay.test/v1"\n[model_providers.r.query_params]\naccess_token = "sk-secret"\n',
    'openai_base_url = "https://relay.test/v1?token=sk-secret"\n',
  ]) {
    const got = parseEndpoint(text);
    assert.ok(!got.args.join(' ').includes('sk-secret'), text); assert.match(got.problem!, /直接写着钥匙/, text); assert.equal(got.custom, true);
  }
  // 不像钥匙的地址参数照带。
  assert.equal(parseEndpoint('model_provider="r"\n[model_providers.r]\nbase_url="https://x.test/v1?api-version=1"\nquery_params = { api-version = "2" }\n').problem, null);
});
