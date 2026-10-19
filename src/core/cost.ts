/**
 * 峰谷时段与价格表。价格单位：美元 / 百万 token。
 *
 * 沿用阶段 6.7 的价表，一行没改 —— 账本要能跟旧数据对得上。
 */
export type Band = 'peak' | 'off';

export interface BandPrice {
  peak: number;
  off: number;
}

export interface ModelPrice {
  in_hit: BandPrice;
  in_miss: BandPrice;
  out: BandPrice;
}

export const PRICE: Record<string, ModelPrice> = {
  'deepseek-flash': {
    in_hit: { peak: 0.006, off: 0.003 },
    in_miss: { peak: 0.3, off: 0.15 },
    out: { peak: 1.2, off: 0.6 },
  },
  'deepseek-v4-pro': {
    in_hit: { peak: 0.044, off: 0.022 },
    in_miss: { peak: 1.32, off: 0.66 },
    out: { peak: 3.96, off: 1.98 },
  },
};

export const FALLBACK_MODEL = 'deepseek-flash';

/** 峰时 = UTC 周一~周五 01:00-04:00 / 06:00-10:00，其余谷时 */
export function bandNow(at: Date = new Date()): Band {
  const dow = at.getUTCDay();
  if (dow === 0 || dow === 6) return 'off';
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 'peak' : 'off';
}

/**
 * v4 M4.2：价格覆盖（来自 `HIVE_PRICE_JSON`）。
 *
 * 只覆盖JSON 里给出的模型，其余仍走内置表。放在模块级而不是每轮解析：
 * 计价发生在每一次计量回调里，不能每轮 JSON.parse。
 */
let overlay: Record<string, ModelPrice> | null = null;

function isBandPrice(v: unknown): v is BandPrice {
  if (!v || typeof v !== 'object') return false;
  const b = v as BandPrice;
  return typeof b.peak === 'number' && typeof b.off === 'number' && b.peak >= 0 && b.off >= 0;
}

/**
 * 纯函数：解析并校验价格覆盖。写坏时返回人话原因，调用方决定提示方式。
 * 宁可退回内置价，也不能因为一个手滑的 JSON 把账算成 0。
 */
export function parsePriceOverlay(
  raw: string | undefined,
): { ok: true; value: Record<string, ModelPrice> } | { ok: false; reason: string } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '顶层必须是对象：{ "模型名": { in_hit, in_miss, out } }' };
  }
  const out: Record<string, ModelPrice> = {};
  for (const [model, v] of Object.entries(parsed)) {
    const m = v as Record<string, unknown>;
    if (!isBandPrice(m['in_hit']) || !isBandPrice(m['in_miss']) || !isBandPrice(m['out'])) {
      return { ok: false, reason: `${model} 需要 in_hit / in_miss / out 三项，每项含非负的 peak 与 off` };
    }
    out[model] = { in_hit: m['in_hit'], in_miss: m['in_miss'], out: m['out'] };
  }
  return { ok: true, value: out };
}

/** 设置覆盖（传 null 清空 —— 测试与配置重载用） */
export function setPriceOverlay(v: Record<string, ModelPrice> | null): void {
  overlay = v;
}

/** 这个模型的价格来自哪：env 覆盖 / 内置表 / 回落到默认模型 */
export function priceSource(model: string): 'env' | 'builtin' | 'fallback' {
  if (overlay?.[model]) return 'env';
  return PRICE[model] ? 'builtin' : 'fallback';
}

export function priceFor(model: string): ModelPrice {
  return overlay?.[model] ?? PRICE[model] ?? PRICE[FALLBACK_MODEL]!;
}

export interface InputUsage {
  /** 未命中的输入 token —— 按全价计费的那部分 */
  miss: number;
  /** 命中缓存的输入 token —— 便宜价 */
  hit: number;
}

export function inputCostOf(u: InputUsage, model: string, band: Band): number {
  const p = priceFor(model);
  return (u.miss / 1e6) * p.in_miss[band] + (u.hit / 1e6) * p.in_hit[band];
}

export function outputCostOf(tokens: number, model: string, band: Band): number {
  return (tokens / 1e6) * priceFor(model).out[band];
}

export function costOf(
  u: InputUsage & { out: number },
  model: string,
  band: Band,
): number {
  return inputCostOf(u, model, band) + outputCostOf(u.out, model, band);
}

/** 把思考 token 折算成钱 —— 它按输出价计费，一分钱不便宜 */
export function reasonCostOf(reasonTokens: number, model: string, band: Band): number {
  return outputCostOf(reasonTokens, model, band);
}
