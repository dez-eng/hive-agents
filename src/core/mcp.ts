/**
 * MCP client（v4 M4.2，拍板：MCP 优先）。
 *
 * 做三件事：
 *   1. 按 `hive.config.json` 的 `mcp.servers` 起 stdio 子进程并握手
 *   2. 把 server 的 `listTools()` 结果包装成 LangChain 工具（`mcp__server__tool`）
 *   3. 装进 capability 注册表 —— 之后 `toolsFor(agent)` 自然会带上
 *
 * 三条自律：
 *   · **启动时一次性冻结清单**：运行中不热插拔，否则工具 schema 变了、前缀缓存
 *     却还以为没变。要换 server → 重启（或以后的 /mcp reload）
 *   · **连接失败不阻塞**：一个 server 挂了，hive 照常启动，只报一条警告
 *   · **工具不等于权限**：装进来只是「有这件工具」，能不能调由 policy 的
 *     `mcp.allowServers` 判（默认空 = 全拒）
 */
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  enableMcpFor,
  mcpToolName,
  registerMcpTools,
  type AnyTool,
} from './capability.js';
import { VERSION } from './config.js';
import type { McpServerConfig } from './settings.js';

export interface McpServerStatus {
  name: string;
  tools: number;
  error?: string;
}

export interface McpConnection {
  servers: McpServerStatus[];
  tools: AnyTool[];
  close: () => Promise<void>;
}

/**
 * JSON Schema → zod。只覆盖 MCP 工具参数里常见的几种形状；
 * 认不出的类型落到 `z.unknown()`（宁可让模型多给一个参数，也别拒绝整个工具）。
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.unknown();
  const s = schema as Record<string, unknown>;
  const desc = typeof s['description'] === 'string' ? s['description'] : undefined;
  const wrap = (v: z.ZodTypeAny): z.ZodTypeAny => (desc ? v.describe(desc) : v);

  switch (s['type']) {
    case 'object': {
      const props = (s['properties'] ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s['required']) ? (s['required'] as string[]) : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [k, v] of Object.entries(props)) {
        const zk = jsonSchemaToZod(v);
        shape[k] = required.has(k) ? zk : zk.optional();
      }
      // passthrough：MCP server 自己可能接受 schema 里没写的参数，别在这里吞掉
      return wrap(z.object(shape).passthrough());
    }
    case 'array':
      return wrap(z.array(jsonSchemaToZod(s['items'])));
    case 'string': {
      if (Array.isArray(s['enum'])) {
        const vals = (s['enum'] as unknown[]).map(String);
        if (vals.length) return wrap(z.enum(vals as [string, ...string[]]));
      }
      return wrap(z.string());
    }
    case 'integer':
      return wrap(z.number().int());
    case 'number':
      return wrap(z.number());
    case 'boolean':
      return wrap(z.boolean());
    case 'null':
      return z.null();
    default: {
      if (Array.isArray(s['enum'])) {
        const vals = (s['enum'] as unknown[]).filter((x): x is string => typeof x === 'string');
        if (vals.length) return wrap(z.enum(vals as [string, ...string[]]));
      }
      return wrap(z.unknown());
    }
  }
}

/** 把 MCP 的 content 数组压成给模型看的文本 */
function contentText(res: { content?: unknown; isError?: boolean }): string {
  const blocks = Array.isArray(res.content) ? res.content : [];
  const text = blocks
    .map((b) => {
      const block = b as { type?: string; text?: string };
      return block.type === 'text' ? (block.text ?? '') : `[${block.type ?? 'unknown'}]`;
    })
    .join('\n')
    .trim();
  if (res.isError) return `ERROR: ${text || 'MCP 工具返回错误'}`;
  return text || '(无文本输出)';
}

/** 把一个 MCP tool 包成 LangChain 工具 */
function wrapMcpTool(client: Client, server: string, t: McpTool): AnyTool {
  const name = mcpToolName(server, t.name);
  const schema = jsonSchemaToZod(t.inputSchema) as z.ZodObject<z.ZodRawShape>;
  return tool(
    async (args): Promise<string> => {
      try {
        const res = await client.callTool({
          name: t.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });
        return contentText(res as { content?: unknown; isError?: boolean });
      } catch (e) {
        return `ERROR: MCP ${server}/${t.name} 调用失败 —— ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name,
      description: t.description ?? `MCP server ${server} 提供的工具 ${t.name}`,
      schema,
    },
  ) as StructuredToolInterface;
}

export interface ConnectMcpOptions {
  /** 警告出口（连不上、工具列表失败）；默认写 stderr */
  onWarn?: (msg: string) => void;
}

/**
 * 连接所有配置里的 server。**永不抛**：单个失败只进 status.error。
 * 返回的 close 要在进程退出前调用（REPL 退出 / beforeExit）。
 */
export async function connectMcp(
  servers: Record<string, McpServerConfig>,
  opts: ConnectMcpOptions = {},
): Promise<McpConnection> {
  const clients: Client[] = [];
  const tools: AnyTool[] = [];
  const status: McpServerStatus[] = [];
  const warn = opts.onWarn ?? ((m: string) => process.stderr.write(`${m}\n`));

  for (const [name, cfg] of Object.entries(servers)) {
    const client = new Client({ name: 'hive', version: VERSION }, { capabilities: {} });
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.env ? { env: cfg.env } : {}),
        ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
        // server 的 stderr 不直接倒进 REPL；失败原因从异常里拿
        stderr: 'pipe',
      });
      await client.connect(transport);
      const listed = await client.listTools();
      const list = listed.tools ?? [];
      for (const t of list) tools.push(wrapMcpTool(client, name, t));
      clients.push(client);
      status.push({ name, tools: list.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      status.push({ name, tools: 0, error: msg });
      warn(`[MCP ${name} 连接失败：${msg}]`);
      try {
        await client.close();
      } catch {
        /* 已经断了 */
      }
    }
  }

  return {
    servers: status,
    tools,
    close: async () => {
      for (const c of clients) {
        try {
          await c.close();
        } catch {
          /* 退出路径上不制造新错误 */
        }
      }
    },
  };
}

/** 连接 + 注册 + 给身份开能力。返回启用的身份。 */
export function activateMcp(conn: McpConnection, agents: string[] = ['A']): string[] {
  registerMcpTools(conn.tools);
  return enableMcpFor(agents);
}

/** 给 /doctor 与 /mcp 看的进程级摘要 */
export interface McpSummary {
  path: string;
  source: 'file' | 'default';
  servers: McpServerStatus[];
  tools: number;
  agents: string[];
}

let summary: McpSummary | null = null;

export function setMcpSummary(s: McpSummary | null): void {
  summary = s;
}

export function mcpSummary(): McpSummary | null {
  return summary;
}
