/**
 * 会话运行时状态。REPL 和命令都是围绕它转的。
 *
 * v2 起模块不再是「一个 id」而是「一个栈」（见 stack.ts）：
 * 栈底 = A 的主模块，栈顶 = 当前执行者。借调结束弹一层就回到原角色。
 *
 * v3：多了一个「以某身份独立启动」的入口（`hive --as B`）——
 * 它的栈底直接是该 agent 的主模块，而不是靠压栈压出来的。
 */
import type { TokenMeter } from './meter.js';
import { AGENTS, DEFAULT_AGENT, DEFAULT_MODULE, agentOf, type AgentId } from './modules.js';
import { stackTop } from './stack.js';

export interface ReplState {
  /** 当前 thread_id —— 换会话就是换它，等于冷缓存 */
  thread: string;
  /** 模块栈。栈底是 A 的主模块，栈顶是当前执行者（v2 §2 栈式恢复） */
  stack: string[];
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
    stack: [DEFAULT_MODULE],
    tail: true,
    footer: true,
    lastTurn: null,
    lastSent: '',
  };
}

/**
 * v3：以某个身份独立启动（`hive --as B`）的会话状态。
 * 栈底直接放该 agent 的主模块 —— 与借调（压栈）不同，这是「我本来就是这个角色」。
 */
export function newReplStateFor(thread: string, as: AgentId): ReplState {
  const st = newReplState(thread);
  st.stack = [AGENTS[as].home];
  return st;
}

/** 当前模块 id = 栈顶。prompt 尾部挂它、执行层按它收权 */
export function currentModuleId(state: ReplState): string {
  return stackTop(state.stack) || DEFAULT_MODULE;
}

/** 当前身份 = 栈顶模块的归属。借调中就是被借调的那个 agent */
export function currentAgent(state: ReplState): AgentId {
  return agentOf(currentModuleId(state)) ?? DEFAULT_AGENT;
}
