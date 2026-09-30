import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { toolRoot } from './paths.ts';
import type { Project } from './project.ts';

export async function prompt(project: Project, file: string) {
  const common = await readFile(join(toolRoot, 'rules.md'), 'utf8');
  const extra = project.rules ? await readFile(resolve(project.repo, project.rules), 'utf8') : '';
  const task = await readFile(file, 'utf8');
  return [common.trim(), extra.trim(), task.trim()].filter(Boolean).join('\n\n---\n\n') + '\n';
}
