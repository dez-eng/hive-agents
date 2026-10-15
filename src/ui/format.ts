/**
 * 输出格式化：颜色、数字、宽度。
 * 颜色遵循 NO_COLOR / FORCE_COLOR / isTTY，管道里自动退化成纯文本。
 */

const COLOR_ENABLED = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

export const colorEnabled = COLOR_ENABLED;

function wrap(open: string, close: string, s: string): string {
  return COLOR_ENABLED ? `\x1b[${open}m${s}\x1b[${close}m` : s;
}

export const dim = (s: string): string => wrap('2', '22', s);
export const bold = (s: string): string => wrap('1', '22', s);
export const red = (s: string): string => wrap('31', '39', s);
export const green = (s: string): string => wrap('32', '39', s);
export const yellow = (s: string): string => wrap('33', '39', s);
export const blue = (s: string): string => wrap('34', '39', s);
export const magenta = (s: string): string => wrap('35', '39', s);
export const cyan = (s: string): string => wrap('36', '39', s);
export const gray = dim;

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** 钱。小于一个最小单位时用科学计数，免得全打印成 $0.000000 */
export function fmtUsd(n: number, digits = 6): string {
  if (!Number.isFinite(n) || n === 0) return `$${(0).toFixed(digits)}`;
  if (Math.abs(n) < 0.5 * 10 ** -digits) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(digits)}`;
}

/** 大数用 k / M 收窄，footer 只有一行 */
export function fmtTok(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtPct(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return '0%';
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtSigned(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** 终端里真实占几列（中文算 2 列） */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** 从右侧留出 width 列的注释位，不够就返回空串 */
export function padTo(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function colWidth(): number {
  const c = process.stdout.columns;
  return c && c > 20 ? c : 80;
}
