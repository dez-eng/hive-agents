/**
 * 图与会话。
 *
 * 三条设计约束，都来自阶段 6.7 的实测：
 *
 * 1. system 提示不进 state、不进 checkpoint —— 每轮调用时临时拼在最前面。
 *    否则它会随历史累积，冻结区一膨胀，每轮都在为重复的 system 付钱。
 *
 * 2. **所有模块共享同一套工具定义**。工具 schema 在 prompt 开头，属于前缀的
 *    一部分；按模块换工具 = 换前缀 = 整个历史缓存作废。所以指令层给全套，
 *    权限收在【执行层】（call_tools 里按模块白名单挡）。
 *    这条也是 v2 的地基：权限不该靠提示词，该靠执行层。
 *
 * 3. 角色片挂在用户消息末尾（见 prompt.ts），切模块不动前缀。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AIMessage, HumanMessage, SystemMessage, ToolMessage, isAIMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { END, START, StateGraph, Annotation, messagesStateReducer } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { ChatDeepSeek } from '@langchain/deepseek';

import { maxOut, memoryPath, modelName } from './config.js';
import { TokenMeter } from './meter.js';
import { DEFAULT_MODULE, MODULES, getModule, type AgentModule } from './modules.js';
import { STABLE_PREFIX, renderUserContent } from './prompt.js';
import { ALL_TOOLS, TOOL_MAP } from './tools.js';

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /** 当前模块 id。工具执行层按它收权 */
  module: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => DEFAULT_MODULE,
  }),
});

export interface TurnRequest {
  text: string;
  threadId: string;
  module: AgentModule;
  tail: boolean;
}

export interface TurnResult {
  /** 模型这次说出来的可见文本 */
  text: string;
  /** 实际发出去的那条用户消息（含角色片），/anatomy 用 */
  sentContent: string;
  meter: TokenMeter;
}

export interface AgentOptions {
  model?: string;
  memoryPath?: string;
}

function buildModel(modelId: string): ChatDeepSeek {
  const cap = maxOut();
  return new ChatDeepSeek({
    model: modelId,
    temperature: 0,
    maxRetries: 2,
    ...(cap ? { maxTokens: cap } : {}),
  });
}

function buildGraph(model: ChatDeepSeek, checkpointer: BaseCheckpointSaver) {
  const bound = model.bindTools(ALL_TOOLS);

  const callModel = async (state: typeof StateAnnotation.State) => {
    const messages = [new SystemMessage(STABLE_PREFIX), ...state.messages];
    const reply = await bound.invoke(messages);
    return { messages: [reply] };
  };

  const callTools = async (state: typeof StateAnnotation.State) => {
    const last = state.messages[state.messages.length - 1];
    const mod = getModule(state.module) ?? MODULES[DEFAULT_MODULE]!;
    const allowed = new Set(mod.tools);
    const out: ToolMessage[] = [];

    for (const call of isAIMessage(last as BaseMessage) ? ((last as AIMessage).tool_calls ?? []) : []) {
      const name = call.name;
      const fn = TOOL_MAP[name] as
        | { invoke: (input: unknown) => Promise<unknown> }
        | undefined;
      let result: string;
      if (!fn) {
        result = `ERROR: 没有这个工具 ${name}`;
      } else if (!allowed.has(name)) {
        result = `ERROR: 当前模块（${mod.id}）没开 ${name}`;
      } else {
        try {
          result = String(await fn.invoke(call.args));
        } catch (e) {
          result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      out.push(new ToolMessage({ content: result, tool_call_id: call.id ?? '' }));
    }
    return { messages: out };
  };

  const route = (state: typeof StateAnnotation.State): 'tools' | typeof END => {
    const last = state.messages[state.messages.length - 1];
    if (isAIMessage(last as BaseMessage) && ((last as AIMessage).tool_calls?.length ?? 0) > 0) {
      return 'tools';
    }
    return END;
  };

  return new StateGraph(StateAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', callTools)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', route, { tools: 'tools', [END]: END })
    .addEdge('tools', 'agent')
    .compile({ checkpointer });
}

export class HiveAgent {
  readonly modelId: string;
  readonly memoryFile: string;

  private readonly app: ReturnType<typeof buildGraph>;

  constructor(opts: AgentOptions = {}) {
    this.modelId = opts.model ?? modelName();
    this.memoryFile = resolve(opts.memoryPath ?? memoryPath());
    mkdirSync(dirname(this.memoryFile), { recursive: true });

    const checkpointer = SqliteSaver.fromConnString(this.memoryFile);
    // fromConnString 是否建表随版本而异；能调就调，重复建表无害
    const maybeSetup = (checkpointer as unknown as { setup?: () => void }).setup;
    if (typeof maybeSetup === 'function') {
      try {
        maybeSetup.call(checkpointer);
      } catch {
        /* 已经建好了 */
      }
    }

    this.app = buildGraph(buildModel(this.modelId), checkpointer);
  }

  /**
   * 跑一轮，边跑边把可见文本喂给 onChunk。
   * 计量挂在 callbacks 上，工具轮（两次调用）会自然累加。
   */
  async run(req: TurnRequest, onChunk?: (piece: string) => void): Promise<TurnResult> {
    const meter = new TokenMeter({ model: this.modelId });
    const sentContent = renderUserContent(req.text, req.module, { tail: req.tail });

    const config = {
      configurable: { thread_id: req.threadId },
      callbacks: [meter],
      streamMode: 'messages' as const,
    };

    let text = '';
    const stream = (await this.app.stream(
      { messages: [new HumanMessage(sentContent)], module: req.module.id },
      config,
    )) as AsyncIterable<[BaseMessage, Record<string, unknown>]>;

    for await (const [chunk, meta] of stream) {
      if (meta?.['langgraph_node'] !== 'agent') continue;
      const piece = contentToText(chunk.content);
      if (!piece) continue;
      text += piece;
      onChunk?.(piece);
    }

    return { text, sentContent, meter };
  }

  async history(threadId: string): Promise<BaseMessage[]> {
    const snap = await this.app.getState({ configurable: { thread_id: threadId } });
    const values = snap?.values as { messages?: BaseMessage[] } | undefined;
    return values?.messages ?? [];
  }

  async checkpoints(threadId: string, limit = 5): Promise<Array<{ step: number; next: string; id: string }>> {
    const out: Array<{ step: number; next: string; id: string }> = [];
    const iter = this.app.getStateHistory({ configurable: { thread_id: threadId } });
    for await (const snap of iter as AsyncIterable<{
      next?: string[];
      metadata?: { step?: number };
      config?: { configurable?: { checkpoint_id?: string } };
    }>) {
      out.push({
        step: snap.metadata?.step ?? -1,
        next: snap.next?.[0] ?? '结束',
        id: snap.config?.configurable?.checkpoint_id ?? '',
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const t = (part as { text?: unknown }).text;
        return typeof t === 'string' ? t : '';
      })
      .join('');
  }
  return '';
}
