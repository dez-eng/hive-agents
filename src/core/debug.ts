/**
 * 调试日志（v4 M4.3）。
 *
 * 默认关闭 = 零成本：不拼字符串、不写 stderr。`HIVE_DEBUG=1` 才输出。
 * 格式固定 `[hive <ISO> <scope>] message {json}`，方便 grep 和贴给模型看。
 *
 * 只写 stderr：stdout 是给用户/脚本的结果，不能被调试噪音污染。
 */

export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['HIVE_DEBUG'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function safeJson(v: unknown): string {
  if (v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function debug(scope: string, message: string, data?: unknown): void {
  if (!debugEnabled()) return;
  const extra = data === undefined ? '' : ` ${safeJson(data)}`;
  process.stderr.write(`[hive ${new Date().toISOString()} ${scope}] ${message}${extra}\n`);
}
