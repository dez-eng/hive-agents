/**
 * 模块注册表 —— 骨架阶段的核心数据结构。
 *
 * 一个「模块」= 一段角色片 + 工具白名单 + 思考预算。切换模块只换尾部那一段，
 * 绝不碰 system 前缀（那是缓存的命根子，见 prompt.ts）。
 *
 * v2 起每个模块挂在一个 agent（A 主 / B 侦察 / C 修复 / D 审计）名下，
 * 见下面的 AGENTS 表：身份决定「能借调谁」，而执行层按栈顶模块收权。
 *
 * v3（见 docs/V3-PLAN.md）：**能力从模块表搬到身份表**。
 * 模块只管「角色片 + 思考档」；「这个 agent 能干什么」归 `AGENTS[i].capabilities`。
 * 这样同一个 agent 换角色不掉能力，同一角色换 agent 也不带能力走。
 */
export type ThinkBudget = 'off' | 'low' | 'high';

/** v2 的四种身份 */
export type AgentId = 'A' | 'B' | 'C' | 'D';

/**
 * v3 的 capability 名。每个 capability 是一个独立单元（tools + 它要的权限），
 * 由 agent 声明式装配；沙箱（能力网关）按 agent 身份 + capability 收权。
 * 现阶段的工具白名单是它的前身 —— M2 会把它们真正拆开。
 */
export type CapabilityId = 'fs' | 'shell' | 'search' | 'web' | 'skill' | 'delegate';

export interface AgentModule {
  /** 唯一 id，命令里用 /use <id> 切 */
  id: string;
  /** 显示名（短，进 footer） */
  title: string;
  /** 一行说明，/modules 里显示 */
  summary: string;
  /**
   * 角色片 —— 唯一进 prompt 的部分，挂在用户消息末尾。
   * 写短：它每轮都在，长了就是每轮都在付钱。
   */
  fragment: string;
  /** 该模块可用的工具名（执行层白名单），空数组 = 不给工具 */
  tools: string[];
  /**
   * 思考预算。→ 请求字段的映射见 think.ts 的 THINK_KWARGS（由 /thinktest 实测得出）：
   * off / low 关思考，high 放开。agent.ts 按栈顶模块的 think 档选模型实例。
   */
  think: ThinkBudget;
  /** 这个模块属于哪个 agent（A 主 / B 侦察 / C 修复 / D 审计） */
  owner?: AgentId;
}

export const MODULES: Record<string, AgentModule> = {
  assistant: {
    id: 'assistant',
    title: '通用',
    summary: '主控 A：读文件、算数、把子任务借调出去',
    fragment: '当前是主控：能读文件、能算数，需要动手时把子任务交给别的角色。',
    tools: ['calculator', 'read_file', 'delegate'],
    think: 'low',
    owner: 'A',
  },
  calc: {
    id: 'calc',
    title: '算数',
    summary: '只做算式，不给解释 —— 窄能力换低思考',
    fragment: '当前是算数器：只回算式的结果，一个数，不解释、不寒暄。',
    tools: ['calculator'],
    think: 'off',
    owner: 'A',
  },
  recon: {
    id: 'recon',
    title: '侦察',
    summary: '信息收集：只陈列事实与来源，需要动手时借调 C/D（v2 给 B agent）',
    fragment:
      '当前是侦察角色：只收集并陈列事实，标出每条事实的来源（哪个文件、哪一行）；不给建议、不下结论。需要动手改文件时，用 delegate 交给修复角色。',
    tools: ['read_file', 'delegate'],
    think: 'high',
    owner: 'B',
  },
  fix: {
    id: 'fix',
    title: '修复',
    summary: '按给定目标与差异改文件，不扩大范围（v2 给 C agent）',
    fragment: '当前是修复角色：只按给定的目标与差异改文件，不顺手重构、不扩大范围。',
    tools: ['read_file', 'write_file'],
    think: 'low',
    owner: 'C',
  },
  audit: {
    id: 'audit',
    title: '审计',
    summary: '复核：只找与事实不符之处（v2 给 D agent）',
    fragment:
      '当前是审计角色：只核对给定结论与原始事实是否一致，指出不一致的条目；不补充新方案。',
    tools: ['read_file'],
    think: 'high',
    owner: 'D',
  },
};

/**
 * 身份表 —— v2 的授权地基，v3 的「agent 定义」。
 *
 * `mayCall` 是「谁可以向谁借调」的唯一真相；执行层按它 + 令牌一起挡。
 * `capabilities` 是「这个 agent 能装配哪些能力」；v3 的能力网关按它收权。
 * 两条都写在数据里而不是提示词里 —— 模型看不到，也绕不过。
 */
export interface AgentSpec {
  id: AgentId;
  title: string;
  /** 该 agent 的主模块 —— `/as <agent>` 压栈的就是它 */
  home: string;
  /** v3：这个 agent 装哪些 capability（见 CapabilityId） */
  capabilities: CapabilityId[];
  /** v3：这个 agent 的默认思考档（模块自身的 think 优先） */
  think?: ThinkBudget;
  /** 可借调的副 agent，空数组 = 只能自己干 */
  mayCall: AgentId[];
  /** v3：能否被 `hive --as <id>` 独立启动（2026-10-15 定：全开） */
  standalone: boolean;
  summary: string;
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  A: {
    id: 'A',
    title: '主控',
    home: 'assistant',
    capabilities: ['fs', 'search', 'delegate'],
    think: 'low',
    mayCall: ['B', 'C', 'D'],
    standalone: true,
    summary: '持会话与工作记忆，定分工、发令牌、做精简再分配',
  },
  B: {
    id: 'B',
    title: '侦察',
    home: 'recon',
    capabilities: ['search', 'delegate'],
    think: 'high',
    mayCall: ['C', 'D'],
    standalone: true,
    summary: '只收集事实；需要动手时向 A 领令牌再借调 C/D',
  },
  C: {
    id: 'C',
    title: '修复',
    home: 'fix',
    capabilities: ['fs'],
    think: 'low',
    mayCall: [],
    standalone: true,
    summary: '按给定目标与差异改文件，不扩大范围',
  },
  D: {
    id: 'D',
    title: '审计',
    home: 'audit',
    capabilities: ['search'],
    think: 'high',
    mayCall: [],
    standalone: true,
    summary: '复核结论与原始事实是否一致',
  },
};

export const DEFAULT_MODULE = 'assistant';
export const DEFAULT_AGENT: AgentId = 'A';

export function getModule(id: string): AgentModule | undefined {
  return MODULES[id];
}

export function moduleList(): AgentModule[] {
  return Object.values(MODULES);
}

export function getAgent(id: string): AgentSpec | undefined {
  return AGENTS[id as AgentId];
}

/** 能独立启动的 agent（`hive --as` 用） */
export function standaloneAgents(): AgentSpec[] {
  return Object.values(AGENTS).filter((a) => a.standalone);
}

/** 模块 → 归属 agent。没写 owner 的老模块按 A 算 */
export function agentOf(moduleId: string): AgentId | undefined {
  return MODULES[moduleId]?.owner ?? (MODULES[moduleId] ? DEFAULT_AGENT : undefined);
}

/** 该身份能不能借调目标身份 —— 执行层授权检查的第一道（第二道是令牌） */
export function mayDelegate(from: AgentId, to: AgentId): boolean {
  return AGENTS[from].mayCall.includes(to);
}

/** 尾巴那一段 —— 固定格式，便于人去认，也便于模型识别 */
export function fragmentFor(m: AgentModule): string {
  return `\n\n【模块:${m.id}｜${m.title}】${m.fragment}`;
}
