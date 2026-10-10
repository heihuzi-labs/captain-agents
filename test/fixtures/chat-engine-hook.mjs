// 测试专用：只替换群聊引擎，不启动任何真实选手或推进进程。
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, next) {
    if (!url.endsWith('/src/core/chat-engine.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true, source: `
      import { readChat } from './chat.ts';
      export async function wakeChat(id) {
        (globalThis.__chatWakes ??= []).push(id);
        if (globalThis.__chatWakeError) throw new Error(globalThis.__chatWakeError);
        return readChat(id);
      }
      export const reconcileChat = async chat => {
        if (process.env.XAGENTS_CHAT_TEST_READY) process.stdout.write('等待就绪\\n');
        return chat;
      };
      export const stopChat = async id => readChat(id);
      export const closeChat = async id => readChat(id);
      export const cleanChat = async id => readChat(id);
    ` };
  },
});
