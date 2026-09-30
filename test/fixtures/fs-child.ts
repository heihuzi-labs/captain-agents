import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const [mode, dir] = process.argv.slice(2);
if (mode === 'partial') {
  const original = fs.open;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const fd = await original(...args);
    fd.writeFile = async () => {
      await fd.write('{"broken":');
      console.log('已写半份');
      await new Promise(() => setInterval(() => {}, 1000));
    };
    return fd;
  };
  syncBuiltinESMExports();
  const { writeAtomic } = await import('../../src/core/fsx.ts');
  await writeAtomic(join(dir, 'value.json'), '{"complete":true}');
} else {
  const { withLock, readJson, writeJson } = await import('../../src/core/fsx.ts');
  await withLock(dir, async () => {
    if (mode === 'hold') {
      console.log('已持锁');
      await new Promise(() => setInterval(() => {}, 1000));
    } else {
      const value = await readJson(join(dir, 'value.json'));
      await new Promise(resolve => setTimeout(resolve, 30));
      await writeJson(join(dir, 'value.json'), value + 1);
    }
  });
}
