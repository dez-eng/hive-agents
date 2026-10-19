#!/usr/bin/env node
/**
 * hive 入口。
 *
 * 第一件事是把 node:sqlite 的实验性警告滤掉 —— 必须在任何模块加载
 * node:sqlite 之前，所以账本那边用 createRequire 延迟加载。
 *
 * v3：`--as <A|B|C|D>` 让任一 agent 独立启动 —— 它挂在自己的 thread
 * （`solo#<id>`）上，天然可续；不带 --as 时仍是主控 A 的 `main` 会话（见 docs/V3-PLAN.md §2）。
 */
import { silenceSqliteWarning } from './core/warn.js';

silenceSqliteWarning();

import { APP_NAME, VERSION, hasApiKey, loadDotEnv, modelName, toolSteps, turnBudget } from './core/config.js';
import { parsePriceOverlay, setPriceOverlay } from './core/cost.js';
import { classifyError } from './core/errors.js';
import { initFiles } from './core/init.js';
import { activateMcp, connectMcp, setMcpSummary, type McpConnection } from './core/mcp.js';
import { setMcpAllowServers } from './core/policy.js';
import { loadSettings } from './core/settings.js';
import { DEFAULT_AGENT, DEFAULT_MODULE, getAgent, getModule } from './core/modules.js';
import { parse, resolveAs } from './core/args.js';
import { soloThread } from './core/handoff.js';
import { COMMANDS, findCommand } from './commands.js';
import { buildContext, printFooter, startRepl } from './repl.js';
import { dim, gray, red } from './ui/format.js';

const USAGE = `${APP_NAME} ${VERSION} —— 缓存友好型 agent CLI

用法：
  ${APP_NAME}                      进入交互会话（主控 A）
  ${APP_NAME} --as <A|B|C|D>       以某个 agent 的身份独立启动（会话可续）
  ${APP_NAME} --continue           续上一次独立会话（独立会话本就可续，这只是一个显式说法）
  ${APP_NAME} run <问题>           单轮问答（脚本用），结果写 stdout
  ${APP_NAME} --as B run <问题>    以 B 身份单轮
  ${APP_NAME} init                 生成 .env.example / .hive/policy.json / hive.config.example.json
  ${APP_NAME} doctor               环境自检
  ${APP_NAME} --version            版本
  ${APP_NAME} --help               这份帮助

会话里敲 /help 看命令。`;

async function main(): Promise<number> {
  loadDotEnv();
  // v4 M4.2：配置文件（MCP / 价格）。写坏整份忽略，但要说清为什么
  const settings = loadSettings();
  for (const w of settings.warnings) process.stderr.write(`${w}\n`);

  // 价格：文件 < 环境变量（环境变量显式覆盖文件）
  if (settings.spec.price && Object.keys(settings.spec.price).length) {
    setPriceOverlay(settings.spec.price);
  }
  const price = parsePriceOverlay(process.env.HIVE_PRICE_JSON);
  if (price.ok) {
    if (Object.keys(price.value).length) {
      setPriceOverlay({ ...(settings.spec.price ?? {}), ...price.value });
    }
  } else {
    process.stderr.write(`[HIVE_PRICE_JSON 写坏了，退回内置价：${price.reason}]\n`);
  }

  const { mode, rest, as, cont } = parse(process.argv.slice(2));

  const ra = resolveAs(as);
  if (!ra.ok) {
    process.stderr.write(`[${ra.msg}]\n`);
    return 2;
  }

  // 独立会话挂 solo#<id>；不带 --as 时是主控的 main（v3 §2.3）
  const thread = ra.as ? soloThread(ra.as) : undefined;

  if (mode === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (mode === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // v4 M4.3：init 不需要 key / 不需要连 MCP —— 只生成模板
  if (mode === 'init') {
    const force = rest.includes('--force') || rest.includes('-f');
    const r = initFiles(process.cwd(), { force });
    process.stdout.write(`[${APP_NAME} init · ${process.cwd()}]\n`);
    for (const p of r.written) process.stdout.write(`  写入 ${p}\n`);
    for (const p of r.skipped) process.stdout.write(`  跳过 ${p}（已存在；--force 覆盖）\n`);
    process.stdout.write('下一步：把 .env.example 复制成 .env 填 key → hive doctor\n');
    return 0;
  }

  // v4 M4.2：MCP 在 help/version 之后连 —— 那两条命令不该被 server 拖慢。
  // 必须在 buildContext（new HiveAgent）之前：工具集在构造时按身份冻结。
  let mcp: McpConnection | null = null;
  const mcpCfg = settings.spec.mcp;
  if (mcpCfg && Object.keys(mcpCfg.servers).length) {
    mcp = await connectMcp(mcpCfg.servers);
    const enabled = activateMcp(mcp, mcpCfg.agents);
    if (mcpCfg.allowServers.length && !(process.env.HIVE_POLICY_MCP ?? '').trim()) {
      setMcpAllowServers(mcpCfg.allowServers);
    }
    setMcpSummary({
      path: settings.path,
      source: settings.source,
      servers: mcp.servers,
      tools: mcp.tools.length,
      agents: enabled,
    });
  }

  if (mode === 'doctor') {
    const { ctx } = buildContext(ra.as ? { as: ra.as } : {});
    const cmd = findCommand('/doctor')!;
    await cmd.run(ctx, []);
    await mcp?.close();
    return 0;
  }
  if (mode === 'run') {
    const text = rest.join(' ').trim();
    if (!text) {
      process.stderr.write('用法：hive run <问题>\n');
      return 2;
    }
    const { ctx } = buildContext(ra.as ? { as: ra.as, thread: thread! } : { thread: 'cli' });
    const mod = getModule(ra.as ? getAgent(ra.as)!.home : DEFAULT_MODULE) ?? getModule(DEFAULT_MODULE)!;
    try {
      const res = await ctx.agent.run(
        {
          text,
          threadId: ctx.state.thread,
          module: mod,
          tail: ctx.state.tail,
          // v3 M2：身份决定工具集与网关判据；账本给网关落判罚
          agent: ra.as ?? DEFAULT_AGENT,
          ledger: ctx.ledger,
          // v3 M2.5：单轮也上闸门（与 REPL 一致）
          budgetTokens: turnBudget(),
        },
        (piece) => process.stdout.write(piece),
      );
      process.stdout.write('\n');
      ctx.state.lastTurn = res.meter;
      ctx.state.lastDenied = res.denied;
      ctx.session.add(res.meter);
      // v3 M2.5：两道护栏触发时都说清「为什么停、怎么继续」
      if (res.budgetHit) {
        process.stderr.write(`[本轮熔断：超了 ${turnBudget()} token 上限 —— 说「继续」就接着跑]\n`);
      }
      const maxSteps = toolSteps();
      if (maxSteps > 0 && res.steps >= maxSteps) {
        process.stderr.write(`[本轮工具调用到上限 ${maxSteps} 批，已停下 —— 说「继续」就接着跑]\n`);
      }
      if (res.compacted) {
        process.stderr.write(`[历史已压缩：丢掉 ${res.compacted} 条旧消息 —— 这一次前缀要重算]\n`);
      }
      ctx.ledger.insert({
        kind: 'turn',
        threadId: ctx.state.thread,
        module: mod.id,
        calls: res.meter.calls,
        inTok: res.meter.inTok,
        cacheHit: res.meter.cacheHit,
        outTok: res.meter.outTok,
        reasoning: res.meter.reasoning,
        costUsd: res.meter.cost(),
        userChars: text.length,
        userHead: text,
        outHead: res.text,
        styleOn: ctx.state.tail ? 1 : 0,
        band: res.meter.band,
        agent: ra.as ?? DEFAULT_AGENT,
      });
      printFooter(ctx);
      await mcp?.close();
      return 0;
    } catch (e) {
      const c = classifyError(e);
      process.stderr.write(`[${c.title}] ${c.message}\n`);
      if (c.hint) process.stderr.write(`  ${c.hint}\n`);
      await mcp?.close();
      return c.kind === 'abort' ? 130 : 1;
    }
  }

  if (!hasApiKey()) {
    process.stdout.write(
      gray(`提示：还没设 DEEPSEEK_API_KEY —— 把 .env.example 复制成 .env 填上即可。\n`) +
        dim(`      模型 ${modelName()} · 命令 ${COMMANDS.length} 个\n\n`),
    );
  }
  // 独立会话挂在固定 thread 上，天然可续；--continue 只是把它说清楚
  void cont;
  await startRepl(ra.as ? { as: ra.as, thread: thread! } : {});
  await mcp?.close();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(red(`[${APP_NAME} 挂了] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`));
    process.exitCode = 1;
  });
