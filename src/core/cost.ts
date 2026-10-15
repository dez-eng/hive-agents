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

export function priceFor(model: string): ModelPrice {
  return PRICE[model] ?? PRICE[FALLBACK_MODEL]!;
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
