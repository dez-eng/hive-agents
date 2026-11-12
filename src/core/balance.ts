/**
 * 账户余额 —— 底部指标栏那个「余额」数字。
 *
 * 为什么要单独查：余额不在任何响应里，DeepSeek 只在你主动请求 `/user/balance` 时给。
 * 三条规矩：
 *   · **缓存 60s**：每轮都查等于给每轮对话加一次网络往返，还容易被限流。
 *   · **查不到就是 null**：不是 0。0 会让用户以为钱花光了，null 前端显示「—」。
 *   · **绝不影响对话**：所有错误吞掉，余额只是指标栏的一格。
 */
import { baseUrl } from './config.js';

export interface Balance {
  /** 可用余额（数字，币种见 currency） */
  amount: number;
  /** CNY / USD … */
  currency: string;
}

const TTL_MS = 60_000;

let cached: Balance | null = null;
let cachedAt = 0;
let inflight: Promise<Balance | null> | null = null;

/** 已经查到的余额；从没查到过就是 null */
export function knownBalance(): number | null {
  return cached ? cached.amount : null;
}

export function knownBalanceCurrency(): string {
  return cached?.currency ?? '';
}

/** 上次成功查询的时间（epoch ms），没查过返回 null */
export function knownBalanceAt(): number | null {
  return cachedAt || null;
}

/** 测试用：清掉缓存 */
export function resetBalanceCache(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
}

interface BalanceResp {
  is_available?: boolean;
  balance_infos?: Array<{ currency?: string; total_balance?: string }>;
}

/** 解析 `/user/balance` 的响应。导出是为了能单测 —— 币种与字符串数字都不能猜 */
export function parseBalance(raw: unknown): Balance | null {
  const r = raw as BalanceResp | null;
  const first = r?.balance_infos?.[0];
  if (!first) return null;
  const amount = Number(first.total_balance);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: (first.currency ?? '').trim() || 'CNY' };
}

/**
 * 查一次余额（走缓存）。永远 resolve，不 reject。
 * `force` 用来在窗口打开时强行刷新一次。
 */
export async function refreshBalance(force = false): Promise<Balance | null> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < TTL_MS) return cached;
  if (inflight) return inflight;

  const key = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (!key) return null;

  // 注意 baseUrl() 在没设 DEEPSEEK_BASE_URL 时返回的是**空字符串**（不是 undefined），
  // 用 `??` 兜不住 —— 实测就踩了：URL 拼成 `/user/balance`，fetch 报 ERR_INVALID_URL。
  const root = (baseUrl() || 'https://api.deepseek.com').replace(/\/+$/, '');
  inflight = (async (): Promise<Balance | null> => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 6000);
      const res = await fetch(`${root}/user/balance`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return cached;
      const parsed = parseBalance(await res.json());
      if (parsed) {
        cached = parsed;
        cachedAt = Date.now();
      }
      return cached;
    } catch {
      // 断网 / 超时 / 响应格式变了：留着上一次的数值，宁可旧也不要闪成空
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
