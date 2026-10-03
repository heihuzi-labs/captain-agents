import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_WORDS, isSecretName, workerEnv, exactEnv, codexEnvPolicy } from '../src/core/env.ts';
import { execute } from '../src/core/verify.ts';
import { context } from './helpers.ts';

test('名字带密钥字样的变量不分大小写一律算密钥；PWD、PATH、代理、TMPDIR 这些照常', () => {
  for (const name of ['OTHER_SERVICE_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'MYSQL_PWD_PASSWD', 'GOOGLE_APPLICATION_CREDENTIALS',
    'SSH_AUTH_SOCK', 'USE_LOCAL_OAUTH', 'SESSION_COOKIE', 'PRIVATE_KEY_PATH', 'my_api_key', 'Github_Token', 'XAGENTS_SELFCHECK_API_KEY']) assert.ok(isSecretName(name), name);
  for (const name of ['PATH', 'HOME', 'PWD', 'OLDPWD', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'CODEX_HOME', 'CLAUDE_CODE_TMPDIR',
    'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'GROK_MEMORY', 'GROK_DISABLE_AUTOUPDATER', 'GROK_CLAUDE_HOOKS_ENABLED', 'NODE_EXTRA_CA_CERTS', 'XAGENTS_HOME']) assert.ok(!isSecretName(name), name);
  assert.deepEqual([...SECRET_WORDS], ['KEY', 'TOKEN', 'SECRET', 'PASS', 'CREDENTIAL', 'AUTH', 'COOKIE', 'PRIVATE']);
});

test('选手的环境：继承的去掉密钥变量，平台设的照给，点名不要的再去掉；不改动传入的环境', () => {
  const inherited = { PATH: '/bin', HOME: '/h', OTHER_SERVICE_API_KEY: 'sk-test', gh_token: 'x', TMPDIR: '/tmp/old', OPENAI_FEDERATION_RULE_ID: 'r' };
  const env = workerEnv(inherited, { TMPDIR: '/job/tmp', CODEX_HOME: '/c' }, ['OPENAI_FEDERATION_RULE_ID']);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', TMPDIR: '/job/tmp', CODEX_HOME: '/c' });
  assert.equal(inherited.OTHER_SERVICE_API_KEY, 'sk-test');
});

test('交给执行器时没列出的变量写成 undefined，子进程真的看不到', async t => {
  const c = await context(t, false);
  const old = process.env.XA_ENV_TEST_API_KEY; process.env.XA_ENV_TEST_API_KEY = 'fake';
  t.after(() => { if (old === undefined) delete process.env.XA_ENV_TEST_API_KEY; else process.env.XA_ENV_TEST_API_KEY = old; });
  const env = exactEnv(workerEnv(process.env, { XA_ENV_TEST_PLAIN: 'plain' }));
  assert.ok('XA_ENV_TEST_API_KEY' in env); assert.equal(env.XA_ENV_TEST_API_KEY, undefined);
  const r = await execute(process.execPath, ['-e', 'console.log(JSON.stringify([Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE/i.test(k)), process.env.XA_ENV_TEST_PLAIN]))'], c.temp, 5000, undefined, env);
  assert.equal(r.exit, 0, r.output); assert.deepEqual(JSON.parse(r.output.trim()), [[], 'plain']);
});

test('Codex 那一层：同一组词写成通配，另外点名的变量原样加在后面', () => {
  assert.equal(codexEnvPolicy(), 'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*","*PASS*","*CREDENTIAL*","*AUTH*","*COOKIE*","*PRIVATE*"]');
  assert.ok(codexEnvPolicy(['OPENAI_FEDERATION_RULE_ID']).endsWith(',"OPENAI_FEDERATION_RULE_ID"]'));
});
