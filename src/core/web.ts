/**
 * web fetch（v4 M4.2b 剩余项，设计见 docs/V4-M4.2B-WEB-DESIGN.md）。
 *
 * 一句话：只读、只 GET、只去白名单域名的取网页工具。
 *
 * 四条自律：
 *   · **白名单**：域名必须在 policy 的 `net.allowDomains` 里（工具层与网关同源）
 *   · **只拿文本**：HTML/JSON/XML 之外的响应只回元信息，不把二进制塞进上下文
 *   · **有上限**：字节数、超时、重定向跳数都有硬顶 —— 工具结果是全价未命中
 *   · **不猜**：任何一项不满足就明确拒绝并说原因，不静默降级
 *
 * 工具 schema 是**前缀**的一部分（按身份装配）；抓到的正文只进本轮的
 * ToolMessage，不进 system 前缀。没配 `web` 段 = 0 工具 = 0 token。
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import { registerCapabilityTools, type AnyTool } from './capability.js';
import { AGENTS, type AgentId } from './modules.js';
import { currentSpec, domainAllowed } from './policy.js';

export const WEB_TOOL = 'web_fetch';

/** 单次抓取上限：2 MiB。约 50 万 token 的原始字节，必须截断 */
export const DEFAULT_WEB_MAX_BYTES = 2 * 1024 * 1024;
/** 整条重定向链共用一个超时 */
export const DEFAULT_WEB_TIMEOUT_MS = 15_000;
export const DEFAULT_WEB_REDIRECTS = 5;

export function webMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt((env['HIVE_WEB_MAX_BYTES'] ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEB_MAX_BYTES;
}

export function webTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt((env['HIVE_WEB_TIMEOUT_MS'] ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEB_TIMEOUT_MS;
}

export function webMaxRedirects(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt((env['HIVE_WEB_MAX_REDIRECTS'] ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WEB_REDIRECTS;
}

// ── URL 与地址检查 ──────────────────────────────────────────────────

export type ParsedUrl = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * 只收 http/https、默认端口、不带 userinfo、不直接访问 IP。
 * 末尾点归一化（`example.com.` 与 `example.com` 是同一个域）。
 */
export function parseFetchUrl(raw: string): ParsedUrl {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, reason: 'URL 为空' };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `不是合法 URL：${text}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只支持 http/https（给的是 ${url.protocol}）` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URL 不能带用户名/密码' };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'URL 没有主机名' };

  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(bare)) {
    return { ok: false, reason: `不允许直接访问 IP（${bare}）—— 用域名` };
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const okPort = (url.protocol === 'https:' && port === 443) || (url.protocol === 'http:' && port === 80);
  if (!okPort) {
    return { ok: false, reason: `只允许默认端口（http 80 / https 443），给的是 ${port}` };
  }

  url.hostname = host;
  return { ok: true, url };
}

/**
 * 私网 / 回环 / 链路本地 / 组播 / 保留段。**解析不出来的按危险处理**。
 * 只覆盖常用段，不追求成为完整 IP 分类库 —— 目的是挡住「白名单域名解析到内网」。
 */
export function isPrivateAddress(ip: string): boolean {
  const s = (ip ?? '').trim().toLowerCase();
  if (!s) return true;

  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice('::ffff:'.length));
    // fc00::/7（唯一本地）与 fe80::/10（链路本地）
    if (s.startsWith('fc') || s.startsWith('fd')) return true;
    if (/^fe[89ab][0-9a-f]:/.test(s)) return true;
    return false;
  }

  const parts = s.split('.');
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = -1, b = -1] = nums;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播 + 保留
  return false;
}

async function defaultLookup(host: string): Promise<string[]> {
  const rows = await dnsLookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}

/** 目标能不能去：白名单 → IP 字面量 → DNS 解析结果全都要过 */
async function targetProblem(
  url: URL,
  allow: string[],
  lookupHost: (host: string) => Promise<string[]>,
): Promise<string | null> {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!domainAllowed(host, allow)) {
    return `域名 ${host} 不在 net.allowDomains（${allow.join(',') || '空'}）`;
  }
  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(bare)) return `不允许直接访问 IP（${bare}）`;

  let addrs: string[];
  try {
    addrs = await lookupHost(host);
  } catch (e) {
    return `解析不了 ${host}（${e instanceof Error ? e.message : String(e)}）`;
  }
  if (!addrs.length) return `解析不了 ${host}`;
  for (const a of addrs) {
    if (isPrivateAddress(a)) return `${host} 解析到内网地址 ${a} —— 拒绝`;
  }
  return null;
}

// ── 响应读取 ────────────────────────────────────────────────────────

/** 只读文本类：text/*、JSON、XML；空 content-type 按文本试一次 */
export function isTextual(contentType: string): boolean {
  const t = (contentType || '').split(';')[0]!.trim().toLowerCase();
  if (!t) return true;
  return (
    t.startsWith('text/') ||
    t === 'application/json' ||
    t.endsWith('+json') ||
    t === 'application/xml' ||
    t.endsWith('+xml') ||
    t === 'application/javascript' ||
    t === 'application/x-www-form-urlencoded'
  );
}

export interface CappedRead {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** 按字节上限读流；超限就取消读取并标注。读流出错时返回已读到的部分 */
export async function readCapped(resp: Response, maxBytes: number): Promise<CappedRead> {
  if (!resp.body) {
    const t = await resp.text();
    const bytes = Buffer.byteLength(t, 'utf8');
    return { text: t.slice(0, maxBytes), bytes: Math.min(bytes, maxBytes), truncated: bytes > maxBytes };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        const keep = value.byteLength - (bytes - maxBytes);
        if (keep > 0) text += decoder.decode(value.subarray(0, keep), { stream: true });
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    if (!truncated) text += decoder.decode();
  } catch {
    /* 读到一半断了：已经读到的部分仍然有价值 */
  }

  return { text, bytes: Math.min(bytes, maxBytes), truncated };
}

// ── 抓取 ────────────────────────────────────────────────────────────

export interface FetchDeps {
  /** 测试注入；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 测试注入；默认 node:dns 的 lookup */
  lookupHost?: (host: string) => Promise<string[]>;
  /** 默认取 policy 的 net.allowDomains */
  allowDomains?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const name = e.name === 'TimeoutError' ? '超时' : e.name;
    return e.message ? `${name}: ${e.message}` : name;
  }
  return String(e);
}

/**
 * 抓一个 URL，返回给模型看的纯文本。**不抛异常** —— 任何失败都变成 `ERROR: …`，
 * 与其它工具一致（模型看到字符串，不会让整轮炸掉）。
 */
export async function fetchUrlText(raw: string, deps: FetchDeps = {}): Promise<string> {
  const allow = deps.allowDomains ?? currentSpec().net.allowDomains;
  const maxBytes = deps.maxBytes ?? webMaxBytes();
  const timeoutMs = deps.timeoutMs ?? webTimeoutMs();
  const maxRedirects = deps.maxRedirects ?? webMaxRedirects();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookupHost = deps.lookupHost ?? defaultLookup;

  const parsed = parseFetchUrl(raw);
  if (!parsed.ok) return `ERROR: ${parsed.reason}`;

  let current = parsed.url;
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const bad = await targetProblem(current, allow, lookupHost);
    if (bad) return `ERROR: ${bad}`;

    let resp: Response;
    try {
      resp = await fetchImpl(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          accept: 'text/html,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1',
          'user-agent': 'hive/0.1 (+web_fetch)',
        },
      });
    } catch (e) {
      return `ERROR: 请求失败（${errText(e)}）`;
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      await resp.body?.cancel().catch(() => {});
      if (!loc) return `ERROR: ${resp.status} 重定向没有 Location`;
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return `ERROR: 重定向 Location 不合法：${loc}`;
      }
      const np = parseFetchUrl(next.toString());
      if (!np.ok) return `ERROR: 重定向目标被拒：${np.reason}`;
      current = np.url;
      continue;
    }

    const ct = resp.headers.get('content-type') ?? '';
    if (!isTextual(ct)) {
      const len = resp.headers.get('content-length');
      await resp.body?.cancel().catch(() => {});
      return [
        `URL: ${current.toString()}`,
        `状态: ${resp.status}`,
        `类型: ${ct || '（未声明）'}`,
        `字节: ${len ?? '未知'}`,
        '正文: 非文本类型，未读取',
      ].join('\n');
    }

    const read = await readCapped(resp, maxBytes);
    return [
      `URL: ${current.toString()}`,
      `状态: ${resp.status}`,
      `类型: ${ct || '（未声明）'}`,
      `字节: ${read.bytes}${read.truncated ? `（超过上限 ${maxBytes}，已截断）` : ''}`,
      '正文:',
      read.text,
    ].join('\n');
  }

  return `ERROR: 重定向超过 ${maxRedirects} 次`;
}

// ── 工具与装配 ──────────────────────────────────────────────────────

export const webFetchTool = tool(
  async ({ url }: { url: string }): Promise<string> => fetchUrlText(url),
  {
    name: WEB_TOOL,
    description:
      'GET 一个 http(s) 地址，只允许 policy 的 net.allowDomains 里的域名。只读文本（HTML/JSON/XML），有字节上限；不跟随白名单外的跳转。',
    schema: z.object({ url: z.string().describe('完整 URL，例如 https://example.com/page') }),
  },
) as StructuredToolInterface;

// ── 装配（与 skill / mcp 同一个模式）────────────────────────────────

export interface WebSummary {
  allowDomains: string[];
  /** 哪些身份装了 `web_fetch` */
  agents: string[];
}

let summary: WebSummary | null = null;

export function setWebSummary(s: WebSummary | null): void {
  summary = s;
}

export function webSummary(): WebSummary | null {
  return summary;
}

/** 给指定身份打开 web 能力（只加 capability，工具集由 toolsFor 装配） */
export function enableWebFor(agents: string[]): string[] {
  const enabled: string[] = [];
  for (const raw of agents) {
    const id = raw.trim().toUpperCase() as AgentId;
    if (!(id in AGENTS)) continue;
    if (!AGENTS[id].capabilities.includes('web')) AGENTS[id].capabilities.push('web');
    enabled.push(id);
  }
  return enabled;
}

/**
 * 启动装配：注册工具 + 给身份开能力。
 * 只在 `hive.config.json` 有 `web` 段时调用 —— 没配 = 0 工具 = 0 token。
 * 白名单以**当前 policy** 为准（调用方应先把 config 的 allowDomains 并入 policy）。
 */
export function activateWeb(agents: string[] = ['A']): string[] {
  registerCapabilityTools('web', [webFetchTool]);
  const enabled = enableWebFor(agents);
  setWebSummary({ allowDomains: [...currentSpec().net.allowDomains], agents: enabled });
  return enabled;
}

/** 测试 / 嵌入用：把 web capability 清回「未装配」 */
export function resetWebForTest(): void {
  registerCapabilityTools('web', [] as AnyTool[]);
  setWebSummary(null);
}
