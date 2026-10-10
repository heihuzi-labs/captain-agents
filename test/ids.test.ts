import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stem, stamp } from '../src/core/ids.ts';

test('stem：只取文件名、去掉最后一个扩展名，保留大小写、数字和连字符', () => {
  for (const [file, expected] of [
    ['/some.directory/nested/My-Task42.md', 'My-Task42'],
    ['relative/path/task', 'task'],
    ['archive.tar.gz', 'archive-tar'],
    ['A--B.txt', 'A--B'],
    ['.hidden', 'hidden'],
  ]) assert.equal(stem(file), expected, file);
});

test('stem：连续非法字符替换成一个连字符，并清理首尾连字符', () => {
  for (const [file, expected] of [
    ['fix__  !!me.md', 'fix-me'],
    ['---hello world---.md', 'hello-world'],
    ['中文Task_编号42.md', 'Task-42'],
    ['a😀b.md', 'a-b'],
  ]) assert.equal(stem(file), expected, file);
});

test('stem：全中文文件名回退为 task', () => {
  assert.equal(stem('中文.md'), 'task');
  assert.equal(stem('中文'), 'task');
});

test('stem：空文件名或净化后没有可用字符时回退到 task', () => {
  for (const file of ['', '___!!!.txt', '---.md', '/', '.']) {
    assert.equal(stem(file), 'task', JSON.stringify(file));
  }
});

test('stamp：使用上海时区，月份、日期、小时和分钟补零，忽略秒和毫秒', () => {
  assert.equal(stamp(new Date('2026-01-02T01:04:59.999Z')), '0102-0904');
  assert.equal(stamp(new Date('2026-07-08T01:04:00.000Z')), '0708-0904');
});

test('stamp：上海午夜用 00 点，正确处理跨日、跨月、跨年和闰日', () => {
  for (const [iso, expected] of [
    ['2026-09-28T15:59:59.999Z', '0928-2359'],
    ['2026-09-28T16:00:00.000Z', '0929-0000'],
    ['2026-01-31T16:01:00.000Z', '0201-0001'],
    ['2026-12-31T16:00:00.000Z', '0101-0000'],
    ['2024-02-28T16:00:00.000Z', '0229-0000'],
    ['2024-02-29T16:00:00.000Z', '0301-0000'],
  ]) assert.equal(stamp(new Date(iso)), expected, iso);
});

test('stamp：省略日期时使用当前时间', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T16:05:00.000Z') });
  assert.equal(stamp(), '1010-0005');
});

test('stamp：无效日期抛出 RangeError', () => {
  assert.throws(() => stamp(new Date(NaN)), RangeError);
});
