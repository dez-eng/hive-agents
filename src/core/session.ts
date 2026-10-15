/**
 * 会话运行时状态。REPL 和命令都是围绕它转的。
 */
import type { TokenMeter } from './meter.js';
import { DEFAULT_MODULE } from './modules.js';

export interface ReplState {
  /** 当前 thread_id —— 换会话就是换它，等于冷缓存 */
  thread: string;
  /** 当前模块 id */
  moduleId: string;
  /** 尾部角色片开关。关掉后跨模块切换同字节，用于 A/B */
  tail: boolean;
  /** 底部状态行开关 */
  footer: boolean;
  /** 最近一轮的计量，footer 用 */
  lastTurn: TokenMeter | null;
  /** 最近一轮发的原文，/cost 里做对照 */
  lastSent: string;
}

export function newReplState(thread: string): ReplState {
  return {
    thread,
    moduleId: DEFAULT_MODULE,
    tail: true,
    footer: true,
    lastTurn: null,
    lastSent: '',
  };
}
