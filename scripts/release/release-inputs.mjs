// 构建和发版流水线用的几件小事。规则只写在 release/config.json，这里只是照着它办。
//   env                         打印三行 XA_UPDATE_*=…（打包时编进应用的更新配置）
//   describe <打包目标>           打印这个目标的版本、安装包文件名、应用启动后应报的“系统-芯片”
//   targets                     打印发版要构建的打包目标（JSON 数组）
//   check --tag v0.3.0          发版前的门槛：标签等于版本号、有更新说明、私钥和公钥成对
//   feed --dir <包目录> --out <输出目录>   用私钥签出 latest-v2.json 和 latest.json，并核对包齐全
// 私钥只从环境变量 XA_UPDATE_PRIVATE_KEY 读（流水线里来自仓库机密），不打印、不留在磁盘上。
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateHosts } from '../../app/main/update-download.ts';
import { MAX_NOTES_LENGTH, updatePublicKey, validVersion } from '../../app/main/update-feed.ts';
import { makeUpdate } from './make-update.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// 打包目标 → 清单里的平台名、共用下载桶里的文件名后缀。
export const PACKAGES = {
  'mac-arm64': { platform: 'darwin-arm64', suffix: 'macos-arm64.zip' },
  'mac-x64': { platform: 'darwin-x64', suffix: 'macos-x64.zip' },
  'win-x64': { platform: 'win32-x64', suffix: 'windows-x64.exe' },
};
export const packageName = (version, target) => `captain-agents_${version}_${PACKAGES[target].suffix}`;

export async function readInputs(root = ROOT) {
  const config = JSON.parse(await readFile(join(root, 'release/config.json'), 'utf8'));
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  if (!validVersion(version)) throw new Error('package.json 的版本号必须是规范的 x.y.z。');
  if (!validVersion(config.minimumVersion)) throw new Error('release/config.json 的 minimumVersion 必须是规范的 x.y.z。');
  if (!Array.isArray(config.feeds) || !Array.isArray(config.hosts)) throw new Error('release/config.json 的 feeds 和 hosts 必须是列表。');
  updateHosts(config.feeds.join(','), config.hosts);   // 和应用用同一套规则检查清单地址与主机名单
  updatePublicKey(config.publicKey);
  if (!Array.isArray(config.targets) || !config.targets.length || new Set(config.targets).size !== config.targets.length || config.targets.some(t => !Object.hasOwn(PACKAGES, t))) throw new Error(`release/config.json 的 targets 只能写：${Object.keys(PACKAGES).join('、')}，不能重复或为空。`);
  if (!Array.isArray(config.downloadBases) || config.downloadBases.length < 1 || config.downloadBases.length > 4 || typeof config.legacyBase !== 'string') throw new Error('release/config.json 要有 1–4 个 downloadBases 和一个 legacyBase。');
  for (const base of [...config.downloadBases, config.legacyBase]) if (typeof base !== 'string' || !base.includes('{version}')) throw new Error('下载前缀里要有 {version}。');
  return { root, config, version };
}
export function buildEnvironment({ config }) {
  return { XA_UPDATE_FEED: config.feeds.join(','), XA_UPDATE_HOSTS: config.hosts.join(','), XA_UPDATE_PUBLIC_KEY: config.publicKey };
}
export function describeTarget({ version }, target) {
  if (!Object.hasOwn(PACKAGES, target)) throw new Error(`不认识的打包目标：${target}`);
  return { APP_VERSION: version, PACKAGE_NAME: packageName(version, target), EXPECTED_TARGET: PACKAGES[target].platform };
}
const notesFile = ({ root, version }) => join(root, 'release/notes', `${version}.txt`);
async function readNotes(inputs) {
  let notes;
  try { notes = await readFile(notesFile(inputs), 'utf8'); } catch { throw new Error(`缺少更新说明：release/notes/${inputs.version}.txt`); }
  if (!notes.trim() || notes.length > MAX_NOTES_LENGTH) throw new Error(`更新说明须为 1–${MAX_NOTES_LENGTH} 字的纯文字。`);
  return notes;
}
function privateKeyFromEnvironment(env) {
  const pem = env.XA_UPDATE_PRIVATE_KEY;
  if (!pem || !pem.trim()) throw new Error('没有拿到更新私钥（环境变量 XA_UPDATE_PRIVATE_KEY）。');
  let key;
  try { key = createPrivateKey(pem); } catch { throw new Error('更新私钥读不出来。'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('更新私钥必须是 Ed25519。');
  return { pem, publicKey: Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64') };
}
export async function checkRelease(inputs, tag, env = process.env) {
  if (tag !== `v${inputs.version}`) throw new Error(`标签 ${tag} 和 package.json 的版本 ${inputs.version} 对不上；标签必须是 v${inputs.version}。`);
  await readNotes(inputs);
  if (privateKeyFromEnvironment(env).publicKey !== inputs.config.publicKey) throw new Error('更新私钥和 release/config.json 里的公钥不是一对。');
  return inputs.version;
}
export async function buildFeed(inputs, directory, out, env = process.env) {
  const { config, version } = inputs, wanted = config.targets.map(target => packageName(version, target));
  const found = (await readdir(directory)).sort();
  if (found.length !== wanted.length || wanted.some(name => !found.includes(name))) throw new Error(`安装包目录里应当正好是：${wanted.join('、')}；实际是：${found.join('、') || '空的'}。`);
  await readNotes(inputs);
  const { pem, publicKey } = privateKeyFromEnvironment(env);
  if (publicKey !== config.publicKey) throw new Error('更新私钥和 release/config.json 里的公钥不是一对。');
  const fill = base => base.replaceAll('{version}', version);
  const temporary = await mkdtemp(join(tmpdir(), 'xa-release-key-'));
  try {
    const keyFile = join(temporary, 'key.pem');
    await writeFile(keyFile, pem, { mode: 0o600, flag: 'wx' });
    await makeUpdate({ version, minimumVersion: config.minimumVersion, notes: notesFile(inputs),
      packages: config.targets.map(target => ({ platform: PACKAGES[target].platform, file: join(directory, packageName(version, target)) })),
      baseUrls: config.downloadBases.map(fill), legacyBaseUrl: fill(config.legacyBase),
      privateKey: keyFile, out: join(out, 'latest-v2.json'), legacyOut: join(out, 'latest.json') });
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { version, files: [...wanted, 'latest-v2.json', 'latest.json'] };
}
const lines = values => Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
const option = (args, name) => { const at = args.indexOf(name); if (at < 0 || !args[at + 1]) throw new Error(`缺少参数 ${name}。`); return args[at + 1]; };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2), inputs = await readInputs();
    if (command === 'env') console.log(lines(buildEnvironment(inputs)));
    else if (command === 'describe') console.log(lines(describeTarget(inputs, args[0])));
    else if (command === 'targets') console.log(JSON.stringify(inputs.config.targets));
    else if (command === 'check') console.log(`VERSION=${await checkRelease(inputs, option(args, '--tag'))}`);
    else if (command === 'feed') { const result = await buildFeed(inputs, option(args, '--dir'), option(args, '--out')); console.log(`版本 ${result.version} 的两份清单已签名并复核：${result.files.join('、')}`); }
    else throw new Error('用法：release-inputs.mjs env | describe <目标> | targets | check --tag v<版本> | feed --dir <包目录> --out <输出目录>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
