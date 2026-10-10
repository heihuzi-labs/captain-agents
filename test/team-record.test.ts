import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeam, readTeam, updateTeam, listTeams, appendMessage, readChannel, sayInTeam, pendingOwnerSays } from '../src/core/team.ts';
import type { Team } from '../src/core/team.ts';

export function sampleTeam(id = '1010-0300-pair', extra: Partial<Team> = {}): Team {
  return { id, mode: 'pair', project: 'xagents', repo: '/repo', base: 'abc', kind: '实现', title: '测试', summary: '测试小队', task: '# 题目',
    writer: { who: 'grok', effort: 'high' }, reviewer: { who: 'deepseek', effort: 'high' },
    round: 1, phase: 'write', maxRounds: 3, maxMinutes: 60, state: 'running', created: new Date().toISOString(), ...extra };
}
test('小队记录：登记、锁里改、列出；频道追加编号递增；负责人说话把主人的话记为已处理', async t => {
  const old = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = await mkdtemp(join(tmpdir(), 'xa-team-'));
  t.after(() => { if (old === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = old; });
  await createTeam(sampleTeam());
  await assert.rejects(createTeam(sampleTeam()), /已存在/);
  await updateTeam('1010-0300-pair', t => { t.round = 2; });
  assert.equal((await readTeam('1010-0300-pair')).round, 2);
  await assert.rejects(updateTeam('nope', () => {}), /找不到小队/);
  assert.deepEqual((await listTeams()).map(t => t.id), ['1010-0300-pair']);
  await appendMessage('1010-0300-pair', { round: 1, from: 'platform', kind: 'event', text: '开队' });
  await sayInTeam('1010-0300-pair', '主人的话', 'owner');
  assert.equal(pendingOwnerSays(await readChannel('1010-0300-pair')).length, 1);
  await assert.rejects(sayInTeam('1010-0300-pair', '  ', 'lead'), /不能是空的/);
  const m = await sayInTeam('1010-0300-pair', '负责人回话', 'lead');
  const list = await readChannel('1010-0300-pair');
  assert.deepEqual(list.map(x => x.id), [1, 2, 3]); assert.equal(m.round, 2);
  assert.equal(pendingOwnerSays(list).length, 0);
  await updateTeam('1010-0300-pair', t => { t.state = 'ended'; });
  await assert.rejects(sayInTeam('1010-0300-pair', '晚了', 'owner'), /收场/);
});
