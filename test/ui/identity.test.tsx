import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chip, Elapsed, WorkerIdentity, WorkerRow } from '../../app/renderer/ui/index.ts';
import { fixtureJob, fixtureView } from './fixtures.tsx';

const css = readFileSync('app/renderer/styles/ui.css', 'utf8');
let style: HTMLStyleElement;
beforeEach(() => { style = document.createElement('style'); style.textContent = css; document.head.append(style); });
afterEach(() => { cleanup(); style.remove(); });

test('身份只有一行：图标、加粗模型名、标签、用时，结果在最右；只有模型允许截断', () => {
  const workers = fixtureView().workers;
  workers.codex.model = 'GPT 很长的模型名称 '.repeat(30);
  const { container } = render(<WorkerRow workers={workers} job={fixtureJob('one')} detail="full" end={<Chip>用了这份</Chip>} />);
  const identity = container.querySelector('.ident')!;
  expect(Array.from(identity.children, c => c.className.split(' ')[0])).toEqual(['logo', 'ident-body']);
  expect(Array.from(identity.querySelector('.ident-body')!.children, c => c.className)).toEqual(['ident-text', 'ident-end']);
  expect(identity.querySelector('.ident-copy, .ident-top, .ident-name')).toBeNull();
  const text = identity.querySelector('.ident-text')!;
  expect(getComputedStyle(identity.querySelector('.ident-body')!).flexWrap).toBe('wrap'); // 挤不下时结果整块换到下一行，模型名不被挤成一个字
  expect(Array.from(text.children, child => child.textContent)).toEqual([workers.codex.model, '高档', '1 分钟']);
  const model = text.children[0];
  expect(getComputedStyle(model).fontWeight).toBe('600');
  expect(getComputedStyle(model).textOverflow).toBe('ellipsis');
  expect(getComputedStyle(model).overflow).toBe('hidden');
  expect(getComputedStyle(model).minWidth).toBe('0px');
  expect(model.getAttribute('title')).toBe(workers.codex.model);
  for (const fixed of [text.children[1], text.children[2]]) {
    expect(getComputedStyle(fixed).flexShrink).toBe('0');
    expect(getComputedStyle(fixed).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(fixed).overflow).not.toBe('hidden');
  }
  const end = container.querySelector('.ident-end')!;
  expect(end.textContent).toBe('用了这份');
  expect(end.previousElementSibling).toBe(text); // 放得下时同一行，最右边。
  expect(getComputedStyle(end).marginLeft).toBe('auto');
  expect(getComputedStyle(end).flexShrink).toBe('0');
  expect(getComputedStyle(identity).alignItems).toBe('flex-start'); // 中号图标和第一行一样高，贴第一行对齐；结果被挤到第二行时图标仍和模型名同一行。
  expect(getComputedStyle(container.querySelector('.worker-row')!).flexWrap).toBe('nowrap');
});

test('图标只按尺寸取一档，不再为两行撑大', () => {
  const rule = (selector: string) => Array.from(style.sheet!.cssRules).find(r => 'selectorText' in r && r.selectorText === selector) as CSSStyleRule;
  expect(rule('.logo').style.getPropertyValue('width')).toBe('var(--icon-md)');
  expect(rule('.logo-sm').style.getPropertyValue('width')).toBe('var(--icon-sm)');
  expect(rule('.logo-lg').style.getPropertyValue('width')).toBe('var(--icon-lg)');
  expect(css).not.toMatch(/\.ident[^{]*> \.logo/);
});

test('厂家名不写成文字，只在悬停提示和图标的可访问名里', () => {
  const workers = fixtureView().workers;
  workers['cursor-sonnet'].name = 'Cursor · Sonnet'; workers['cursor-sonnet'].model = 'Claude Sonnet 5.5';
  const job = fixtureJob('one', { who: 'cursor-sonnet', effort: 'high', fast: true, seconds: 420 });
  const { container } = render(<WorkerIdentity workers={workers} job={job} detail="full" />);
  const identity = container.querySelector('.ident')!;
  expect(identity.textContent).not.toContain('Cursor');
  expect(identity.textContent).toBe(`${workers['cursor-sonnet'].model}高档快速7 分钟`);
  expect(identity.getAttribute('title')).toBe(`Cursor · Sonnet · ${workers['cursor-sonnet'].model} · 高档 · 快速 · 7 分钟`);
  expect(screen.getByRole('img', { name: 'Cursor · Sonnet' })).toBe(identity.querySelector('.logo'));
});
test('只有图标时厂家名、模型都在提示和可访问名里', () => {
  const workers = fixtureView().workers;
  const { container } = render(<WorkerIdentity workers={workers} who="grok" size="sm" iconOnly />);
  expect(container.textContent).toBe('');
  expect(container.querySelector('.ident')!.getAttribute('title')).toBe(`${workers.grok.name} · ${workers.grok.model}`);
  expect(screen.getByRole('img', { name: `${workers.grok.name} · ${workers.grok.model}` })).toBeTruthy();
});

test.each([['medium', '中档'], ['high', '高档'], ['xhigh', '超高档'], ['custom', 'custom']])('强度 %s 与快速分别显示小标签', (effort, label) => {
  render(<WorkerIdentity workers={fixtureView().workers} job={fixtureJob('one', { effort, fast: true })} />);
  expect(screen.getByText(label).className).toContain('chip');
  expect(screen.getByText('快速').className).toContain('chip');
  expect(screen.getByText(label).parentElement).toBe(screen.getByText('快速').parentElement);
});

test('没有强度仍显示快速标签；没有用时就不占位', () => {
  const { container } = render(<WorkerIdentity workers={fixtureView().workers} job={fixtureJob('one', { effort: '', fast: true, seconds: null })} detail="full" />);
  expect(screen.getByText('快速')).toBeTruthy();
  expect(container.querySelectorAll('.chip')).toHaveLength(1);
  expect(container.querySelector('.ident-elapsed')).toBeNull();
});

test('旧卡片 end 的用时统一放进身份的用时位置；不重复显示', () => {
  const job = fixtureJob('one');
  const { container } = render(<WorkerRow workers={fixtureView().workers} job={job} detail="full" end={<Elapsed job={job} />} />);
  expect(container.querySelector('.ident-text .ident-elapsed')?.textContent).toBe('1 分 00 秒');
  expect(container.querySelector('.ident-end')).toBeNull();
  expect(container.querySelectorAll('.ident-elapsed')).toHaveLength(1);
});

test.each(['claude', 'grok'])('Cursor 缺图时 Cu 和 %s 角标都有独立空间，紧凑图标保留', badge => {
  const workers = fixtureView().workers;
  workers['cursor-sonnet'].badge = badge;
  const { container, rerender } = render(<WorkerIdentity workers={workers} who="cursor-sonnet" detail="model" />);
  for (const img of container.querySelectorAll('img')) fireEvent.error(img);
  const main = container.querySelector('.mono-mark:not(.badge)')!;
  const corner = container.querySelector('.badge')!;
  expect(main.textContent).toBe('Cu');
  expect(corner.textContent).toBe(badge === 'claude' ? 'A' : 'G');
  expect(getComputedStyle(main.firstElementChild!).width).toBe('70%');
  expect(getComputedStyle(corner).width).toBe('45%');
  expect(getComputedStyle(corner).right).toBe('-12%');
  rerender(<WorkerIdentity workers={workers} who="cursor-sonnet" size="sm" iconOnly />);
  expect(container.querySelector('.ident-icon-only .logo-sm')).toBeTruthy();
  expect(container.querySelector('.ident-text')).toBeNull();
  expect(container.querySelector('.mono-mark:not(.badge)')?.textContent).toBe('Cu');
});

test('进展用三列布局，原始动作折行、等宽且没有省略；说话占后两列', () => {
  // jsdom 不做真实排版；这里只验证浏览器将使用的布局和折行规则。
  const sheet = style.sheet!;
  const rule = (selector: string) => Array.from(sheet.cssRules).find(r => 'selectorText' in r && r.selectorText === selector) as CSSStyleRule;
  expect(rule('.human-activities li').style.getPropertyValue('grid-template-columns')).toBe('5ch 8em minmax(0, 1fr)');
  const action = rule('.activity-action').style;
  expect(action.getPropertyValue('font-family')).toBe('var(--font-mono)');
  expect(action.getPropertyValue('white-space')).toBe('pre-wrap');
  expect(action.getPropertyValue('text-overflow')).toBe('');
  expect(rule('.activity-category, .activity-action, .activity-say').style.getPropertyValue('overflow-wrap')).toBe('anywhere');
  expect(rule('.activity-say').style.getPropertyValue('grid-column')).toBe('2 / -1');
});
