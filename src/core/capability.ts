/**
 * capability 层 —— 「这个 agent 能用什么」的唯一真相（docs/V3-M2-DESIGN.md §2）。
 *
 * v2 把工具白名单写在**模块表**里、按角色裁剪；v3 把它搬到**身份表**：
 * `AgentModule` 只管「角色片 + 思考档」，「能干什么」看 `AGENTS[i].capabilities`，
 * 装配这件事发生在本文件。于是同一个 agent 换角色不掉能力，同一角色换 agent
 * 也不带能力走。
 *
 * ⚠ 工具顺序 = prompt 前缀顺序。**别调整 `CAPABILITY_ORDER` 与各 capability 里
 * `tools` 的次序** —— 那等于把装了它的 agent 的缓存作废一次（V3-PLAN §3.1）。
 *
 * 缓存单位因此从「全局一套工具」变成「每个 agent 一套」：各 agent 各有一份
 * 前缀缓存，互不影响。加一个 capability 只作废装了它的那些 agent。
 */
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import { AGENTS, type AgentId, type CapabilityId } from './modules.js';
import type { ActionKind } from './policy.js';
import { globTool, grepTool } from './search.js';
import { bashTool } from './bash.js';
import { calculator, delegateTool, editFileTool, readFileTool, writeFileTool } from './tools.js';

/** 工具在 capability 层里的统一身份（`tool()` 造出来的都是它） */
export type AnyTool = StructuredToolInterface;

export interface Capability {
  id: CapabilityId;
  title: string;
  summary: string;
  /** 它贡献的工具 schema —— **顺序即前缀顺序** */
  tools: AnyTool[];
  /**
   * 它可能发起的动作类型（给人看、给 /policy 显示）。
   * **不参与判定** —— 判定看 `AGENTS[i].capabilities` + policy（policy.ts）。
   */
  needs: ActionKind[];
}

/** 注册表顺序 = 前缀顺序。改这个 = 作废所有装了后面那些的 agent 的缓存 */
export const CAPABILITY_ORDER: CapabilityId[] = [
  'fs',
  'search',
  'calc',
  'delegate',
  'shell',
  'web',
  'skill',
];

export const CAPABILITIES: Record<CapabilityId, Capability> = {
  fs: {
    id: 'fs',
    title: '文件',
    summary: '读/写/改 roots 内的文件（写权限按身份收，见 /policy）',
    tools: [readFileTool, writeFileTool, editFileTool],
    needs: ['fs.read', 'fs.write'],
  },
  search: {
    id: 'search',
    title: '搜索',
    summary: '按正则搜内容、按通配符列文件 —— 比通读文件省 token',
    tools: [grepTool, globTool],
    needs: ['fs.read'],
  },
  calc: {
    id: 'calc',
    title: '算数',
    summary: '只算算式，无副作用',
    tools: [calculator],
    needs: [],
  },
  delegate: {
    id: 'delegate',
    title: '借调',
    summary: '把子任务交给别的 agent（真正的闸门是令牌 + 预算）',
    tools: [delegateTool],
    needs: ['delegate'],
  },
  shell: {
    id: 'shell',
    title: 'shell',
    summary: '跑命令（没 shell 所以不支持管道/重定向；命令要在策略白名单里）',
    tools: [bashTool],
    needs: ['exec'],
  },
  // ── 以下两个仍只声明、不实现（M2.5 已经把 shell 落地了）：贡献 0 个工具 = 0 token，
  //    `/caps` 会明说「声明了、还没实现」，比凭空冒出一个能力要好。
  web: {
    id: 'web',
    title: 'web',
    summary: '（声明，未实现）取网页',
    tools: [],
    needs: ['net'],
  },
  skill: {
    id: 'skill',
    title: 'skill',
    summary: '（声明，未实现）装载 playbook',
    tools: [],
    needs: [],
  },
};

/** 工具 → 动作类型。**没有映射 = 无副作用**（如 calculator），不进网关 */
const TOOL_ACTION: Record<string, ActionKind> = {
  read_file: 'fs.read',
  write_file: 'fs.write',
  edit_file: 'fs.write',
  grep: 'fs.read',
  glob: 'fs.read',
  bash: 'exec',
  delegate: 'delegate',
};

export function kindOf(tool: string): ActionKind | undefined {
  return TOOL_ACTION[tool];
}

export function capabilityOfTool(tool: string): CapabilityId | undefined {
  for (const id of CAPABILITY_ORDER) {
    if (CAPABILITIES[id].tools.some((t) => t.name === tool)) return id;
  }
  return undefined;
}

/** 该身份的工具集 —— 去重、按注册表顺序。**判据是身份，不是模块** */
export function toolsFor(agent: AgentId): AnyTool[] {
  const out: AnyTool[] = [];
  const seen = new Set<string>();
  for (const id of CAPABILITY_ORDER) {
    if (!AGENTS[agent].capabilities.includes(id)) continue;
    for (const t of CAPABILITIES[id].tools) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      out.push(t);
    }
  }
  return out;
}

export function toolNamesFor(agent: AgentId): string[] {
  return toolsFor(agent).map((t) => t.name);
}

/** 全部已注册的工具（各 capability 的并集）—— 分派与 /anatomy 用 */
export const ALL_TOOLS: AnyTool[] = CAPABILITY_ORDER.flatMap((id) => CAPABILITIES[id].tools);

export const TOOL_MAP: Record<string, AnyTool> = Object.fromEntries(
  ALL_TOOLS.map((t) => [t.name, t]),
);

/** 工具定义在 prompt 里占多少字符 —— 它是前缀的一部分 */
export function toolsChars(tools: AnyTool[] = ALL_TOOLS): number {
  let n = 0;
  for (const t of tools) {
    n += t.name.length + (t.description ?? '').length;
    try {
      n += JSON.stringify(z.toJSONSchema(t.schema as never)).length;
    } catch {
      /* 拿不到 schema 就算了 */
    }
  }
  return n;
}

/** 某个身份每轮为工具 schema 付的字符数（缓存测算用） */
export function toolsCharsFor(agent: AgentId): number {
  return toolsChars(toolsFor(agent));
}

/** 声明了但一个工具都没有的 capability（M2 的 shell/web/skill） */
export function declaredOnly(): CapabilityId[] {
  return CAPABILITY_ORDER.filter((id) => CAPABILITIES[id].tools.length === 0);
}
