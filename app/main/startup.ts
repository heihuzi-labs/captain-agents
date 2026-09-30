// 窗口先可用，登记处读取错误交给页面已有的 getView 错误提示。
// 通知在首次成功读取时建立基线；某一步失败不能取消其余步骤或关闭窗口。
export async function startDesktop(steps: {
  openWindow(): Promise<void>;
  startNotifications(): Promise<void>;
  startWatching(): Promise<void>;
  refresh(): Promise<void>;
  onError(error: unknown): void;
}) {
  await steps.openWindow();
  for (const action of [steps.startNotifications, steps.startWatching, steps.refresh]) {
    try { await action(); }
    catch (error) { steps.onError(error); }
  }
}
