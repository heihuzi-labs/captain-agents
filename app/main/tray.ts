import { Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { View } from '../../src/core/view-types.ts';
import type { Destination } from '../shared/ipc.ts';
import { awakeSince, fmtDur } from '../renderer/lib/board.ts';
import { ownerAttention } from '../shared/attention.ts';

// 原创「三列任务板」：直接画透明位图，再标成模板；不使用各家图标。
function trayImage() {
  const size = 36, pixels = Buffer.alloc(size * size * 4);
  const rect = (left: number, top: number, width: number, height: number) => {
    for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) pixels[(y * size + x) * 4 + 3] = 255;
  };
  rect(5, 8, 5, 21); rect(15, 8, 5, 14); rect(25, 8, 5, 7);
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}
export function createTray(open: (target?: Destination) => void, quit: () => void) {
  const plain = trayImage(), tray = new Tray(plain);
  tray.setToolTip('派活工作台');
  let last: View | undefined;
  let snapshot = { title: '', running: 0, attention: 0, menu: [] as string[] };
  const update = (view: View) => {
    last = view;
    const running = view.jobs.filter(j => j.state === 'running');
    const { attention } = ownerAttention(view);
    const title = running.length ? String(running.length) : '';
    tray.setTitle(title);
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
