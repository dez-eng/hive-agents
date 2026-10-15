/**
 * 模块注册表 —— 骨架阶段的核心数据结构。
 *
 * 一个「模块」= 一段角色片 + 工具白名单 + 思考预算。切换模块只换尾部那一段，
 * 绝不碰 system 前缀（那是缓存的命根子，见 prompt.ts）。
 *
 * v2 起每个模块挂在一个 agent（A 主 / B 侦察 / C 修复 / D 审计）名下，
 * 见下面的 AGENTS 表：身份决定「能借调谁」，而执行层按栈顶模块收权。
 */
export type ThinkBudget = 'off' | 'low' | 'high';

/** v2 的四种身份 */
export type AgentId = 'A' | 'B' | 'C' | 'D';

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
  /** 该模块可用的工具名，空数组 = 不给工具 */
  tools: string[];
  /**
   * 思考预算。DeepSeek 那侧的开关还没验证出结论（/thinktest 在 M1 落地），
   * 本阶段只记录意向、不强行施加，免得两条变量混在一起，账本读不出来。
   */
  think: ThinkBudget;
  /** 这个模块属于哪个 agent（A 主 / B 侦察 / C 修复 / D 审计） */
  owner?: AgentId;
}

export const MODULES: Record<string, AgentModule> = {
  assistant: {
    id: 'assistant',
    title: '通用',
    summary: '默认助手：读文件、算数，一句话作答',
    fragment: '当前是通用助手：能读文件、能算数，只答问题本身。',
    tools: ['calculator', 'read_file'],
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
    summary: '信息收集：只陈列事实与来源，不做判断（v2 给 B agent）',
    fragment:
      '当前是侦察角色：只收集并陈列事实，标出每条事实的来源（哪个文件、哪一行）；不给建议、不下结论。',
    tools: ['read_file'],
    think: 'high',
    owner: 'B',
  },
  fix: {
    id: 'fix',
    title: '修复',
    summary: '按给定目标与差异改文件，不扩大范围（v2 给 C agent）',
    fragment: '当前是修复角色：只按给定的目标与差异改文件，不顺手重构、不扩大范围。',
    // M1 零新工具（工具 schema 属缓存前缀，改动要一次加齐）。
    // write_file 与 delegate 在 M2 一起进 ALL_TOOLS —— 那时前缀只作废一次。
    tools: ['read_file'],
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
 * 身份表 —— v2 的授权地基。
 *
 * `mayCall` 是「谁可以向谁借调」的唯一真相；执行层（M2 的 delegate 入口）
 * 按它 + 令牌一起挡。写在数据里而不是提示词里，模型看不到也绕不过。
 */
export interface AgentSpec {
  id: AgentId;
  title: string;
  /** 该 agent 的主模块 —— `/as <agent>` 压栈的就是它 */
  home: string;
  /** 可借调的副 agent，空数组 = 只能自己干 */
  mayCall: AgentId[];
  summary: string;
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  A: {
    id: 'A',
    title: '主控',
    home: 'assistant',
    mayCall: ['B', 'C', 'D'],
    summary: '持会话与工作记忆，定分工、发令牌、做精简再分配',
  },
  B: {
    id: 'B',
    title: '侦察',
    home: 'recon',
    mayCall: ['C', 'D'],
    summary: '只收集事实；需要动手时向 A 领令牌再借调 C/D',
  },
  C: {
    id: 'C',
    title: '修复',
    home: 'fix',
    mayCall: [],
    summary: '按给定目标与差异改文件，不扩大范围',
  },
  D: {
    id: 'D',
    title: '审计',
    home: 'audit',
    mayCall: [],
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
