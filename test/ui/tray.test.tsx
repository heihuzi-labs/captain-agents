// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import { fixtureView, fixtureJob } from './fixtures.tsx';
const mock = vi.hoisted(() => ({ menu: [] as MenuItemConstructorOptions[], title: '', destroyed: false, template: false, image: undefined as unknown, buffers: [] as Buffer[] }));
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (menu: MenuItemConstructorOptions[]) => { mock.menu = menu; return menu; } },
  nativeImage: { createFromBitmap: (pixels: Buffer) => { mock.buffers.push(pixels); return { setTemplateImage: (value: boolean) => { mock.template = value; }, isTemplateImage: () => mock.template }; } },
  Tray: class {
    constructor(image: NativeImage) { mock.image = image; mock.destroyed = false; }
    setToolTip() {} setTitle(title: string) { mock.title = title; } setImage(image: NativeImage) { mock.image = image; } setContextMenu() {}
    isDestroyed() { return mock.destroyed; } destroy() { mock.destroyed = true; }
  },
}));
import { createTray } from '../../app/main/tray.ts';
afterEach(() => { vi.useRealTimers(); });
test('原创模板图、在跑件数和菜单动作；验收中不画小圆点，销毁时停计时', () => {
  vi.useFakeTimers(); const open = vi.fn(), quit = vi.fn(), tray = createTray(open, quit), view = fixtureView();
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
