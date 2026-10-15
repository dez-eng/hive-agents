/**
 * node:sqlite 在 Node 22/24 上还挂着 ExperimentalWarning。
 * 账本要用它，但不该让用户每次启动都看见一行警告 —— 在加载它之前
 * 把这个特定警告过滤掉。其它警告照常放行。
 *
 * 必须在【任何模块加载 node:sqlite 之前】调用，所以 ledger 用
 * createRequire 延迟加载（见 ledger.ts）。
 */
let installed = false;

export function silenceSqliteWarning(): void {
  if (installed) return;
  installed = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
    const first = rest[0];
    const type = typeof first === 'string'
      ? first
      : (first as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
