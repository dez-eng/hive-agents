/**
 * 进程内任务注册表 —— `/tasks` 的数据源（v4 M4.1）。
 *
 * 为什么要有它：`handoffs` 是**落库的痕迹**（跨进程、可回溯），但它只知道
 * 「跑完/失败」；正在跑、刚发起、被预算挡下的任务在落库之前没有地方看。
 * `/tasks` 补的是**当下**这一层：本进程发起过哪些子任务、各自什么状态。
 *
 * 内存表 + 有界（最多 200 条），不落盘；跨进程与历史用 `/handoffs`。
 */
import type { HandoffResult } from './handoff.js';
import type { AgentId } from './modules.js';

export type TaskState = 'running' | 'done' | 'failed' | 'budget' | 'denied';

export interface TaskInfo {
  taskId: string;
  from: AgentId;
  to: AgentId;
  goal: string;
  budgetTokens: number;
  state: TaskState;
  startedAt: number;
  endedAt?: number;
  tokens: number;
  costUsd: number;
  notes?: string;
}

export class TaskRegistry {
  private readonly map = new Map<string, TaskInfo>();
  private readonly order: string[] = [];
  private readonly max: number;

  constructor(max = 200) {
    this.max = max;
  }

  /** 发起一个子任务。同一 taskId 再发起（续跑）只更新，不重复占位。 */
  start(info: {
    taskId: string;
    from: AgentId;
    to: AgentId;
    goal: string;
    budgetTokens: number;
  }): TaskInfo {
    const t: TaskInfo = {
      ...info,
      state: 'running',
      startedAt: Date.now(),
      tokens: 0,
      costUsd: 0,
    };
    const exists = this.map.has(t.taskId);
    this.map.set(t.taskId, t);
    if (!exists) {
      this.order.push(t.taskId);
      if (this.order.length > this.max) {
        const gone = this.order.shift();
        if (gone) this.map.delete(gone);
      }
    }
    return t;
  }

  /** 正常收尾：按结果标记完成 / 熔断 / 拒绝 / 失败 */
  finish(taskId: string, res: HandoffResult): TaskInfo | undefined {
    const t = this.map.get(taskId);
    if (!t) return undefined;
    t.endedAt = Date.now();
    t.tokens = res.tokens;
    t.costUsd = res.costUsd;
    if (res.notes) t.notes = res.notes;
    if (res.budgetHit) t.state = 'budget';
    else if (res.ok) t.state = 'done';
    else if ((res.notes ?? '').includes('预留失败') || (res.notes ?? '').includes('无权')) t.state = 'denied';
    else t.state = 'failed';
    return t;
  }

  /** 异常收尾（runner 抛出执行核没兜住的错） */
  fail(taskId: string, reason: string): void {
    const t = this.map.get(taskId);
    if (!t) return;
    t.state = 'failed';
    t.endedAt = Date.now();
    t.notes = reason;
  }

  /** 新的在前；limit 默认 20 */
  list(limit = 20): TaskInfo[] {
    return this.order
      .slice(-limit)
      .reverse()
      .map((id) => this.map.get(id))
      .filter((t): t is TaskInfo => Boolean(t));
  }

  running(): TaskInfo[] {
    return this.list(this.max).filter((t) => t.state === 'running');
  }

  clear(): void {
    this.map.clear();
    this.order.length = 0;
  }
}

/** 进程级单例 —— 借调执行核与 `/tasks` 共用 */
export const TASKS = new TaskRegistry();
