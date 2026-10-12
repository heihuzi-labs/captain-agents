import { Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { View } from '../../src/core/view-types.ts';
import type { Destination } from '../shared/ipc.ts';
import { awakeSince, fmtDur } from '../renderer/lib/board.ts';
import { ownerAttention } from '../shared/attention.ts';

// 原创「三列任务板」：直接画透明位图；不使用各家图标。
// macOS：标成模板图，系统按菜单栏深浅自己上色。Windows 没有模板图：画成蓝色（深色、浅色任务栏上都看得清），大小按 32 像素、2 倍屏给。
const WINDOWS_TRAY_COLOR = [0x4a, 0x86, 0xe8]; // 位图里的顺序是 蓝、绿、红、透明度
function trayImage(windows = process.platform === 'win32') {
  const size = windows ? 32 : 36, pixels = Buffer.alloc(size * size * 4);
  const [r, g, b] = WINDOWS_TRAY_COLOR;
  const rect = (left: number, top: number, width: number, height: number) => {
    for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
      const at = (y * size + x) * 4;
      if (windows) { pixels[at] = b; pixels[at + 1] = g; pixels[at + 2] = r; }
      pixels[at + 3] = 255;
    }
  };
  if (windows) { rect(3, 5, 6, 22); rect(13, 5, 6, 15); rect(23, 5, 6, 8); }
  else { rect(5, 8, 5, 21); rect(15, 8, 5, 14); rect(25, 8, 5, 7); }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  if (!windows) image.setTemplateImage(true);
  return image;
}
// windows：按哪种系统的习惯来；缺省看当前系统，测试里明确指定。
export function createTray(open: (target?: Destination) => void, quit: () => void, windows = process.platform === 'win32') {
  const plain = trayImage(windows), tray = new Tray(plain);
  tray.setToolTip('派活工作台');
  // Windows 上点一下图标就是打开窗口（右键才是菜单）；macOS 上点图标直接出菜单。
  if (windows) tray.on('click', () => open());
  let last: View | undefined;
  let snapshot = { title: '', running: 0, attention: 0, menu: [] as string[] };
  const update = (view: View) => {
    last = view;
    const running = view.jobs.filter(j => j.state === 'running');
    const { attention } = ownerAttention(view);
    const title = running.length ? String(running.length) : '';
    // macOS：在跑几件写在图标旁边。Windows 的托盘图标旁边不能写字，写进悬停提示里。
    if (windows) tray.setToolTip(running.length ? `派活工作台 · 在跑 ${running.length} 件` : '派活工作台');
    else tray.setTitle(title);
    snapshot = { title, running: running.length, attention: attention.length, menu: [] };
    const menu: MenuItemConstructorOptions[] = [];
    menu.push({ label: '在跑的活', enabled: false });
    for (const j of running) menu.push({ label: `${view.workers[j.who].name} · ${j.title} · ${fmtDur(awakeSince(j), true)}`, click: () => open({ kind: 'job', id: j.id }) });
    if (!running.length) menu.push({ label: '现在没有在跑的活', enabled: false });
    menu.push({ type: 'separator' }, { label: '验收中', enabled: false });
    for (const entry of attention) menu.push({ label: `${entry.members.map(j => view.workers[j.who].name).join('、')} · ${entry.title} · ${fmtDur(Math.max(...entry.members.map(j => j.seconds ?? awakeSince(j))), true)}`, click: () => open(entry.target) });
    if (!attention.length) menu.push({ label: '没有在验收的活', enabled: false });
    menu.push({ type: 'separator' }, { label: '打开派活工作台', click: () => open() }, { label: '设置…', click: () => open({ kind: 'settings' }) }, { label: '退出', click: quit });
    snapshot.menu = menu.map(item => item.label ?? '');
    tray.setContextMenu(Menu.buildFromTemplate(menu));
  };
  const timer = setInterval(() => { if (last) update(last); }, 30_000);
  return { update, inspect: () => ({ ...snapshot, exists: !tray.isDestroyed(), template: plain.isTemplateImage() }), destroy: () => { clearInterval(timer); tray.destroy(); } };
}
