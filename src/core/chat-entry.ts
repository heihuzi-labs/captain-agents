import { loadConfiguredRoster } from './settings.ts';
import { runChat } from './chat-engine.ts';

const id = process.argv[2];
if (!id) {
  console.error('缺少群号。请由群聊流程启动推进进程。');
  process.exit(1);
}
await loadConfiguredRoster();
await runChat(id);
