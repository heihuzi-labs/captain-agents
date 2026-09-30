import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readJson, writeJson } from '../../src/core/fsx.ts';

export type Bounds = { x?: number; y?: number; width: number; height: number };
export async function loadBounds(userData: string): Promise<Bounds> {
  const defaults = { width: 1120, height: 760 };
  try {
    const value = await readJson<Partial<Bounds>>(join(userData, 'window.json'));
    if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height) ||
      value.width! < 900 || value.height! < 600 || value.width! > 10000 || value.height! > 10000) return defaults;
    return { width: value.width!, height: value.height!,
      ...(Number.isInteger(value.x) && Number.isInteger(value.y) ? { x: value.x, y: value.y } : {}) };
  } catch { return defaults; }
}
export async function saveBounds(userData: string, bounds: Bounds) {
  await mkdir(userData, { recursive: true });
  await writeJson(join(userData, 'window.json'), bounds);
}
