import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { parseBlocks, RichText } from '../../app/renderer/ui/RichText.tsx';

afterEach(cleanup);
const report = '已完成，只新增 `test/ids.test.ts`，未改 `src`。\n- 第 5 行起覆盖 `stem` 的路径。\n- **验证**：7 项全部通过。\n\n## 没做的\n1. 全量验收\n2. 冒烟测试\n\n```\nnode --test test/ids.test.ts\n<script>alert(1)</script>\n```\n<b>不是加粗</b> [链接](https://example.com)';

test('分块：段落、列表、标题、有序列表、代码块；没收尾的代码块到末尾', () => {
  expect(parseBlocks(report).map(b => b.type)).toEqual(['p', 'ul', 'h', 'ol', 'code', 'p']);
  expect(parseBlocks('```\na\nb').at(-1)).toEqual({ type: 'code', text: 'a\nb' });
  expect(parseBlocks('- 一\n  续行\n- 二')[0]).toEqual({ type: 'ul', items: [{ text: '一\n续行', depth: 0 }, { text: '二', depth: 0 }] });
  expect(parseBlocks('3. 三\n4、四')[0]).toEqual({ type: 'ol', items: [{ text: '三', n: 3 }, { text: '四', n: 4 }] });
});
test('排版：行内代码、加粗、列表、标题、代码块；尖括号和链接写法只是文字，不变成标签', () => {
  const { container } = render(<RichText text={report} decorate={s => s.split('验证').flatMap((part, i) => i ? [<mark key={i}>验证</mark>, part] : [part])} />);
  expect([...container.querySelectorAll('p > span > code, li > code')].map(c => c.textContent)).toEqual(['test/ids.test.ts', 'src', 'stem']);
  expect(container.querySelectorAll('ul > li').length).toBe(2);
  expect(container.querySelector('strong mark')?.textContent).toBe('验证');
  expect(container.querySelector('.rich-h')?.textContent).toBe('没做的');
  expect([...container.querySelectorAll('ol > li')].map(li => (li as HTMLLIElement).value)).toEqual([1, 2]);
  expect(container.querySelector('pre code')?.textContent).toBe('node --test test/ids.test.ts\n<script>alert(1)</script>');
  expect(container.querySelector('script, b, a')).toBeNull();
  expect(container.textContent).toContain('<b>不是加粗</b> [链接](https://example.com)');
  // 反引号和星号本身不再显示
  expect(container.querySelector('p')?.textContent).toBe('已完成，只新增 test/ids.test.ts，未改 src。');
});
