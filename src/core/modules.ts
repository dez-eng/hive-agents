/**
 * 模块注册表 —— 骨架阶段的核心数据结构。
 *
 * 一个「模块」= 一段角色片 + 工具白名单 + 思考预算。切换模块只换尾部那一段，
 * 绝不碰 system 前缀（那是缓存的命根子，见 prompt.ts）。
 *
 * v2 会把这里的每个模块接到一个副 agent（B/C/D）上；本阶段先把
 * 「换模块不炸缓存」这条机制跑通，模块本身写得朴素。
 */
export type ThinkBudget = 'off' | 'low' | 'high';

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
   * 思考预算。DeepSeek 那侧的开关还没验证出结论（阶段 6.7 的
   * /thinktest 悬着），本阶段只记录意向、不强行施加，免得两条变量
   * 混在一起，账本读不出来。
   */
  think: ThinkBudget;
  /** 预留：v2 里这个模块属于哪个副 agent（A 主 / B 侦察 / C 修复 / D 审计） */
  owner?: 'A' | 'B' | 'C' | 'D';
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

export const DEFAULT_MODULE = 'assistant';

export function getModule(id: string): AgentModule | undefined {
  return MODULES[id];
}

export function moduleList(): AgentModule[] {
  return Object.values(MODULES);
}

/** 尾巴那一段 —— 固定格式，便于人去认，也便于模型识别 */
export function fragmentFor(m: AgentModule): string {
  return `\n\n【模块:${m.id}｜${m.title}】${m.fragment}`;
}
