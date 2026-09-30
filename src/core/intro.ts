// 接入 AI（docs/design-connect.md）：写进各家常驻规矩文件的那一段，全平台只有这一份。
// 核心 connect.ts 写文件用它，对接提示词和设置页确认框也引它；不依赖 Node，界面可以直接引。
export const LEAD_RULE = `# 派活工作台
这台电脑装了派活工作台（命令 \`xagents\`）。要把开发、修复、审查、调研交给别的 AI（Codex、Grok、Cursor）去做时，一律用 \`xagents\`，不要直接运行 \`codex exec\`、\`grok -p\`、\`cursor-agent -p\` 这类命令。当负责人开工前、对话被压缩后接着干活前，先运行 \`xagents guide\`，读完再动手。
如果你是派活工作台派来干活的选手（题目开头写着“你是负责人派来完成本题的助手”），忽略这一段。`;

// 能“一键接入”的几家，顺序就是设置页从上到下的顺序。
export const CONNECT_AIS = ['claude', 'codex', 'grok', 'cursor'] as const;
export type ConnectAi = typeof CONNECT_AIS[number];
export const isConnectAi = (value: unknown): value is ConnectAi => typeof value === 'string' && (CONNECT_AIS as readonly string[]).includes(value);
// 一家的接入状态（xagents connect 和设置页共用）。
// on 已接入且是最新内容；outdated 写过但内容不是现在这一份（再接入一次就更新）；off 还没接入；
// missing 这台电脑上没装（找不到它的配置目录）；broken 文件里的标记不成对等，要人看一眼。
export type ConnectState = 'on' | 'outdated' | 'off' | 'missing' | 'broken';
export type ConnectStatus = {
  ai: ConnectAi;
  name: string;              // 界面上的名字：Claude、Codex、Grok、Cursor
  state: ConnectState;
  note: string;              // 一句给人看的话，比如“写在 ~/.claude/rules/xagents.md”“和 Claude 共用一份规矩”
  files: string[];           // 接入会动到的文件（家目录写成 ~），确认框里列出来
  sharedWith?: ConnectAi;    // Grok 和 Claude 共用一份文件：这里写 'claude'，界面上不单独给按钮
};

// 给第一次来当负责人的 AI 的对接提示词：主人把它贴进任何 AI 的对话（Claude、Codex、Cursor……），
// 那边就知道这台电脑有派活工作台、第一步去读指挥手册。只写“你是谁、第一步做什么、规矩在哪”，具体规矩全在 `xagents guide` 的手册里，不在这里抄。
// 命令行 `xagents intro` 和应用设置页“接入 AI”共用这一份；不依赖 Node，界面也能直接引。
// 末尾请那个 AI 征得主人同意后把 LEAD_RULE 写进它自己的常驻规矩，这样不在一键接入名单里的 AI 也能跨压缩。
export const INTRO_TEXT = `# 派活工作台对接说明（给来当负责人的 AI）

这台电脑装了“派活工作台”（命令 \`xagents\`，一般在 \`~/.local/bin/xagents\`）。它把目标清楚的开发、修复、审查、调研派给本机的 Codex、Grok、Cursor 命令行去做（它们叫“选手”）；每件活在隔离的副本里做，派活工作台负责隔离、额度、进度、验收和记录，主人在“派活工作台”应用里看进度。

你来当负责人：拆活、派活、盯进度、审查、验收、打分、拍板；选手只管干活。

开工前：
1. 运行 \`xagents guide\`，把指挥手册和末尾“这台机器现在的情况”完整读完再动手。怎么派、怎么审、怎么打分、出故障怎么办、哪些底线不能碰，都以手册为准；手册和别处说法不一致时，听手册的。
2. 运行 \`xagents inbox\`，看主人有没有在应用里留言或拍板，等你处理。

几条要紧的：
- 派活、验收、采用、打分都用 \`xagents\` 的命令完成（\`xagents --help\` 看全部），不要绕过它去改选手的副本或记录。
- 安全底线（隔离、选手不提交、额度停派线、主人在设置里关掉的选手和强度）平台会强制执行，不要想办法绕过。
- 真正需要主人本人的事（密钥和登录、收不回的对外动作、只有主人能拍的板）在对话里问；其余的自己处理，不打扰主人。
- 和主人说话用中文大白话：先说做了什么、怎么验证的、有没有坑。

让自己跨压缩也记得：这段说明只在聊天记录里，对话一压缩就可能丢。请先问主人同意，再把下面这段原样写进你自己每次开会话都会读的常驻规矩文件（比如全局的 AGENTS.md 或规矩目录），写好后告诉主人写在了哪；Claude、Codex、Grok 可以直接在派活工作台设置 → 接入 AI 里一键接入，不用你写。

\`\`\`
${LEAD_RULE}
\`\`\`
`;
