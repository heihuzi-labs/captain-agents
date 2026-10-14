// 探针：Windows 上各家图标能从哪里取。用 Electron 跑：npx electron scripts/probe/windows-icons.cjs <输出目录>
const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const out = path.resolve(process.argv[process.argv.length - 1]);
const result = { candidates: [], packages: [], windowsApps: null, aliases: null, errors: [] };
const local = process.env.LOCALAPPDATA;
function tryList(dir) { try { return fs.readdirSync(dir); } catch (e) { return `ERR ${e.code}`; } }
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const exes = [];
  exes.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
  const names = tryList(bin); result.codexBin = names;
  if (Array.isArray(names)) for (const n of names) exes.push(path.join(bin, n, 'codex.exe'));
  result.windowsApps = tryList('C:\\Program Files\\WindowsApps');
  result.aliases = tryList(path.join(local, 'Microsoft', 'WindowsApps'));
  // 注册表里的包（探针才用 reg.exe；应用里另想办法）
  try {
    const text = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages'], { encoding: 'utf8' });
    for (const key of text.split(/\r?\n/).filter(l => /OpenAI|ChatGPT|DeepSeek|Cursor|Claude/i.test(l))) {
      const pkg = { key: key.trim() };
      try { pkg.values = execFileSync('reg', ['query', key.trim()], { encoding: 'utf8' }); } catch (e) { pkg.values = String(e); }
      const m = /PackageRootFolder\s+REG_SZ\s+(.+)/.exec(pkg.values || '');
      if (m) {
        const root = m[1].trim(); pkg.root = root; pkg.rootList = tryList(root);
        try {
          const manifest = fs.readFileSync(path.join(root, 'AppxManifest.xml'), 'utf8');
          pkg.logos = [...manifest.matchAll(/(Logo|Square\d+x\d+Logo|Wide\d+x\d+Logo)="([^"]+)"/g)].map(x => `${x[1]}=${x[2]}`);
          pkg.executables = [...manifest.matchAll(/Executable="([^"]+)"/g)].map(x => x[1]);
          for (const e of pkg.executables) exes.push(path.join(root, e));
          const res = path.join(root, 'app', 'resources'), resList = tryList(res); pkg.resources = Array.isArray(resList) ? resList.filter(f => /\.(png|ico)$/i.test(f)) : resList;
          if (Array.isArray(pkg.resources)) for (const f of pkg.resources) { try { fs.copyFileSync(path.join(res, f), path.join(out, `res-${f}`)); } catch (e) { result.errors.push(`copy ${f}: ${e.code}`); } }
          for (const l of pkg.logos) {
            const rel = l.split('=')[1], dir = path.join(root, path.dirname(rel)), base = path.basename(rel, path.extname(rel));
            const files = tryList(dir); pkg[`assets:${rel}`] = Array.isArray(files) ? files.filter(f => f.startsWith(base)) : files;
            if (Array.isArray(files)) for (const f of files.filter(f => f.startsWith(base))) {
              try { fs.copyFileSync(path.join(dir, f), path.join(out, `asset-${path.basename(root).slice(0, 20)}-${f}`)); } catch (e) { result.errors.push(`copy ${f}: ${e.code}`); }
            }
          }
        } catch (e) { pkg.manifestError = e.code || String(e); }
      }
      result.packages.push(pkg);
    }
  } catch (e) { result.errors.push(`reg: ${e}`); }
  let i = 0;
  for (const exe of exes) {
    const c = { exe, exists: fs.existsSync(exe) };
    if (c.exists) for (const size of ['normal', 'large']) {
      try {
        const img = await app.getFileIcon(exe, { size });
        const png = img.toPNG(); const file = path.join(out, `icon-${i}-${size}.png`); fs.writeFileSync(file, png);
        c[size] = { file: path.basename(file), bytes: png.length, size: img.getSize() };
      } catch (e) { c[size] = `ERR ${e.message}`; }
    }
    result.candidates.push(c); i++;
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  app.quit();
});
