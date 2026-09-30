import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { defaultColumns } from '../app/shared/ipc.ts';

const renderer = resolve('app/renderer');
async function files(dir: string, pattern: RegExp) {
  return (await readdir(dir, { recursive: true })).filter(name => pattern.test(name)).map(name => join(dir, name));
}
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(/;

test('规范：身份、用时、状态、进展文字在深浅底色上对比度至少 4.5:1', async () => {
  const css = strip(await readFile(join(renderer, 'styles/tokens.css'), 'utf8'));
  const themes = css.split('@media (prefers-color-scheme: dark)');
  const luminance = (hex: string) => {
    const rgb = hex.slice(1).match(/../g)!.map(channel => {
      const s = parseInt(channel, 16) / 255;
      return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
    });
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const theme of themes) {
    const colors = new Map([...theme.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/g)].map(match => [match[1], match[2]]));
    for (const background of ['--bg', '--panel', '--sunk', '--ok-soft', '--bad-soft', '--warn-soft', '--accent-soft']) {
      const fg = luminance(colors.get('--text')!), bg = luminance(colors.get(background)!);
      const contrast = (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
      assert.ok(contrast >= 4.5, `--text 在 ${background} 上的对比度 ${contrast}`);
    }
    // 分段切换：没选中的段用 --muted 写在底槽上，选中的段用 --text 写在滑块上。
    for (const [foreground, background] of [['--muted', '--seg-track'], ['--text', '--seg-thumb']]) {
      const fg = luminance(colors.get(foreground)!), bg = luminance(colors.get(background)!);
      assert.ok((Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) >= 4.5, `${foreground} 在 ${background} 上的对比度不足 4.5:1`);
    }
  }
  const ui = strip(await readFile(join(renderer, 'styles/ui.css'), 'utf8'));
  for (const selector of ['.ident', '.ident-text', '.ident-elapsed', '.ident-end', '.chip', '.activity-category, .activity-action, .activity-say']) {
    const rule = ui.split('\n').find(line => line.startsWith(selector + ' {')) ?? '';
    assert.match(rule, /color: var\(--text\)/, `${selector} 必须用正文颜色`);
  }
  const spec = await readFile(resolve('docs/ui-spec.md'), 'utf8');
  assert.ok(spec.includes('4.5:1'));
  assert.ok(spec.includes('`--text` 正文色'));
});

// 页面和内容只能拼装统一部件（app/renderer/ui/），自己不能再写一份。
async function pageSources() {
  const names = [...await files(join(renderer, 'components'), /\.tsx?$/), ...await files(join(renderer, 'lib'), /\.tsx?$/), join(renderer, 'App.tsx')];
  return Promise.all(names.map(async name => ({ name: relative(process.cwd(), name), text: await readFile(name, 'utf8') })));
}
test('规范：页面源码不自己画图标、弹窗、关闭按钮、按钮样式，不写死颜色', async () => {
  const rules: [string, RegExp][] = [
    ['直接写 <img（图标只能来自 WorkerIcon）', /<img[\s>]/],
    ['自己做弹窗（用 Modal 或 ConfirmDialog）', /<dialog[\s>]|role=["']a?l?e?r?t?dialog["']|aria-modal/],
    ['自己做弹窗外框、暗幕或关闭按钮的样式类', /className=["'`{][^"'`}]*\b(?:sheet|scrim|modal|close|close-button)\b/],
    ['自己写按钮样式类（用 Button）', /className=["'`{][^"'`}]*\bbtn\b/],
    ['直接用浏览器的确认框（用 ConfirmDialog）', /window\.(?:confirm|alert)\(|\bconfirm\(|\balert\(/],
    ['写死的颜色（用 tokens.css 里的变量）', COLOR],
    ['行内样式里写颜色（用变量）', /style=\{\{[^}]*\b(?:color|background|border|fill|stroke)\b\s*:/],
  ];
  for (const { name, text } of await pageSources()) for (const [what, rule] of rules) assert.doesNotMatch(text, rule, `${name}：${what}`);
});

test('规范：开关只许用 Switch，renderer 里不许再出现浏览器自带的方形勾选框', async () => {
  const sources = await files(renderer, /\.tsx?$/);
  assert.ok(sources.length > 10);
  for (const name of sources) {
    const text = await readFile(name, 'utf8');
    assert.doesNotMatch(text, /type=["'{]+\s*["']?checkbox/, `${relative(process.cwd(), name)}：用 Switch（开关）或 CheckDot（表格里的勾选点），不用 type="checkbox"`);
  }
  const styles = strip(await readFile(join(renderer, 'styles/ui.css'), 'utf8'));
  assert.doesNotMatch(styles, /input\[type=["']?checkbox/, 'ui.css：不再给方形勾选框写样式');
});

test('规范：样式文件只用变量，颜色、字号、圆角、间距不写死', async () => {
  const tokens = strip(await readFile(join(renderer, 'styles/tokens.css'), 'utf8'));
  // 元素自己身上赋值的局部变量（--state、--hue、--batch）也算有定义。
  const runtime = (await pageSources()).flatMap(({ text }) => [...text.matchAll(/'(--[\w-]+)'/g)].map(match => match[1]));
  const local = (await Promise.all((await files(join(renderer, 'styles'), /\.css$/)).map(async name => strip(await readFile(name, 'utf8')))))
    .flatMap(css => [...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  const defined = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]).concat(runtime, local));
  for (const name of await files(join(renderer, 'styles'), /\.css$/)) {
    if (name.endsWith('tokens.css')) continue;
    const css = strip(await readFile(name, 'utf8')), label = relative(process.cwd(), name);
    assert.doesNotMatch(css, COLOR, `${label}：写死的颜色`);
    for (const use of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(defined.has(use[1]), `${label}：用了没有定义的变量 ${use[1]}`);
    for (const declaration of css.matchAll(/([\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
      const [, property, raw] = declaration, value = raw.replace(/var\([^)]*\)/g, '');
      if (/^(?:font-size|border-radius|padding[\w-]*|margin[\w-]*|gap|row-gap|column-gap)$/.test(property)) {
        assert.doesNotMatch(value, /(?<![\w.])[1-9]\d*(?:\.\d+)?px\b/, `${label}：${property}: ${raw.trim()} 写死了像素数`);
      }
    }
  }
});

test('规范：卡片左边的状态色条不许回来（类名、变量、传 state、左右色条的内阴影和左边框）', async () => {
  const sources = await files(renderer, /\.(?:tsx?|css)$/);
  assert.ok(sources.length > 10);
  const rules: [string, RegExp][] = [
    ['状态色边的样式类', /\bst-(?:queued|running|quiet|decide|failed|lost|done|stopped)\b/],
    ['状态色边的部件写法', /\bstateClass\b|\bCardState\b/],
    ['状态色边的局部变量 --state', /--state(?![\w-])/],
    ['色边粗细变量 --edge', /--edge\b/],
    ['给卡片传 state', /<(?:Card|MemberRow)\b[^>]*\bstate=/],
  ];
  const cssRules: [string, RegExp][] = [
    ['横向偏移不为 0 的内阴影（左右色条）', /inset\s+(?!0\s)[^,;]+/],
    ['用状态色、语义色、批次色画左边框', /border-left[\w-]*\s*:[^;]*var\(--(?:state|ok|warn|bad|accent|batch|reply)/],
  ];
  for (const name of sources) {
    const raw = await readFile(name, 'utf8'), text = name.endsWith('.css') ? strip(raw) : raw, label = relative(process.cwd(), name);
    for (const [what, rule] of rules) assert.doesNotMatch(text, rule, `${label}：${what}`);
    if (name.endsWith('.css')) for (const [what, rule] of cssRules) assert.doesNotMatch(text, rule, `${label}：${what}`);
  }
});

test('规范：深色只覆盖已有变量；变量和统一部件都写进了 ui-spec.md；恢复默认的列颜色与状态色一致', async () => {
  const css = strip(await readFile(join(renderer, 'styles/tokens.css'), 'utf8'));
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  const light = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
  const names = (text: string) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]);
  const lightNames = new Set(names(light));
  for (const name of names(dark)) assert.ok(lightNames.has(name), `深色覆盖了浅色里没有的变量 ${name}`);
  const spec = await readFile(resolve('docs/ui-spec.md'), 'utf8');
  for (const name of lightNames) assert.ok(spec.includes(name), `ui-spec.md 没有写变量 ${name}`);
  const index = await readFile(join(renderer, 'ui/index.ts'), 'utf8');
  const exported = [...index.matchAll(/export \{([^}]*)\}/g)].flatMap(match => match[1].split(',').map(item => item.trim()).filter(Boolean));
  for (const name of exported) assert.ok(spec.includes(name), `ui-spec.md 没有登记统一部件 ${name}`);
  const value = (name: string): string => {
    const raw = new RegExp(`${name}:\\s*([^;]+);`).exec(light)![1].trim(), ref = /^var\((--[\w-]+)\)$/.exec(raw);
    return ref ? value(ref[1]) : raw;
  };
  assert.deepEqual(defaultColumns, { running: value('--state-running'), attention: value('--state-decide'), done: value('--state-done') });
});

test('规范：验收中的列色深浅两套都不同，也不和进行中、已完成、批次色板撞', async () => {
  const css = strip(await readFile(join(renderer, 'styles/tokens.css'), 'utf8'));
  const [light, dark] = css.split('@media (prefers-color-scheme: dark)');
  // 深色只覆盖一部分变量，没覆盖的沿用浅色；变量引用在当前这套里解析。
  const value = (theme: string, name: string): string => {
    const raw = (new RegExp(`${name}:\\s*([^;]+);`).exec(theme) ?? new RegExp(`${name}:\\s*([^;]+);`).exec(light))?.[1].trim();
    assert.ok(raw, `${name} 没定义`);
    const ref = /^var\((--[\w-]+)\)$/.exec(raw);
    return ref ? value(theme, ref[1]) : raw;
  };
  for (const [label, theme] of [['浅色', light], ['深色', dark]] as const) {
    const decide = value(theme, '--state-decide');
    for (const other of ['--state-running', '--state-done', '--state-failed', '--warn']) assert.notEqual(decide.toLowerCase(), value(theme, other).toLowerCase(), `${label}：验收中的颜色不许和 ${other} 一样`);
  }
  const decideLight = value(light, '--state-decide');
  for (let i = 1; i <= 6; i++) assert.notEqual(decideLight.toLowerCase(), value(light, `--batch-${i}`).toLowerCase(), `验收中的颜色不许和批次色 ${i} 一样`);
  assert.notEqual(value(light, '--state-decide'), value(dark, '--state-decide'), '深浅两套各自调过');
});
test('规范：列头任何宽度都不折行——列是容器，窄了收“近 24 小时”和“全部”，样式里写了这些规则', async () => {
  const layout = strip(await readFile(join(renderer, 'styles/layout.css'), 'utf8'));
  assert.match(layout, /\.chead > \* \{ white-space: nowrap; \}/);
  assert.match(layout, /container: col \/ inline-size/);
  assert.match(layout, /@container col \(max-width: \d+px\) \{ \.chead \.range \{ display: none; \} \}/);
  assert.match(layout, /@container col \(max-width: \d+px\) \{ \.chead \.long \{ display: none; \} \}/);
  assert.match(layout, /#v-board \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, '看板平均分为三列');
});

test('规范：选手身份只有一行，两行写法的类名和为两行撑大图标的规则不许回来，图标只按尺寸取一档', async () => {
  const ui = strip(await readFile(join(renderer, 'styles/ui.css'), 'utf8'));
  const sources = [ui, ...(await Promise.all((await files(join(renderer, 'ui'), /\.tsx?$/)).map(name => readFile(name, 'utf8'))))];
  for (const text of sources) assert.doesNotMatch(text, /ident-copy|ident-top|ident-name|ident-meta/, '两行写法的类名');
  assert.doesNotMatch(ui, /\.ident[^{]*>\s*\.logo\s*\{/, '身份里的图标不许另撑尺寸');
  for (const size of ['sm', 'md', 'lg']) assert.match(ui, new RegExp(`--icon-${size}`));
  const spec = await readFile(resolve('docs/ui-spec.md'), 'utf8');
  assert.match(spec, /厂家名不写成文字/);
});

test('规范：顶栏是分段切换 + 状态块 + 设置，旧的页签、额度条、自检胶囊、品牌字和“在跑”数字不许回来', async () => {
  const sources = await files(renderer, /\.(?:tsx?|css)$/);
  const rules: [string, RegExp][] = [
    ['旧的额度条 .meter', /\.meter\b|["'\s]meter["'\s]/],
    ['旧的自检胶囊 check-pill', /check-pill/],
    ['顶栏品牌字样式 .brand', /\.brand\b|className="brand"/],
    ['旧的页头页签 .nav', /\.nav\b|className="nav"/],
    ['顶栏“在跑”数字', /\{running\} 在跑|件等你<\/span>/],
  ];
  for (const name of sources) {
    const raw = await readFile(name, 'utf8'), text = name.endsWith('.css') ? strip(raw) : raw;
    for (const [what, rule] of rules) assert.doesNotMatch(text, rule, `${relative(process.cwd(), name)}：${what}`);
  }
  const spec = await readFile(resolve('docs/ui-spec.md'), 'utf8');
  for (const name of ['Segmented', 'QuotaRing', 'StatusCluster', '## 11. 顶栏']) assert.ok(spec.includes(name), `ui-spec.md 没写 ${name}`);
  const main = await readFile(resolve('app/main/index.ts'), 'utf8');
  assert.match(main, /trafficLightPosition/, '主进程要按顶栏高度摆红黄绿按钮');
});
