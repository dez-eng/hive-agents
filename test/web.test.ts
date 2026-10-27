/**
 * v4 M4.2b 剩余项 web fetch 的零 API 测试。
 *
 * 要证明四件事：
 *   1. URL 与地址：只 http/https、默认端口、不带 userinfo、不碰 IP / 私网
 *   2. 白名单：精确、`*.` 子域、`*`、大小写、末尾点；网关与工具同源
 *   3. 抓取：只读文本、有字节上限、重定向逐跳校验、失败变成 ERROR 字符串
 *   4. 装配：按身份装 `web_fetch`；没配 web 段 = 0 工具
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENTS } from '../src/core/modules.js';
import {
  declaredOnly,
  registerCapabilityTools,
  toolNamesFor,
} from '../src/core/capability.js';
import { DEFAULT_SPEC, checkAction, domainAllowed, setPolicySpec } from '../src/core/policy.js';
import { parseSettings } from '../src/core/settings.js';
import {
  WEB_TOOL,
  activateWeb,
  enableWebFor,
  fetchUrlText,
  isPrivateAddress,
  isTextual,
  parseFetchUrl,
  readCapped,
  setWebSummary,
  webFetchTool,
  webSummary,
} from '../src/core/web.js';

const lookupPublic = async (): Promise<string[]> => ['93.184.216.34'];
const lookupPrivate = async (): Promise<string[]> => ['127.0.0.1'];

const origCaps = Object.fromEntries(
  (Object.keys(AGENTS) as Array<keyof typeof AGENTS>).map((k) => [k, [...AGENTS[k].capabilities]]),
) as Record<keyof typeof AGENTS, string[]>;

function restore(): void {
  for (const k of Object.keys(AGENTS) as Array<keyof typeof AGENTS>) {
    AGENTS[k].capabilities = [...origCaps[k]] as typeof AGENTS[typeof k]['capabilities'];
  }
  registerCapabilityTools('web', []);
  setWebSummary(null);
  setPolicySpec(null);
}

test.after(restore);

// ── URL / 地址 ──────────────────────────────────────────────────────

test('URL：只收 http/https、默认端口、不带 userinfo；末尾点与大小写归一', () => {
  const ok = parseFetchUrl('https://Example.COM./a?q=1');
  assert.ok(ok.ok);
  assert.equal(ok.url.hostname, 'example.com');

  for (const bad of [
    'ftp://example.com/',
    'file:///etc/passwd',
    'https://user:pass@example.com/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'https://example.com:8443/',
    'not a url',
    '',
  ]) {
    assert.equal(parseFetchUrl(bad).ok, false, bad);
  }
});

test('白名单：精确、*. 子域、*、大小写、末尾点', () => {
  assert.equal(domainAllowed('example.com', ['example.com']), true);
  assert.equal(domainAllowed('EXAMPLE.com', ['example.COM']), true);
  assert.equal(domainAllowed('example.com.', ['example.com']), true);
  assert.equal(domainAllowed('api.example.com', ['example.com']), false);
  assert.equal(domainAllowed('api.example.com', ['*.example.com']), true);
  assert.equal(domainAllowed('example.com', ['*.example.com']), true);
  assert.equal(domainAllowed('badexample.com', ['*.example.com']), false);
  assert.equal(domainAllowed('anything.dev', ['*']), true);
  assert.equal(domainAllowed('anything.dev', []), false);
  assert.equal(domainAllowed('', ['*']), false);
});

test('私网：回环 / RFC1918 / 链路本地 / CGNAT / 组播 / IPv6 本地段都算', () => {
  for (const ip of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'not-an-ip',
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

// ── 配置 ────────────────────────────────────────────────────────────

test('settings：web.allowDomains / agents 解析，写坏给原因', () => {
  const ok = parseSettings({ web: { allowDomains: [' example.com ', ''], agents: ['B'] } });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.web, { allowDomains: ['example.com'], agents: ['B'] });

  const def = parseSettings({ web: {} });
  assert.ok(def.ok);
  assert.deepEqual(def.value.web?.allowDomains, []);
  assert.deepEqual(def.value.web?.agents, ['A']);
  assert.ok(def.warnings.some((w) => w.includes('allowDomains 为空')));

  assert.equal(parseSettings({ web: [] }).ok, false);
  assert.equal(parseSettings({ web: { allowDomains: 'example.com' } }).ok, false);
  assert.equal(parseSettings({ web: { agents: 'A' } }).ok, false);
});

// ── 抓取（注入 fake fetch / fake lookup，不联网）────────────────────

test('抓取：白名单外的域名直接拒绝，不发请求', async () => {
  let called = false;
  const out = await fetchUrlText('https://evil.com/', {
    allowDomains: ['example.com'],
    lookupHost: lookupPublic,
    fetchImpl: (async () => {
      called = true;
      return new Response('x');
    }) as unknown as typeof fetch,
  });
  assert.match(out, /不在 net\.allowDomains/);
  assert.equal(called, false);
});

test('抓取：域名解析到内网也拒绝', async () => {
  const out = await fetchUrlText('https://example.com/', {
    allowDomains: ['example.com'],
    lookupHost: lookupPrivate,
    fetchImpl: (async () => new Response('x')) as unknown as typeof fetch,
  });
  assert.match(out, /内网地址/);
});

test('抓取：200 文本返回状态、类型与正文', async () => {
  const out = await fetchUrlText('https://example.com/a', {
    allowDomains: ['example.com'],
    lookupHost: lookupPublic,
    fetchImpl: (async () =>
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })) as unknown as typeof fetch,
  });
  assert.match(out, /状态: 200/);
  assert.match(out, /text\/plain/);
  assert.match(out, /hello/);
});

test('抓取：超过字节上限截断并标注', async () => {
  const out = await fetchUrlText('https://example.com/big', {
    allowDomains: ['example.com'],
    lookupHost: lookupPublic,
    maxBytes: 4,
    fetchImpl: (async () =>
      new Response('0123456789', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch,
  });
  assert.match(out, /0123/);
  assert.doesNotMatch(out, /0123456789/);
  assert.match(out, /已截断/);
});

test('抓取：非文本类型只回元信息，不读正文', async () => {
  const out = await fetchUrlText('https://example.com/a.bin', {
    allowDomains: ['example.com'],
    lookupHost: lookupPublic,
    fetchImpl: (async () =>
      new Response('binary', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })) as unknown as typeof fetch,
  });
  assert.match(out, /非文本类型/);
  assert.doesNotMatch(out, /binary/);
});

test('抓取：重定向出白名单被拒', async () => {
  const out = await fetchUrlText('https://example.com/go', {
    allowDomains: ['example.com'],
    lookupHost: lookupPublic,
    fetchImpl: (async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.com/x' } })) as unknown as typeof fetch,
  });
  assert.match(out, /evil\.com/);
  assert.match(out, /不在 net\.allowDomains/);
});

test('抓取：重定向超过上限就停', async () => {
  const out = await fetchUrlText('https://example.com/loop', {
    allowDomains: ['example.com'],
    lookupHost: lookupPublic,
    maxRedirects: 1,
    fetchImpl: (async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/next' } })) as unknown as typeof fetch,
  });
  assert.match(out, /重定向超过 1 次/);
});

test('抓取：网络错误变成 ERROR 字符串，不抛异常', async () => {
  const out = await fetchUrlText('https://example.com/', {
    allowDomains: ['example.com'],
    lookupHost: lookupPublic,
    fetchImpl: (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch,
  });
  assert.match(out, /^ERROR: 请求失败/);
});

test('readCapped：按字节截断，bytes 不超过上限', async () => {
  const r = await readCapped(new Response('0123456789'), 4);
  assert.equal(r.truncated, true);
  assert.equal(r.text, '0123');
  assert.equal(r.bytes, 4);
});

test('isTextual：文本 / JSON / XML 读，二进制不读', () => {
  assert.equal(isTextual('text/html; charset=utf-8'), true);
  assert.equal(isTextual('application/json'), true);
  assert.equal(isTextual('application/ld+json'), true);
  assert.equal(isTextual('application/xml'), true);
  assert.equal(isTextual('image/png'), false);
  assert.equal(isTextual('application/pdf'), false);
  assert.equal(isTextual(''), true);
});

// ── 装配与网关 ──────────────────────────────────────────────────────

test('装配：只有 web.agents 里的身份装 web_fetch；declaredOnly 不含 web', () => {
  setPolicySpec({ ...DEFAULT_SPEC, net: { allowDomains: ['example.com'] } });
  const enabled = activateWeb(['B']);
  assert.deepEqual(enabled, ['B']);
  assert.equal(webFetchTool.name, WEB_TOOL);
  assert.ok(toolNamesFor('B').includes(WEB_TOOL));
  assert.ok(!toolNamesFor('A').includes(WEB_TOOL), 'A 没配就不该有这件工具');
  assert.deepEqual(webSummary(), { allowDomains: ['example.com'], agents: ['B'] });
  assert.ok(!declaredOnly().includes('web'));
});

test('装配：未知身份被忽略，不报错', () => {
  setPolicySpec({ ...DEFAULT_SPEC, net: { allowDomains: [] } });
  setWebSummary(null);
  assert.deepEqual(enableWebFor(['Z', 'a']), ['A']);
  assert.equal(webSummary(), null);
});

test('网关：net 按域名白名单判定，*. 通配同样生效', () => {
  setPolicySpec({
    ...DEFAULT_SPEC,
    agents: { ...DEFAULT_SPEC.agents, A: { 'net': 'allow' } },
    net: { allowDomains: ['*.example.com'] },
  });
  enableWebFor(['A']);
  const base = {
    kind: 'net' as const,
    by: 'A' as const,
    capability: 'web' as const,
    tool: WEB_TOOL,
    threadId: 'test',
  };
  assert.equal(checkAction({ ...base, target: 'api.example.com' }).allow, true);
  assert.equal(checkAction({ ...base, target: 'example.com' }).allow, true);
  assert.equal(checkAction({ ...base, target: 'evil.com' }).allow, false);
});
