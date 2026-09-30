// Electron 会给核心错误加上通道前缀，界面只显示给人的原因。
export function errorReason(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/\s+/g, ' ')
    : '请稍后再试。';
}
