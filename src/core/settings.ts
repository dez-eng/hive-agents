/**
 * `hive.config.json` —— v4 M4.2 的配置文件（MCP / 价格）。
 *
 * 三条自律：
 *   · 只做「读 + 校验 + 退回默认」，不在这里连任何东西
 *   · 文件不存在不是错误（默认配置就能跑）
 *   · 写坏了整份忽略并说清原因 —— 与 policy 的「写坏退回默认 deny」同一态度：
 *     宁可少开能力，也不能因为手滑多开
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parsePriceOverlay, type ModelPrice } from './cost.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpSettings {
  servers: Record<string, McpServerConfig>;
  /** 哪些身份装 MCP 工具（默认 ['A']） */
  agents: string[];
  /** server 白名单（写进 policy 的便捷入口；HIVE_POLICY_MCP 优先） */
  allowServers: string[];
}

export interface HiveSettings {
  mcp?: McpSettings;
  price?: Record<string, ModelPrice>;
}

export interface LoadedSettings {
  spec: HiveSettings;
  path: string;
  source: 'file' | 'default';
  warnings: string[];
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return (env['HIVE_CONFIG'] ?? '').trim() || 'hive.config.json';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 纯函数：把来路不明的 JSON 变成 settings。坏字段给原因，不猜。 */
export function parseSettings(
  raw: unknown,
): { ok: true; value: HiveSettings; warnings: string[] } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: '顶层必须是对象' };
  const out: HiveSettings = {};
  const warnings: string[] = [];

  if (raw['mcp'] !== undefined) {
    const m = raw['mcp'];
    if (!isPlainObject(m)) return { ok: false, reason: 'mcp 必须是对象' };
    const servers: Record<string, McpServerConfig> = {};
    if (m['servers'] !== undefined) {
      if (!isPlainObject(m['servers'])) return { ok: false, reason: 'mcp.servers 必须是对象' };
      for (const [name, s] of Object.entries(m['servers'])) {
        if (!isPlainObject(s)) return { ok: false, reason: `mcp.servers.${name} 必须是对象` };
        const command = typeof s['command'] === 'string' ? s['command'].trim() : '';
        if (!command) return { ok: false, reason: `mcp.servers.${name}.command 必须是非空字符串` };
        if (s['args'] !== undefined && !isStringArray(s['args'])) {
          return { ok: false, reason: `mcp.servers.${name}.args 必须是字符串数组` };
        }
        if (s['env'] !== undefined) {
          if (!isPlainObject(s['env'])) return { ok: false, reason: `mcp.servers.${name}.env 必须是对象` };
          if (!Object.values(s['env']).every((v) => typeof v === 'string')) {
            return { ok: false, reason: `mcp.servers.${name}.env 的值必须是字符串` };
          }
        }
        if (s['cwd'] !== undefined && typeof s['cwd'] !== 'string') {
          return { ok: false, reason: `mcp.servers.${name}.cwd 必须是字符串` };
        }
        servers[name] = {
          command,
          ...(Array.isArray(s['args']) ? { args: s['args'] as string[] } : {}),
          ...(isPlainObject(s['env']) ? { env: s['env'] as Record<string, string> } : {}),
          ...(typeof s['cwd'] === 'string' && s['cwd'].trim() ? { cwd: s['cwd'].trim() } : {}),
        };
      }
    }
    let agents = ['A'];
    if (m['agents'] !== undefined) {
      if (!isStringArray(m['agents'])) return { ok: false, reason: 'mcp.agents 必须是字符串数组' };
      agents = m['agents'];
    }
    let allowServers: string[] = [];
    if (m['allowServers'] !== undefined) {
      if (!isStringArray(m['allowServers'])) return { ok: false, reason: 'mcp.allowServers 必须是字符串数组' };
      allowServers = m['allowServers'];
    }
    if (Object.keys(servers).length && allowServers.length === 0) {
      warnings.push('mcp.servers 配了，但 mcp.allowServers 为空 —— 工具会装、调用会被 policy 拒');
    }
    out.mcp = { servers, agents, allowServers };
  }

  if (raw['price'] !== undefined) {
    const p = parsePriceOverlay(JSON.stringify(raw['price']));
    if (!p.ok) return { ok: false, reason: `price: ${p.reason}` };
    out.price = p.value;
  }

  return { ok: true, value: out, warnings };
}

/** 读配置文件；不存在时返回空配置（source='default'），不报错。 */
export function loadSettings(path = settingsPath()): LoadedSettings {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return { spec: {}, path: abs, source: 'default', warnings: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      spec: {},
      path: abs,
      source: 'default',
      warnings: [`[${path} 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）—— 整份忽略]`],
    };
  }

  const p = parseSettings(raw);
  if (!p.ok) {
    return {
      spec: {},
      path: abs,
      source: 'default',
      warnings: [`[${path} 写坏了：${p.reason} —— 整份忽略]`],
    };
  }
  return { spec: p.value, path: abs, source: 'file', warnings: p.warnings };
}
