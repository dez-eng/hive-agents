/**
 * 能力网关 —— 所有副作用的同一道门（V3-PLAN §4.1，docs/V3-M2-DESIGN.md §3）。
 *
 * 两个判据缺一不可：
 *   · `AGENTS[by].capabilities` —— 谁「能」发起这类动作
 *   · 规则表 —— 「这一次」准不准
 * 网关自己**再查一次** capability：它是这层能力的唯一真相，别处漏了它也能兜住。
 *
 * 规则从配置读，不写死在代码里（2026-10-15 拍板 §7 第 3 条）：
 *   默认 `.hive/policy.json`，可用 `HIVE_POLICY` 换路径；
 *   七个 `HIVE_POLICY_*` 环境变量**优先于**文件。
 * **配置坏了 = 整份退回内置默认（default deny）** —— 绝不因为配置写错就默认放行。
 *
 * 这是 L1：进程内的路径检查 + 白名单。挡不住符号链接，也挡不住 agent
 * 自己写脚本绕过 —— 那是 M3 的 L2（子进程 + 环境隔离）要管的。
 */
import { readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { AGENTS, mayDelegate, type AgentId, type CapabilityId } from './modules.js';

export type ActionKind = 'fs.read' | 'fs.write' | 'exec' | 'net' | 'delegate' | 'mcp';
export type Decision = 'allow' | 'deny' | 'ask';

export interface PolicySpec {
  /** 没被规则表明确提到的动作怎么办 —— 内置默认是 deny */
  default: Decision;
  /** fs / search 的作用域（相对 cwd，也可写绝对路径） */
  roots: string[];
  /** 按身份 × 动作类型的规则表 */
  agents: Partial<Record<AgentId, Partial<Record<ActionKind, Decision>>>>;
  exec: { allowCommands: string[] };
  net: { allowDomains: string[] };
  /**
   * v4 M4.2：MCP server 白名单。
   * 空数组 = 一个都不许；`"*"` = 不限（自担风险）。身份级规则仍可显式 deny。
   */
  mcp: { allowServers: string[] };
  /** search 遍历时跳过的目录名 */
  ignore: string[];
}

export interface Action {
  kind: ActionKind;
  /** 文件路径 / 命令 / 域名 / 借调目标身份 */
  target: string;
  by: AgentId;
  capability: CapabilityId;
  tool: string;
  threadId?: string;
  taskId?: string;
}

export type VerdictCode = 'allow' | 'no-capability' | 'out-of-roots' | 'denied' | 'ask-pending';

export interface Verdict {
  allow: boolean;
  code: VerdictCode;
  /** 人话 —— 进工具结果，也进账本 */
  reason: string;
  /** 命中的规则来源：'agents.B.fs.write' / 'default' / 'roots' / 'AGENTS.B.capabilities' */
  rule: string;
}

const KINDS: ActionKind[] = ['fs.read', 'fs.write', 'exec', 'net', 'delegate', 'mcp'];

/** 内置默认 —— 与 docs/V3-M2-DESIGN.md §3.4 一致（default deny，A/C 可写、B/D 只读） */
export const DEFAULT_SPEC: PolicySpec = {
  default: 'deny',
  roots: ['.'],
  agents: {
    A: { 'fs.read': 'allow', 'fs.write': 'allow' },
    B: { 'fs.read': 'allow', 'fs.write': 'deny' },
    C: { 'fs.read': 'allow', 'fs.write': 'allow' },
    D: { 'fs.read': 'allow', 'fs.write': 'deny' },
  },
  exec: { allowCommands: [] },
  net: { allowDomains: [] },
  mcp: { allowServers: [] },
  ignore: ['.git', 'node_modules', 'dist', '.hive'],
};

function cloneSpec(s: PolicySpec): PolicySpec {
  return {
    default: s.default,
    roots: [...s.roots],
    agents: JSON.parse(JSON.stringify(s.agents)) as PolicySpec['agents'],
    exec: { allowCommands: [...s.exec.allowCommands] },
    net: { allowDomains: [...s.net.allowDomains] },
    mcp: { allowServers: [...s.mcp.allowServers] },
    ignore: [...s.ignore],
  };
}

function asDecision(v: unknown, fallback: Decision): Decision {
  return v === 'allow' || v === 'deny' || v === 'ask' ? v : fallback;
}

function strList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * 把来路不明的 JSON 变成一份完整 spec。**坏字段忽略、退回该字段的内置默认**，
 * 而不是整份作废 —— 单看一个字段写错就全盘 deny 太粗暴，但 `default` 一定兜住。
 */
export function normalize(raw: unknown): PolicySpec {
  const spec = cloneSpec(DEFAULT_SPEC);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  if (o['default'] !== undefined) spec.default = asDecision(o['default'], spec.default);
  const roots = strList(o['roots']);
  if (roots && roots.length) spec.roots = roots;
  const ignore = strList(o['ignore']);
  if (ignore && ignore.length) spec.ignore = ignore;

  const agentsRaw = o['agents'];
  if (agentsRaw && typeof agentsRaw === 'object') {
    for (const [key, val] of Object.entries(agentsRaw as Record<string, unknown>)) {
      const id = key.trim().toUpperCase() as AgentId;
      if (!(id in AGENTS)) continue;
      if (!val || typeof val !== 'object') continue;
      const slot = (spec.agents[id] ??= {});
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const kind = k.trim() as ActionKind;
        if (!KINDS.includes(kind)) continue;
        slot[kind] = asDecision(v, slot[kind] ?? spec.default);
      }
    }
  }

  const exec = o['exec'];
  if (exec && typeof exec === 'object') {
    const list = strList((exec as Record<string, unknown>)['allowCommands']);
    if (list) spec.exec.allowCommands = list;
  }
  const net = o['net'];
  if (net && typeof net === 'object') {
    const list = strList((net as Record<string, unknown>)['allowDomains']);
    if (list) spec.net.allowDomains = list;
  }
  const mcp = o['mcp'];
  if (mcp && typeof mcp === 'object') {
    const list = strList((mcp as Record<string, unknown>)['allowServers']);
    if (list) spec.mcp.allowServers = list;
  }

  return spec;
}

/** 覆盖用的环境变量名（/policy 里要把它们列出来，好知道放宽是谁开的） */
export const ENV_KEYS = [
  'HIVE_POLICY',
  'HIVE_POLICY_DEFAULT',
  'HIVE_POLICY_ROOTS',
  'HIVE_POLICY_READ',
  'HIVE_POLICY_WRITE',
  'HIVE_POLICY_EXEC',
  'HIVE_POLICY_NET',
  'HIVE_POLICY_MCP',
] as const;

const ENV_KIND: Array<[string, ActionKind]> = [
  ['HIVE_POLICY_READ', 'fs.read'],
  ['HIVE_POLICY_WRITE', 'fs.write'],
  ['HIVE_POLICY_EXEC', 'exec'],
  ['HIVE_POLICY_NET', 'net'],
];

/**
 * 环境变量覆盖（CI / 临时放宽用）。
 * `HIVE_POLICY_READ=A,B` 是**白名单**语义：列出的允许，其余一律 deny。
 * 白名单而不是黑名单 —— 放宽这件事本身要显式写出来。
 */
export function applyEnv(spec: PolicySpec, env: NodeJS.ProcessEnv = process.env): PolicySpec {
  const out = cloneSpec(spec);

  const dflt = (env['HIVE_POLICY_DEFAULT'] ?? '').trim().toLowerCase();
  if (dflt === 'allow' || dflt === 'deny' || dflt === 'ask') out.default = dflt;

  const roots = (env['HIVE_POLICY_ROOTS'] ?? '').trim();
  if (roots) {
    const list = roots
      .split(delimiter)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) out.roots = list;
  }

  for (const [key, kind] of ENV_KIND) {
    const raw = (env[key] ?? '').trim();
    if (!raw) continue;
    const allow = raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    for (const id of Object.keys(AGENTS) as AgentId[]) {
      const slot = (out.agents[id] ??= {});
      slot[kind] = allow.includes(id) ? 'allow' : 'deny';
    }
  }

  // v4 M4.2：MCP 是 server 白名单，不是按身份
  const mcpRaw = (env['HIVE_POLICY_MCP'] ?? '').trim();
  if (mcpRaw) {
    out.mcp.allowServers = mcpRaw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return out;
}

export interface LoadedPolicy {
  spec: PolicySpec;
  /** '内置默认' 或配置文件路径 */
  source: string;
  warnings: string[];
  /** 生效的环境变量名 */
  envKeys: string[];
}

let cached: LoadedPolicy | null = null;

export function policyPath(env: NodeJS.ProcessEnv = process.env): string {
  return (env['HIVE_POLICY'] ?? '').trim() || '.hive/policy.json';
}

export function loadPolicy(force = false, env: NodeJS.ProcessEnv = process.env): LoadedPolicy {
  if (cached && !force) return cached;

  const warnings: string[] = [];
  let spec = cloneSpec(DEFAULT_SPEC);
  let source = '内置默认';

  const file = policyPath(env);
  let text: string | null = null;
  try {
    text = readFileSync(resolve(file), 'utf8');
  } catch {
    /* 没有配置文件是正常状态 —— 用内置默认 */
  }
  if (text !== null) {
    try {
      spec = normalize(JSON.parse(text) as unknown);
      source = file;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`[策略配置读不了：${file} 解析失败（${msg}）—— 整份退回内置默认（default deny）]`);
    }
  }

  spec = applyEnv(spec, env);
  const envKeys = ENV_KEYS.filter((k) => (env[k] ?? '').trim() !== '');

  cached = { spec, source, warnings, envKeys };
  return cached;
}

/** 测试 / 嵌入用：注入一份策略；传 null 清掉缓存回到从配置读 */
export function setPolicySpec(spec: PolicySpec | null): void {
  cached = spec ? { spec: cloneSpec(spec), source: '注入', warnings: [], envKeys: [] } : null;
}

/**
 * v4 M4.2：把 hive.config.json 里的 `mcp.allowServers` 并入当前策略。
 * 调用方负责「env 优先」—— `HIVE_POLICY_MCP` 设了就不要走这里。
 */
export function setMcpAllowServers(servers: string[]): void {
  const cur = loadPolicy();
  cached = { ...cur, spec: { ...cur.spec, mcp: { allowServers: [...servers] } } };
}

export function currentSpec(): PolicySpec {
  return loadPolicy().spec;
}

export function rootsOf(spec: PolicySpec = currentSpec(), cwd = process.cwd()): string[] {
  return spec.roots.map((r) => resolve(cwd, r));
}

export function ignoreOf(spec: PolicySpec = currentSpec()): Set<string> {
  return new Set(spec.ignore);
}

/** 目标在不在 roots 之内（前缀比较要带分隔符，否则 D:\proj 会放行 D:\proj-evil） */
export function withinRoots(target: string, spec: PolicySpec = currentSpec(), cwd = process.cwd()): boolean {
  const t = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  for (const root of rootsOf(spec, cwd)) {
    if (t === root) return true;
    if (t.startsWith(root.endsWith(sep) ? root : root + sep)) return true;
  }
  return false;
}

// ── v3 M2.6：解析真实路径之后再判（挡符号链接穿透）──────────────

/** Windows 上同一文件可能写成 D:\x 与 d:\x，比较要大小写不敏感 */
const CASE_INSENSITIVE = process.platform === 'win32';

function normPath(p: string): string {
  let s = p;
  if (s.startsWith('\\\\?\\')) s = s.slice(4); // 长路径前缀
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
}

function insidePath(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * 把路径解成**真实路径**。`resolved === false` 表示解析不出来（目录不存在 / 没权限）
 * —— 调用方按**拒绝**处理（保守侧）。
 *
 * 目标还不存在（准备新建）是常见情况：这时解析它的父目录，再拼回基名。
 */
export function realPathOf(abs: string): { path: string; resolved: boolean } {
  try {
    return { path: realpathSync(abs), resolved: true };
  } catch {
    /* 不存在或读不到，退一步解析父目录 */
  }
  try {
    return { path: join(realpathSync(dirname(abs)), basename(abs)), resolved: true };
  } catch {
    return { path: abs, resolved: false };
  }
}

/** roots 的真实路径（cwd 或 roots 自身可能就是链接） */
export function rootsReal(spec: PolicySpec = currentSpec(), cwd = process.cwd()): string[] {
  return spec.roots.map((r) => realPathOf(resolve(cwd, r)).path);
}

export interface RealCheck {
  ok: boolean;
  /** 解析后的真实路径（进错误信息，也便于调试） */
  real: string;
}

/**
 * v3 M2.6：**解析真实路径之后**再判在不在 roots 内 —— 挡住「项目里的链接指向外面」。
 * 语义是「解析后仍在 roots 内就放行」：指向仓库内部的链接（monorepo 常见）照常可用。
 *
 * 网关判定与工具层兜底都走这一个函数，保证**同源**。
 */
export function withinRootsReal(
  target: string,
  spec: PolicySpec = currentSpec(),
  cwd = process.cwd(),
): RealCheck {
  const abs = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  const { path: real, resolved } = realPathOf(abs);
  if (!resolved) return { ok: false, real };
  for (const root of rootsReal(spec, cwd)) {
    if (insidePath(real, root)) return { ok: true, real };
  }
  return { ok: false, real };
}

/** 命令的第一个词（去掉路径）—— exec 白名单按它比对；bash.ts 也用这个，保证只有一份语义 */
export function commandBase(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return first.split(/[\\/]/).pop() ?? first;
}

/**
 * 把命令行切成 `[bin, ...args]`。**「不给 shell」的前提就是这个函数**：
 * 支持单双引号（引号内不被空格切开），不支持转义 / 变量展开 / 管道 / 重定向 ——
 * 那些都要 shell，而我们不给。
 */
export function splitCommand(command: string): { bin: string; args: string[] } {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur) {
        parts.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) parts.push(cur);

  const [bin = '', ...args] = parts;
  return { bin, args };
}

/**
 * 白名单判定（M2.6 拍板）：**命令前 N 个词前缀精确匹配**。
 *
 * ```
 * "git"         → 任何 git 子命令都放行
 * "git status"  → 只有以 git status 开头的命令
 * "*"           → 不限（自担风险）
 * ```
 * 白名单项的第一词也按 basename 归一化，所以写 `/usr/bin/git` 与 `git` 等价。
 */
export function commandAllowed(
  command: string,
  allow: string[],
): { ok: boolean; base: string; matched?: string } {
  const { bin, args } = splitCommand(command);
  const base = bin.split(/[\\/]/).pop() ?? bin;
  const words = [base, ...args];

  for (const rawItem of allow) {
    const item = rawItem.trim();
    if (!item) continue;
    if (item === '*') return { ok: true, base, matched: '*' };

    const want = item.split(/\s+/).filter(Boolean);
    if (!want.length) continue;
    const head = want[0]!.split(/[\\/]/).pop() ?? want[0]!;
    const need = [head, ...want.slice(1)];

    if (need.length > words.length) continue;
    let hit = true;
    for (let i = 0; i < need.length; i += 1) {
      if (need[i] !== words[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { ok: true, base, matched: item };
  }
  return { ok: false, base };
}

function verdict(allow: boolean, code: VerdictCode, reason: string, rule: string): Verdict {
  return { allow, code, reason, rule };
}

/**
 * 一次动作过门。判定顺序 = 便宜且致命的先来：
 *   1. 身份有没有这个 capability（没有 = 连门都不该走到）
 *   2. delegate 特殊：闸门是令牌，这里只做 mayCall 轻检查
 *   3. 文件类：目标是否在 roots 内
 *   4. 规则表（显式规则 → default）
 *   5. exec / net 的额外白名单（M2 没有对应 capability，先写着）
 */
export function checkAction(a: Action, spec: PolicySpec = currentSpec()): Verdict {
  const specOfAgent = spec.agents[a.by] ?? {};

  const caps = AGENTS[a.by]?.capabilities ?? [];
  if (!caps.includes(a.capability)) {
    return verdict(
      false,
      'no-capability',
      `身份 ${a.by} 没装能力 ${a.capability}`,
      `AGENTS.${a.by}.capabilities`,
    );
  }

  // 借调：真正的闸门是 grant.ts 的令牌 + 预算（M2 不搬家），这里只挡「不该借还借」
  if (a.kind === 'delegate') {
    const to = a.target.trim().toUpperCase() as AgentId;
    if (!(to in AGENTS)) {
      return verdict(false, 'denied', `没有身份 ${a.target}`, `AGENTS.${a.by}.mayCall`);
    }
    if (!mayDelegate(a.by, to)) {
      return verdict(false, 'denied', `${a.by} 不能借调 ${to}`, `AGENTS.${a.by}.mayCall`);
    }
    return verdict(true, 'allow', `可借调 ${to}`, `AGENTS.${a.by}.mayCall`);
  }

  /**
   * v4 M4.2：MCP 工具。target = server 名。
   * 判定：身份显式 deny 优先 → 身份显式 allow → server 白名单 → 默认拒绝。
   * `mcp.allowServers` 本身就是「显式允许」，不受 default deny 影响。
   */
  if (a.kind === 'mcp') {
    const server = a.target.trim();
    if (!server) return verdict(false, 'denied', 'MCP 工具缺少 server 名', 'mcp.allowServers');
    const agentRule = specOfAgent['mcp'];
    if (agentRule === 'deny') {
      return verdict(false, 'denied', `规则 agents.${a.by}.mcp = deny`, `agents.${a.by}.mcp`);
    }
    if (agentRule === 'allow') {
      return verdict(true, 'allow', `${a.by} 允许所有 MCP server`, `agents.${a.by}.mcp`);
    }
    const allowed = spec.mcp.allowServers;
    if (allowed.includes('*') || allowed.includes(server)) {
      return verdict(true, 'allow', `MCP server ${server} 在 allowServers 里`, 'mcp.allowServers');
    }
    return verdict(
      false,
      'denied',
      `MCP server ${server} 不在 allowServers（${allowed.join(',') || '空'}）`,
      'mcp.allowServers',
    );
  }

  if (a.kind === 'fs.read' || a.kind === 'fs.write') {
    // v3 M2.6：与工具层兜底同源 —— 都解析真实路径再比，符号链接穿透在这一层就被拒
    const check = withinRootsReal(a.target, spec);
    if (!check.ok) {
      return verdict(
        false,
        'out-of-roots',
        `${a.target} 在 roots（${spec.roots.join(', ')}）之外（解析后：${check.real}）`,
        'roots',
      );
    }
  }

  const explicit = specOfAgent[a.kind];
  const decision = explicit ?? spec.default;
  const rule = explicit ? `agents.${a.by}.${a.kind}` : 'default';

  if (decision === 'deny') {
    return verdict(false, 'denied', `规则 ${rule} = deny`, rule);
  }

  if (decision === 'ask') {
    // M2 没有交互通道（流式输出 + 非 TTY 的 run 模式都会被打断），按拒绝处理但记账时区分
    return verdict(
      false,
      'ask-pending',
      `规则 ${rule} = ask —— 本版没有确认通道，按拒绝处理`,
      rule,
    );
  }

  if (a.kind === 'exec') {
    // "*" = 不限（自担风险）；否则按「命令前 N 个词前缀精确匹配」——
    // 白名单可以只写 "git"，也可以细到 "git status"
    const v = commandAllowed(a.target, spec.exec.allowCommands);
    if (!v.ok) {
      return verdict(
        false,
        'denied',
        `命令 ${v.base} 不在 exec.allowCommands 里（要放开就加 "${v.base}"，或写 "*" 表示不限）`,
        'exec.allowCommands',
      );
    }
  }

  if (a.kind === 'net') {
    const host = a.target.trim().toLowerCase();
    if (!spec.net.allowDomains.some((d) => host === d.toLowerCase())) {
      return verdict(false, 'denied', `域名 ${host} 不在 net.allowDomains 里`, 'net.allowDomains');
    }
  }

  return verdict(true, 'allow', `规则 ${rule} = allow`, rule);
}
