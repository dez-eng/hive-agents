/**
 * UI 事件通道 —— 隐私窗口右侧「思考栏」和底部指标栏的数据源。
 *
 * 为什么要有这条通道：窗口里的 hive 跑在 PTY 里，终端输出是**带 ANSI 的文本流**，
 * 思考正文、工具调用、本轮花费全糊在一起，前端想分开渲染只能去猜样式 —— 一改配色就崩。
 * 所以让 node 侧把结构化事件单独写一份 JSONL，窗口按行读、按 `t` 分派，
 * 终端流仍旧原样喂给 xterm（左侧交互框一个字都不变）。
 *
 * 设计约束：
 *   · **写不出去也不能影响对话** —— 所有 IO 都 try/catch 吞掉，宁可少一栏数据。
 *   · 单进程单文件：窗口每次启动由 `--ui-events=<path>` 指定，没指定就整条通道关闭。
 *   · 文件超阈值就清空（不轮转）—— 窗口只读增量，历史保留在 transcript / 账本里。
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Band } from './cost.js';

export type UiEvent =
  /** 会话开场：模型 / 线程 / 身份，前端据此重置右栏 */
  | { t: 'session'; model: string; thread: string; module: string }
  /** 用户这一轮说了什么（右栏用它当分组标题） */
  | { t: 'turn'; text: string }
  /** 思考正文增量（流式，前端 append） */
  | { t: 'think'; d: string }
  /** 一段思考结束。chars 是这段正文长度，gist 由 gist.ts 异步补（见 'gist'） */
  | { t: 'think_end'; chars: number; ms: number }
  /** 回答正文增量（可见文本，流式）—— 对话流把它拼成一条回答 */
  | { t: 'say'; d: string }
  /** 一条回答结束：整段文本交给前端重排 markdown（增量拼接时列表/代码块会抖） */
  | { t: 'say_done'; text: string }
  /** 命令 / 系统输出（`/cost` 的表格、报错提示…）。已剥 ANSI，对话流当系统消息渲染 */
  | { t: 'out'; text: string }
  /** 一句话中文备注回来晚了 —— 用它补到对应的 think_end 后面 */
  | { t: 'gist'; gist: string; source: 'model' | 'rule' }
  /** 模型决定调用某个工具（右栏当阶段分隔线） */
  | { t: 'tool'; name: string }
  /** 底部指标栏 */
  | { t: 'stats'; stats: UiStats }
  /** 一轮结束 */
  | { t: 'turn_end'; ok: boolean }
  /** 给人看的提示（报错 / 熔断 / 中止） */
  | { t: 'note'; kind: 'error' | 'info'; text: string };

/** 底部指标栏要的字段。字段名短，因为要一行塞进窗口底部 */
export interface UiStats {
  /** 模型 id */
  model: string;
  /** peak 峰时全价 / off 谷时半价（Band 就是这两个值） */
  band: Band;
  /** 本轮花费（美元） */
  cost: number;
  /** 本轮思考占总花费的百分比 */
  reasonPct: number;
  /** 本轮入 token（= 上下文长度） */
  ctxTok: number;
  /** 本轮缓存命中 token 数 */
  cacheHit: number;
  /** 本轮缓存命中率 0..1 */
  hitRate: number;
  /** 会话累计花费 / 轮数 / 平均每轮 */
  sessionCost: number;
  turns: number;
  avgCost: number;
  /** 账户余额（美元）。查不到是 null —— 不等于 0，前端显示 — */
  balance: number | null;
  /** 余额币种（CNY / USD） */
  balanceCurrency: string;
  /** 余额是什么时候查的（epoch ms），null 表示这次没查 */
  balanceAt: number | null;
}

export interface UiSink {
  emit(e: UiEvent): void;
  /** 立刻落盘（turn_end 这种关键点用，避免最后一屏丢字） */
  flush(): void;
  close(): void;
}

/** 文件超过这个大小就清空重来：窗口只读增量，不需要历史 */
const MAX_BYTES = 512 * 1024;

class JsonlSink implements UiSink {
  private buf: string[] = [];
  private bytes = 0;
  private failed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* 目录建不出来就算了，等下写的时候还会再失败一次 */
    }
    try {
      // 上一轮的残留会让前端重放旧对话 —— 启动即清空
      writeFileSync(file, '', 'utf8');
    } catch {
      this.failed = true;
    }
  }

  emit(e: UiEvent): void {
    if (this.failed) return;
    const line = `${JSON.stringify({ ...e, at: Date.now() })}\n`;
    this.buf.push(line);
    this.schedule();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.failed || !this.buf.length) return;
    const chunk = this.buf.join('');
    this.buf = [];
    try {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > MAX_BYTES) {
        writeFileSync(this.file, chunk, 'utf8');
        this.bytes = Buffer.byteLength(chunk);
        return;
      }
      appendFileSync(this.file, chunk, 'utf8');
    } catch {
      // 盘满 / 文件被占——别把对话拖下水
      this.failed = true;
    }
  }

  close(): void {
    this.flush();
  }

  /** 40ms 合批：流式思考一秒几十个 chunk，逐个 write 太浪费 */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 40);
    // 别让一个 UI 缓冲拖住进程退出
    this.timer.unref?.();
  }
}

/** 内存 sink：测试用，断言事件序列 */
export class MemorySink implements UiSink {
  readonly events: UiEvent[] = [];
  emit(e: UiEvent): void {
    this.events.push(e);
  }
  flush(): void {
    /* 无缓冲 */
  }
  close(): void {
    /* 无需收尾 */
  }
  /** 只取某一类事件 */
  of<T extends UiEvent['t']>(t: T): Extract<UiEvent, { t: T }>[] {
    return this.events.filter((e) => e.t === t) as Extract<UiEvent, { t: T }>[];
  }
}

let current: UiSink | null = null;

/** 换掉当前 sink（测试注入 / 启动时接管）。传 null 关闭通道 */
export function setUiSink(sink: UiSink | null): void {
  current?.close();
  current = sink;
}

export function uiSink(): UiSink | null {
  return current;
}

/** 发一条事件。没有 sink 时是空操作 —— 正常终端里零开销 */
export function emitUi(e: UiEvent): void {
  current?.emit(e);
}

/** 从 `HIVE_UI_EVENTS` 开通道。没设这个环境变量就返回 null（=正常终端） */
export function openUiSinkFromEnv(): UiSink | null {
  const file = (process.env.HIVE_UI_EVENTS ?? '').trim();
  if (!file) return null;
  const sink = new JsonlSink(file);
  setUiSink(sink);
  return sink;
}

/** 文件当前大小（毫秒级诊断用；读不到返回 -1） */
export function uiEventFileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}
