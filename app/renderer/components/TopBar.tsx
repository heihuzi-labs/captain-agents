import type { View } from '../../../src/core/view-types.ts';
import type { Page } from '../lib/board.ts';
import { Segmented, StatusCluster } from '../ui/index.ts';
import { unread } from '../lib/chat.ts';
import type { SegmentedItem } from '../ui/index.ts';
import { UpdatePill } from './Update.tsx';

const pages: (SegmentedItem & { id: Page })[] = [
  { id: 'board', label: '看板', title: '看板（⌘1）' },
  { id: 'collab', label: '协作', title: '协作（⌘2）' },
  { id: 'history', label: '历史', title: '历史（⌘3）' },
  { id: 'stats', label: '表现', title: '各家表现（⌘4）' },
];
export const PAGE_KEYS: Page[] = pages.map(p => p.id);
// 顶栏：左边分页切换，右边状态块和设置；件数只在看板列头显示。规范见 docs/ui-spec.md 第 11 节。
export function TopBar({ view, page, go, openSettings }: { view: View; page: Page; go: (page: Page) => void; openSettings: () => void }) {
  return <header className="top">
    {/* 群里有你还没看过的话时，“协作”上一个灰色小点（docs/ui-spec.md 第 17 节）。 */}
    <Segmented label="页面" items={pages.map(p => p.id === 'collab' && page !== 'collab' && view.chats.some(c => c.state === 'open' && unread(c)) ? { ...p, dot: true, dotLabel: '群里有新消息' } : p)} value={page} onChange={id => go(id as Page)} />
    {/* 有新版本时才出现的小提示（第 18 节）；它在额度圆环左边，圆环那一块跟着它一起靠右。 */}
    <UpdatePill />
    <StatusCluster quota={view.quota} selfcheck={view.selfcheck} stop={view.settings.limits?.quotaStop} onOpen={() => go('stats')} />
    {/* 设置入口：顶栏最右，一眼可见；菜单栏小图标和 ⌘, 仍然可用。原创线条“三根滑杆”图标（齿轮画小了像太阳，容易当成深浅色切换）。 */}
    <button className="top-icon" aria-label="设置" title="设置（⌘,）" onClick={openSettings}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h8.5M14.5 5.5H17M3 10h2.5M8.5 10H17M3 14.5h7M13 14.5h4" /><circle cx="13" cy="5.5" r="1.6" /><circle cx="7" cy="10" r="1.6" /><circle cx="11.5" cy="14.5" r="1.6" /></svg></button>
  </header>;
}
