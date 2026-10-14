// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import { fixtureView, fixtureJob } from './fixtures.tsx';
const mock = vi.hoisted(() => ({ menu: [] as MenuItemConstructorOptions[], title: '', tip: '', click: undefined as (() => void) | undefined, destroyed: false, template: false, image: undefined as unknown, buffers: [] as Buffer[] }));
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (menu: MenuItemConstructorOptions[]) => { mock.menu = menu; return menu; } },
  nativeImage: { createFromBitmap: (pixels: Buffer) => { mock.buffers.push(pixels); return { setTemplateImage: (value: boolean) => { mock.template = value; }, isTemplateImage: () => mock.template }; } },
  Tray: class {
    constructor(image: NativeImage) { mock.image = image; mock.destroyed = false; }
    setToolTip(tip: string) { mock.tip = tip; } setTitle(title: string) { mock.title = title; } setImage(image: NativeImage) { mock.image = image; } setContextMenu() {}
    on(event: string, handler: () => void) { if (event === 'click') mock.click = handler; }
    isDestroyed() { return mock.destroyed; } destroy() { mock.destroyed = true; }
  },
}));
import { createTray } from '../../app/main/tray.ts';
afterEach(() => { vi.useRealTimers(); });
test('原创模板图、在跑件数和菜单动作；验收中不画小圆点，销毁时停计时', () => {
  mock.buffers.length = 0; mock.template = false;
  vi.useFakeTimers(); const open = vi.fn(), quit = vi.fn(), tray = createTray(open, quit, false), view = fixtureView();
  try {
    view.jobs = [fixtureJob('running', { state: 'running' }), fixtureJob('waiting')]; tray.update(view);
    expect(tray.inspect()).toMatchObject({ exists: true, title: '1', running: 1, attention: 1, template: true });
    expect(mock.buffers).toHaveLength(1);
    const items = mock.menu.map(item => item.label); expect(items.slice(-3)).toEqual(['打开派活工作台', '设置…', '退出']);
    expect(items).toContain('验收中');
    expect(items.join('\n')).not.toMatch(/等你处理|件等你|要你处理/);
    expect(items.some(label => label?.includes('Codex · running ·'))).toBe(true);
    const click = (label: string) => { const item = mock.menu.find(item => item.label?.includes(label))!; if (item.click) Reflect.apply(item.click, undefined, []); };
    click('Codex · running'); expect(open).toHaveBeenCalledWith({ kind: 'job', id: 'running' });
    click('Codex · waiting'); expect(open).toHaveBeenCalledWith({ kind: 'job', id: 'waiting' });
    click('设置…'); expect(open).toHaveBeenCalledWith({ kind: 'settings' }); click('退出'); expect(quit).toHaveBeenCalledOnce();
    view.jobs = []; tray.update(view); expect(mock.title).toBe(''); expect(tray.inspect().attention).toBe(0);
    expect(mock.menu.map(item => item.label)).toContain('没有在验收的活');
    expect(mock.buffers).toHaveLength(1);
    expect(mock.menu.map(item => item.label).join('\n')).not.toMatch(/等你处理|件等你/);
  } finally { tray.destroy(); }
  expect(mock.destroyed).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

test('Windows 的托盘：蓝色图标不是模板图，件数写在悬停提示里，左键点图标打开窗口，菜单和 macOS 同一份', () => {
  mock.buffers.length = 0; mock.template = false; mock.title = ''; mock.click = undefined;
  vi.useFakeTimers(); const open = vi.fn(), quit = vi.fn(), tray = createTray(open, quit, true), view = fixtureView();
  try {
    expect(mock.tip).toBe('派活工作台');
    view.jobs = [fixtureJob('running', { state: 'running' }), fixtureJob('second', { state: 'running' }), fixtureJob('waiting')]; tray.update(view);
    expect(tray.inspect()).toMatchObject({ exists: true, running: 2, attention: 1, template: false });
    expect(mock.tip).toBe('派活工作台 · 在跑 2 件'); expect(mock.title).toBe('');
    // 位图：32×32，有颜色的像素不透明、是蓝色（位图里按 蓝、绿、红、透明度 排）。
    const pixels = mock.buffers[0]; expect(pixels).toHaveLength(32 * 32 * 4);
    const at = (10 * 32 + 5) * 4; expect([...pixels.subarray(at, at + 4)]).toEqual([0xe8, 0x86, 0x4a, 255]);
    expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    mock.click!(); expect(open).toHaveBeenCalledWith();
    expect(mock.menu.map(item => item.label).slice(-3)).toEqual(['打开派活工作台', '设置…', '退出']);
    view.jobs = []; tray.update(view); expect(mock.tip).toBe('派活工作台');
  } finally { tray.destroy(); }
  expect(vi.getTimerCount()).toBe(0);
});
