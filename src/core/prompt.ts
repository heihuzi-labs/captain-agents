import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { toolRoot } from './paths.ts';
import type { Project } from './project.ts';

export async function prompt(project: Project, file: string, network = false) {
  const common = await readFile(join(toolRoot, 'rules.md'), 'utf8');
  const extra = project.rules ? await readFile(resolve(project.repo, project.rules), 'utf8') : '';
  const task = await readFile(file, 'utf8');
  const notice = network === true ? '这件活可以联网。只为完成本题联网，不要把仓库内容、报告或任何文件内容发到外面。' : '';
  return [common.trim(), notice, extra.trim(), task.trim()].filter(Boolean).join('\n\n---\n\n') + '\n';
}
