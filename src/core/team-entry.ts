import { loadConfiguredRoster } from './settings.ts';
import { runTeam } from './team-engine.ts';

const id = process.argv[2];
if (!id) {
  console.error('缺少队号。请由开队流程启动推进进程。');
  process.exit(1);
}
await loadConfiguredRoster();
await runTeam(id);
