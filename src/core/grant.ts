/**
 * 授权令牌 —— v2 的钥匙，拦在**执行层**而不是提示词里。
 *
 * 规矩，全部落在纯函数上（好测、也便于 M2 的 delegate 直接复用）：
 *   1. 只有主控 A 能签发
 *   2. 令牌写明「谁可以借调谁」（mayCall）
 *   3. 有预算上限，花超了就不批
 *   4. 会过期 —— 借调是短期行为，不该永久有效
 *
 * 这里刻意不碰 IO：落库在 ledger.ts，真正的闸门在 M2 的 delegate 入口。
 */
import type { AgentId } from './modules.js';
import { AGENTS, mayDelegate } from './modules.js';

export interface Token {
  id: string;
  /** 签发者：只有 A 能签 */
  issuedBy: AgentId;
  /** 持有人 */
  to: AgentId;
  /** 允许借调的目标 */
  mayCall: AgentId[];
  /** 预算上限（token 数） */
  budgetTokens: number;
  /** 签发时刻 epoch ms */
  issuedAt: number;
  /** 过期时刻 epoch ms */
  expiresAt: number;
  /** 已花掉的 token 数 */
  spent: number;
  note?: string;
}

/** 校验结论。失败必须带原因 —— 免得日志里只看到「不行」 */
export type Verdict = { ok: true } | { ok: false; reason: string };

/** 默认有效期：30 分钟。够跑一个子任务，不足以忘记它的存在 */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface IssueOptions {
  /** 只有 A 能签；传别的会被拒 */
  issuedBy?: AgentId;
  budgetTokens: number;
  ttlMs?: number;
  note?: string;
  now?: number;
}

export type IssueResult = { ok: true; token: Token } | { ok: false; reason: string };

/**
 * 签发令牌。`mayCall` 不是参数 —— 它从身份表取，默认自动签发走的就是这条路：
 * 想收紧就去改 AGENTS 表（或手动 /grant 指定），而不是在调用点上临时商量。
 */
export function issueToken(to: AgentId, opts: IssueOptions): IssueResult {
  const by = opts.issuedBy ?? 'A';
  if (by !== 'A') return { ok: false, reason: `只有 A 能签令牌，${by} 不行` };
  if (to === 'A') return { ok: false, reason: 'A 不需要向自己要令牌' };
  if (!Number.isFinite(opts.budgetTokens) || opts.budgetTokens < 0) {
    return { ok: false, reason: `预算不合法：${opts.budgetTokens}` };
  }
  const now = opts.now ?? Date.now();
  const holder = AGENTS[to];
  return {
    ok: true,
    token: {
      id: `${to}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      issuedBy: by,
      to,
      mayCall: [...holder.mayCall],
      budgetTokens: Math.trunc(opts.budgetTokens),
      issuedAt: now,
      expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
      spent: 0,
      ...(opts.note ? { note: opts.note } : {}),
    },
  };
}

export function isExpired(t: Token, now: number): boolean {
  return now > t.expiresAt;
}

export function remaining(t: Token): number {
  return Math.max(t.budgetTokens - t.spent, 0);
}

/** 记一笔花费。不可变 —— 省得谁改了令牌大家都不知道 */
export function debitToken(t: Token, tokens: number): Token {
  return { ...t, spent: t.spent + Math.max(Math.trunc(tokens), 0) };
}

/** 这张令牌能不能借调 target，还剩多少预算 */
export function checkToken(t: Token, target: AgentId, needTokens: number, now: number): Verdict {
  if (!t.mayCall.includes(target)) {
    return { ok: false, reason: `令牌 ${t.id} 不含 ${target}（mayCall: ${t.mayCall.join('/') || '空'}）` };
  }
  if (isExpired(t, now)) {
    return { ok: false, reason: `令牌 ${t.id} 已于 ${new Date(t.expiresAt).toISOString()} 过期` };
  }
  if (needTokens > remaining(t)) {
    return {
      ok: false,
      reason: `超预算：剩余 ${remaining(t)} + 需要 ${needTokens} 超过上限 ${t.budgetTokens}`,
    };
  }
  return { ok: true };
}

export interface AuthorizeRequest {
  /** 发起借调的身份（栈顶那个） */
  from: AgentId;
  /** 被借调的目标 */
  to: AgentId;
  /** 手上持有的令牌，没有就传 null */
  token: Token | null;
  /** 这次子任务申请多少 token */
  needTokens: number;
  now: number;
}

/**
 * 执行层总闸 —— M2 的 `delegate` 第一步就走它，过了才轮到花模型的钱。
 * 顺序刻意是：身份白名单 → 令牌归属 → 令牌内容。哪一步挡下来都要能说清。
 */
export function authorizeDelegate(req: AuthorizeRequest): Verdict {
  if (req.from === req.to) return { ok: false, reason: '不能借调自己' };
  if (!mayDelegate(req.from, req.to)) {
    return { ok: false, reason: `${req.from} 无权借调 ${req.to}（身份表 mayCall 里没有）` };
  }
  // A 是签发者，自带权限 —— §4「借调默认由 A 自行决定」，它不需要向自己领令牌。
  // 子任务的预算仍由 input.budgetTokens 在 runSubagent 里熔断，不是没有闸门。
  if (req.from === 'A') return { ok: true };
  if (!req.token) return { ok: false, reason: `${req.from} 借调 ${req.to} 需要令牌，但没有` };
  if (req.token.issuedBy !== 'A') {
    return { ok: false, reason: `令牌只能由 A 签发，这张是 ${req.token.issuedBy} 签的` };
  }
  if (req.token.to !== req.from) {
    return { ok: false, reason: `令牌 ${req.token.id} 属于 ${req.token.to}，不是 ${req.from}` };
  }
  return checkToken(req.token, req.to, req.needTokens, req.now);
}
