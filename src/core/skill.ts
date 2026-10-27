/**
 * skill 装载（v4 M4.2b，设计见 docs/V4-M4.2B-DESIGN.md）。
 *
 * 一句话：把一段**方法论文本**按需贴到本轮用户消息的末尾 ——
 * 不进 system 前缀、不进 checkpoint、清单启动时冻结。
 *
 * 三条自律（与 MCP 同构）：
 *   · **冻结**：启动时把目录里的 `*.md` 一次读进内存；运行中改文件不生效，
 *     否则文本悄悄变了、缓存却以为没变
 *   · **白名单**：装载只接受清单里的名字，不做任何路径拼接 —— 不存在任意文件读取
 *   · **贴尾**：文本由 agent 的 callModel 追加到**发送视图**里最后一条 HumanMessage，
 *     与角色片同侧（必然未命中的尾巴，边际成本 ≈ 0）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import { registerCapabilityTools, type AnyTool } from './capability.js';
import { AGENTS, type AgentId } from './modules.js';

export const SKILL_TOOL = 'load_skill';
/** 贴尾块的起头 —— 与角色片的【模块:…】并列，便于人认、也便于模型认 */
export const SKILL_MARK = '【skill:';
export const DEFAULT_SKILL_DIR = '.hive/skills';
export const DEFAULT_SKILL_MAX_BYTES = 64 * 1024;

export interface SkillInfo {
  name: string;
  title: string;
  path: string;
  bytes: number;
  /** 冻结时的全文 —— 运行中不再读文件 */
  text: string;
}

export interface SkillScan {
  dir: string;
  skills: SkillInfo[];
  warnings: string[];
}

export interface LoadedSkill {
  name: string;
  text: string;
}

/**
 * skill 名 = 文件名去 `.md`。必须字母数字开头 —— 于是 `.` / `..` 这类
 * 能在路径上做文章的名字天然进不来（白名单之外再上一道）。
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function skillMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt((env['HIVE_SKILL_MAX_BYTES'] ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SKILL_MAX_BYTES;
}

/** 第一条 `# ` 行当标题；没有就用文件名 */
export function skillTitle(text: string, name: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m && m[1]) return m[1];
  }
  return name;
}

/**
 * 扫一层目录里的 `*.md`。**不递归**：子目录是别人的组织方式，不是 skill 名空间。
 * 目录不存在 = 0 个 skill（不是错误，与 settings 的「没有文件就安静跳过」一致）。
 */
export function scanSkills(
  dir: string = DEFAULT_SKILL_DIR,
  opts: { maxBytes?: number } = {},
): SkillScan {
  const abs = resolve(dir);
  const maxBytes = opts.maxBytes ?? skillMaxBytes();
  const warnings: string[] = [];
  const skills: SkillInfo[] = [];

  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return { dir: abs, skills, warnings };
  }

  for (const file of entries.sort()) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (!NAME_RE.test(name)) {
      warnings.push(`[skill ${file}：名字只能用字母、数字、. _ -，且字母数字开头 —— 跳过]`);
      continue;
    }
    const path = join(abs, file);
    let bytes: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch (e) {
      warnings.push(`[skill ${file}：读不到（${e instanceof Error ? e.message : String(e)}）—— 跳过]`);
      continue;
    }
    if (bytes > maxBytes) {
      warnings.push(
        `[skill ${file}：${bytes} 字节，超过上限 ${maxBytes}（HIVE_SKILL_MAX_BYTES）—— 跳过]`,
      );
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      warnings.push(`[skill ${file}：读不到（${e instanceof Error ? e.message : String(e)}）—— 跳过]`);
      continue;
    }
    skills.push({ name, title: skillTitle(text, name), path, bytes, text });
  }

  const seen = new Set<string>();
  for (const s of skills) {
    if (seen.has(s.name)) warnings.push(`[skill ${s.name}：重名 —— 后一个仍会覆盖查找，先查到的优先]`);
    seen.add(s.name);
  }
  return { dir: abs, skills, warnings };
}

// ── 冻结清单（进程级。与 mcp.ts 的 summary 同一个模式）───────────────

export interface SkillSummary {
  dir: string;
  skills: SkillInfo[];
  /** 哪些身份装了 `load_skill` */
  agents: string[];
}

let summary: SkillSummary | null = null;

export function setSkillSummary(s: SkillSummary | null): void {
  summary = s;
}

export function skillSummary(): SkillSummary | null {
  return summary;
}

export function findSkill(name: string): SkillInfo | undefined {
  return summary?.skills.find((s) => s.name === name);
}

export type LoadResult =
  | { ok: true; skill: LoadedSkill; msg: string }
  | { ok: false; msg: string };

/** 按名字取冻结文本。未知名字的返回里带上可用清单，模型一次就能纠正。 */
export function loadSkillByName(name: string): LoadResult {
  const clean = (name ?? '').trim();
  if (!clean) return { ok: false, msg: 'ERROR: 要给 skill 名（/skill list 看有哪些）' };
  if (!summary) {
    return { ok: false, msg: 'ERROR: 没配置 skill —— 在 hive.config.json 里写 skills.dir' };
  }
  const hit = findSkill(clean);
  if (!hit) {
    const names = summary.skills.map((s) => s.name);
    return {
      ok: false,
      msg: `ERROR: 没有 skill ${clean}${names.length ? `（可用：${names.join(', ')}）` : '（清单为空）'}`,
    };
  }
  return {
    ok: true,
    skill: { name: hit.name, text: hit.text },
    msg: `已装载 skill ${hit.name}（${hit.bytes} 字节）—— 挂在本轮用户消息末尾，不进前缀、不进 checkpoint`,
  };
}

// ── 贴尾 ────────────────────────────────────────────────────────────

export function skillBlock(name: string, text: string): string {
  return `\n\n${SKILL_MARK}${name}】\n${text.trimEnd()}`;
}

/**
 * 把 skill 追加到**最后一条 HumanMessage** 的发送副本上。
 *
 * 为什么不是「列表末尾」：工具轮的 state 末尾是 ToolMessage，在它后面插一条
 * 会变成新的用户输入，破坏消息序列；而本轮的用户消息在历史里一直都在，
 * 追加到它末尾，工具轮也能继续看到 skill。
 *
 * 返回新数组，**不改入参** —— state / checkpoint 一个字节不动。
 */
export function withSkill(messages: BaseMessage[], skill: LoadedSkill | null): BaseMessage[] {
  if (!skill || !skill.text.trim()) return messages;
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      at = i;
      break;
    }
  }
  if (at < 0) return messages;
  const orig = messages[at] as HumanMessage;
  // 多模态内容（数组）不在这里拼 —— hive 的用户消息一直是字符串
  if (typeof orig.content !== 'string') return messages;
  const out = messages.slice();
  out[at] = new HumanMessage({ content: orig.content + skillBlock(skill.name, skill.text) });
  return out;
}

// ── 工具与装配 ──────────────────────────────────────────────────────

/**
 * `load_skill` 的 schema。真正的装载在 agent.ts 的 callTools 里特判（同 delegate）：
 * 工具本身拿不到本轮 runtime，也不该拿。直接调用它只会得到一句说明。
 */
export const loadSkillTool = tool(
  async (): Promise<string> => 'ERROR: load_skill 只在 hive 会话里由执行层处理',
  {
    name: SKILL_TOOL,
    description: '装载一个 skill（方法论文本），挂到本轮用户消息末尾。只接受 /skill list 里的名字。',
    schema: z.object({ name: z.string().describe('skill 名，例如 review') }),
  },
) as StructuredToolInterface;

export function isSkillTool(name: string): boolean {
  return name === SKILL_TOOL;
}

/** 启动时把 load_skill 装进 capability 注册表（顺序 = 前缀顺序，见 capability.ts） */
export function registerSkillTools(tools: AnyTool[]): void {
  registerCapabilityTools('skill', tools);
}

/** 给指定身份打开 skill 能力（只加 capability，工具集由 toolsFor 装配） */
export function enableSkillFor(agents: string[]): string[] {
  const enabled: string[] = [];
  for (const raw of agents) {
    const id = raw.trim().toUpperCase() as AgentId;
    if (!(id in AGENTS)) continue;
    if (!AGENTS[id].capabilities.includes('skill')) AGENTS[id].capabilities.push('skill');
    enabled.push(id);
  }
  return enabled;
}

/**
 * 启动装配：注册工具 + 给身份开能力。
 * 清单为空时不注册 —— 0 个 skill = 0 个工具 = 0 token（与 MCP 没配 server 同）。
 */
export function activateSkills(scan: SkillScan, agents: string[] = ['A']): string[] {
  if (!scan.skills.length) {
    registerSkillTools([]);
    // 空清单也记下来：`/skill list` 才能说清「目录配了、里面没东西」
    setSkillSummary({ dir: scan.dir, skills: [], agents: [] });
    return [];
  }
  registerSkillTools([loadSkillTool]);
  const enabled = enableSkillFor(agents);
  setSkillSummary({ dir: scan.dir, skills: scan.skills, agents: enabled });
  return enabled;
}
