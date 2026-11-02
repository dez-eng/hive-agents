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
import { setMcpAllowServers, setNetAllowDomains } from './core/policy.js';
import { loadSettings } from './core/settings.js';
import { activateSkills, scanSkills } from './core/skill.js';
import { activateWeb } from './core/web.js';
import {
  appendTranscript,
  ensurePrivacyDir,
  launchPrivacyWindow,
  launchTuiWindow,
  privacyPaths,
  privacySupported,
  privacyWindowReady,
  readInbox,
  resetPrivacySession,
  tuiChildArgs,
  windowClosed,
  writeBridgeScript,
} from './core/privacy.js';
import { DEFAULT_AGENT, DEFAULT_MODULE, getAgent, getModule } from './core/modules.js';
import { parse, resolveAs } from './core/args.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
  ${APP_NAME} privacy              隐私模式：对话只显示在防录屏窗口里（Windows）
  ${APP_NAME} --as B run <问题>    以 B 身份单轮
  ${APP_NAME} init                 生成 .env.example / .hive/policy.json / hive.config.example.json
  ${APP_NAME} doctor               环境自检
  ${APP_NAME} --version            版本
  ${APP_NAME} --help               这份帮助

会话里敲 /help 看命令。`;

/**
 * 启动时问一次：正常终端还是隐私窗口。
 * 只在交互式终端里调用；**必须输入 1 或 2**，直接回车不会被当成默认值。
 */
async function askStartMode(): Promise<'repl' | 'privacy'> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      '\n' +
        '  启动方式\n' +
        '    1) 正常终端\n' +
        '    2) 隐私窗口 —— 防录屏（OBS / 腾讯会议共享看不到内容），功能与正常终端完全一致\n' +
        '\n',
    );
    for (;;) {
      const ans = (await rl.question('  选择 [1/2]：')).trim();
      if (ans === '1') return 'repl';
      if (ans === '2') return 'privacy';
      process.stdout.write('  请输入 1 或 2。\n');
    }
  } finally {
    rl.close();
  }
}

/** 隐私窗口里要跑的入口脚本：编译产物优先（tsx 开发时 nod 跑不了 .ts） */
function privacyEntry(): string {
  const a1 = process.argv[1] ? resolve(process.argv[1]) : '';
  if (a1 && !a1.endsWith('.ts')) return a1;
  const built = resolve(process.cwd(), 'dist/cli.js');
  return existsSync(built) ? built : a1;
}

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

  const parsedArgs = parse(process.argv.slice(2));
  if (parsedArgs.privacyChild) process.env.HIVE_PRIVACY_CHILD = '1';
  const rest = parsedArgs.rest;
  const as = parsedArgs.as;
  const cont = parsedArgs.cont;
  let mode = parsedArgs.mode;

  // v4：交互式启动先问一次「正常窗口 / 隐私窗口」。
  // 脚本、管道、HIVE_NO_ASK=1 都不问 —— 自动化的行为不能被一次提问改变。
  if (mode === 'repl' && process.stdin.isTTY && !process.env.HIVE_NO_ASK) {
    mode = await askStartMode();
  }

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

  // v4 M4.2b：skill 清单在启动时冻结（与 MCP 同一条自律）。
  // 必须在 buildContext 之前 —— load_skill 这件工具进的是身份的工具集。
  const skillsCfg = settings.spec.skills;
  if (skillsCfg) {
    const scan = scanSkills(skillsCfg.dir);
    for (const w of scan.warnings) process.stderr.write(`${w}\n`);
    activateSkills(scan, skillsCfg.agents);
  }

  // v4 M4.2b 剩余项：web_fetch 只在配了 web 段时注册（没配 = 0 工具 = 0 token）。
  // 白名单并入 policy；HIVE_POLICY_NET 设了就以 env 为准（与 mcp.allowServers 同一条）。
  const webCfg = settings.spec.web;
  if (webCfg) {
    if (webCfg.allowDomains.length && !(process.env.HIVE_POLICY_NET ?? '').trim()) {
      setNetAllowDomains(webCfg.allowDomains);
    }
    activateWeb(webCfg.agents);
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

  // 隐私模式：对话只进防录屏窗口（WDA_EXCLUDEFROMCAPTURE）。
  // v4.5 默认把**完整的 hive 终端**搬进窗口（xterm + ConPTY），斜杠命令、工具输出、
  // 流式回复都在；`hive privacy --classic` 回退到旧的自绘聊天窗。
  if (mode === 'privacy') {
    if (!privacySupported()) {
      process.stderr.write('[隐私模式只支持 Windows：WDA_EXCLUDEFROMCAPTURE 是 Win32 API]\n');
      await mcp?.close();
      return 2;
    }

    const paths = privacyPaths();

    if (!rest.includes('--classic')) {
      const ready = privacyWindowReady();
      if (!ready.ok) {
        process.stderr.write(`[隐私模式] ${ready.reason}\n`);
        process.stderr.write('           privacy-window/ 不完整：重新拉仓库，或确认它没被 .gitignore 掉。\n');
        await mcp?.close();
        return 2;
      }
      const win = await launchTuiWindow(paths, {
        command: process.execPath,
        args: tuiChildArgs(privacyEntry(), ra.as),
        workDir: process.cwd(),
        title: 'hive - privacy mode',
      });
      if (!win.ok) {
        process.stderr.write(`[隐私模式] 窗口启动失败：${win.reason}\n`);
        if (win.logHint) process.stderr.write(`           窗口日志：${win.logHint}\n`);
        process.stderr.write('           常见原因：缺 pywinpty / WebView2 运行时 / 端口被占。\n');
        await mcp?.close();
        return 2;
      }
      if (win.warning) process.stderr.write(`[隐私模式] ${win.warning}\n`);
      if (win.excluded === false) {
        process.stderr.write('[隐私模式] 注意：窗口没有确认防录屏（HIVE_PRIVACY_NO_PROTECT=1？）\n');
      }
      process.stdout.write(
        '[隐私模式] 已打开防录屏窗口（后台运行，任务栏和 Alt+Tab 里都没有它）\n' +
          '           窗口里是完整的 hive（工具调用 / 斜杠命令 / 模型切换都在）。\n' +
          '           Ctrl+Alt+P 显示/隐藏   Ctrl+Alt+R 重启终端   Ctrl+Alt+Q 退出\n' +
          `           状态：${paths.status}\n` +
          '           这个终端里不会出现对话内容，可以最小化或直接关掉。\n',
      );
      await mcp?.close();
      return 0;
    }

    // ---- classic：文件桥接 + 自绘聊天窗（对话可见，但没有工具输出） ----
    ensurePrivacyDir(paths);
    resetPrivacySession(paths);
    writeBridgeScript(paths);
    appendTranscript(paths, 'status', 'privacy session started');
    const child = launchPrivacyWindow(paths);
    process.stdout.write(
      '[隐私模式] 窗口已打开（Ctrl+Alt+P 召唤 / Ctrl+Enter 发送）\n' +
        '           对话只写进窗口，终端不显示；关闭窗口或 Ctrl+C 退出。\n' +
        '           这个会话走完整的 hive agent：fs / shell / web / MCP / skill 都可用，\n' +
        '           但受 .hive/policy.json 约束 —— CTF 要跑命令时把命令加进 exec.allowCommands。\n',
    );

    const { ctx } = buildContext(ra.as ? { as: ra.as, thread: thread! } : { thread: 'privacy' });
    const mod = getModule(ra.as ? getAgent(ra.as)!.home : DEFAULT_MODULE) ?? getModule(DEFAULT_MODULE)!;
    const who = ra.as ?? DEFAULT_AGENT;

    let lastSeq = 0;
    let running = true;
    const stop = (): void => {
      running = false;
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    while (running) {
      await new Promise((r) => setTimeout(r, 250));
      if (windowClosed(paths)) break;

      const box = readInbox(paths);
      if (!box || box.seq <= lastSeq) continue;
      lastSeq = box.seq;

      const text = box.text.trim();
      if (!text) continue;

      appendTranscript(paths, 'you', text);
      try {
        const res = await ctx.agent.run({
          text,
          threadId: ctx.state.thread,
          module: mod,
          tail: ctx.state.tail,
          agent: who,
          ledger: ctx.ledger,
          budgetTokens: turnBudget(),
        });
        appendTranscript(paths, 'ai', res.text || '（无可见输出）');
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
          // 隐私：正文不落账本
          userHead: '[privacy]',
          outHead: '',
          styleOn: ctx.state.tail ? 1 : 0,
          band: res.meter.band,
          agent: who,
        });
      } catch (e) {
        appendTranscript(paths, 'error', e instanceof Error ? e.message : String(e));
      }
    }

    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
    process.stdout.write('[隐私模式] 已退出（记录留在 .hive/privacy/transcript.txt）\n');
    await mcp?.close();
    return 0;
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
