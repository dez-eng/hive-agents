/**
 * 错误识别与分类（v4 M4.3）。
 *
 * 目标不是「把所有错误都翻译一遍」，而是让用户一眼知道**下一步该做什么**：
 * 是换 key、等一会儿、加预算，还是这条命令本身写错了。
 *
 * 纯函数、零网络、零副作用 —— 分类本身不花钱，也不改会话状态。
 */
import { isBudgetExceeded } from './budget.js';

export type ErrorKind =
  | 'abort'
  | 'auth'
  | 'rate'
  | 'timeout'
  | 'network'
  | 'budget'
  | 'policy'
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  /** 给人看的短标题 */
  title: string;
  /** 原始错误文本（附在标题后） */
  message: string;
  /** 下一步做什么；没有就不显示 */
  hint?: string;
  /** 原样重试有没有意义 */
  retryable: boolean;
}

/**
 * 是不是「用户主动中止」。
 * LangGraph / fetch / undici 各自包装不同：name、code、message、cause 都要看。
 */
export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  if (typeof err.message === 'string' && /\babort(ed)?\b/i.test(err.message)) return true;
  if (err.cause && err.cause !== e) return isAbortError(err.cause);
  return false;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** 从常见包装里取 HTTP 状态码 */
function statusOf(e: unknown): number | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const err = e as Record<string, unknown>;
  for (const key of ['status', 'statusCode']) {
    const v = err[key];
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
  }
  const response = err['response'];
  if (response && typeof response === 'object') {
    const v = (response as Record<string, unknown>)['status'];
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
  }
  // 兜底：错误文本里带 401 / 429 这类码
  const m = messageOf(e).match(/\b(401|403|408|429|500|502|503|504)\b/);
  return m ? Number(m[1]) : undefined;
}

function networkCodeOf(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const code = (e as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : undefined;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

export function classifyError(e: unknown): ClassifiedError {
  const message = messageOf(e);
  const status = statusOf(e);
  const code = networkCodeOf(e);

  if (isAbortError(e)) {
    return {
      kind: 'abort',
      title: '本轮已中止',
      message: '用户按了 Ctrl+C',
      hint: '会话还在，可以继续问；想从头开始就 /new。',
      retryable: true,
    };
  }

  if (isBudgetExceeded(e)) {
    return {
      kind: 'budget',
      title: '预算熔断',
      message,
      hint: '说「继续」会接着跑；或调大 HIVE_TURN_BUDGET / 子任务 budgetTokens。',
      retryable: true,
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      title: '鉴权失败',
      message,
      hint: '检查 DEEPSEEK_API_KEY 是否正确、是否过期；自建端点还要看 DEEPSEEK_BASE_URL。',
      retryable: false,
    };
  }

  if (status === 429) {
    return {
      kind: 'rate',
      title: '被限流',
      message,
      hint: '等几十秒再试；持续限流就降低并发（别同时派太多子任务）。',
      retryable: true,
    };
  }

  if (status === 408 || status === 504 || code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return {
      kind: 'timeout',
      title: '请求超时',
      message,
      hint: '检查网络或代理；长任务可以拆小一点再跑。',
      retryable: true,
    };
  }

  if (code && NETWORK_CODES.has(code)) {
    return {
      kind: 'network',
      title: '网络错误',
      message: `连接失败（${code}）`,
      hint: '检查网络 / 代理 / DNS；自建端点先确认服务在跑。',
      retryable: true,
    };
  }
  if (/fetch failed|network|socket hang up|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return {
      kind: 'network',
      title: '网络错误',
      message,
      hint: '检查网络 / 代理 / DNS；自建端点先确认服务在跑。',
      retryable: true,
    };
  }

  if (/被策略拒绝|policy|不在 allowServers|没有权限|没装能力/i.test(message)) {
    return {
      kind: 'policy',
      title: '被策略拒绝',
      message,
      hint: '看 /policy 与 /policy log；要放开就改 .hive/policy.json 或对应环境变量。',
      retryable: false,
    };
  }

  return {
    kind: 'unknown',
    title: '调用失败',
    message,
    hint: '会话还在，可以继续问；重复出现就看 /doctor 或用 HIVE_DEBUG=1 看细节。',
    retryable: false,
  };
}
