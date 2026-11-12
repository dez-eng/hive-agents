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

import { APP_NAME, VERSION, envFiles, hasApiKey, loadDotEnv, toolSteps, turnBudget } from './core/config.js';
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
import { red } from './ui/format.js';
import { openUiSinkFromEnv } from './core/uievents.js';

const USAGE = `${APP_NAME} ${VERSION} —— 缓存友好型 agent CLI
用法：
  ${APP_NAME}                      进入交互会话（主控 A）
  ${APP_NAME} --as <A|B|C|D>       以某个 agent 的身份独立启动（会话可续）
  ${APP_NAME} --continue           续上一次独立会话（独立会话本就可续，这只是一个显式说法）
  ${APP_NAME} run <问题>           单轮问答（脚本用），结果写 stdout
  ${APP_NAME} privacy              隐私模式：对话只显示在防录屏窗口里（Windows）
  ${APP_NAME} window               普通窗口界面：同一套对话流，不防录屏（Windows）
  ${APP_NAME} --as B run <问题>    以 B 身份单轮
  ${APP_NAME} init                 生成 .env.example / .hive/policy.json / hive.config.example.json
  ${APP_NAME} doctor               环境自检
  ${APP_NAME} --version            版本
  ${APP_NAME} --help               这份帮助

会话里敲 /help 看命令。`;

/**
 * 启动时问一次：窗口界面 / 隐私窗口 / 纯终端。
 * 只在交互式终端里调用；**必须输入 1/2/3**，直接回车不会被当成默认值。
 */
async function askStartMode(): Promise<'window' | 'privacy' | 'repl'> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      '\n' +
        '  启动方式\n' +
        '    1) 窗口界面 —— 对话流 + 思考 + 指标栏（不防录屏）\n' +
        '    2) 隐私窗口 —— 同样的界面，且防录屏（OBS / 腾讯会议共享看不到内容）\n' +
        '    3) 纯终端 —— 原样 REPL（脚本 / SSH / 窗口起不来时用）\n' +
        '\n',
    );
    for (;;) {
      const ans = (await rl.question('  选择 [1/2/3]：')).trim();
      if (ans === '1') return 'window';
      if (ans === '2') return 'privacy';
      if (ans === '3') return 'repl';
      process.stdout.write('  请输入 1、2 或 3。\n');
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
  // --privacy-child：窗口里那一份 hive 必须跳过启动菜单，否则会在窗口里再问一次
  const privacyChild = parsedArgs.privacyChild || process.env.HIVE_PRIVACY_CHILD === '1';
  if (privacyChild) process.env.HIVE_PRIVACY_CHILD = '1';
  // 账本脱敏是「隐私窗口」独有的：普通窗口（对话流界面但不防录屏）照常记正文，
  // 否则 /cost、/sessions 里全是 [privacy]，正常用起来反而更难受。
  if (parsedArgs.redact) process.env.HIVE_PRIVACY_REDACT = '1';
  // --ui-events：窗口右栏的事件通道。走环境变量是为了让 agent / repl 随处能取到，
  // 而 argv 里必须带 —— 窗口进程链（ps → C# → python → node）不继承原始终端的环境。
  if (parsedArgs.uiEvents) process.env.HIVE_UI_EVENTS = parsedArgs.uiEvents;
  const uiSink = openUiSinkFromEnv();
  // 退出前把缓冲区刷出去：40ms 合批的最后几条（turn_end / gist）不能丢在内存里
  if (uiSink) process.on('exit', () => uiSink.flush());
  const rest = parsedArgs.rest;
  const as = parsedArgs.as;
  const cont = parsedArgs.cont;
  let mode = parsedArgs.mode;

  // v4：交互式启动先问一次「正常窗口 / 隐私窗口」。
  // 脚本、管道、HIVE_NO_ASK=1 都不问 —— 自动化的行为不能被一次提问改变。
  if (mode === 'repl' && process.stdin.isTTY && !privacyChild && !process.env.HIVE_NO_ASK) {
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

  // 没有 key 时不要继续构造 agent：ChatDeepSeek 会在 buildContext 里直接抛异常，
  // 用户看到的是一段 stack，而不是「缺什么、去哪里配」。
  if (!hasApiKey()) {
    process.stderr.write(
      `[${APP_NAME}] 还没设 DEEPSEEK_API_KEY。\n` +
        `        已查找：${envFiles().join('、')}\n` +
        `        把 .env.example 复制成 .env 填上，或 set DEEPSEEK_API_KEY=sk-...\n`,
    );
    return 2;
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

  // 窗口界面：对话流 + 思考 + 指标栏。两种用法共用同一套窗口模板 ——
  //   2) 隐私窗口：额外设 WDA_EXCLUDEFROMCAPTURE（防录屏）+ 账本脱敏
  //   1) 窗口界面：不设 WDA、照常记账，就是个本地窗口版终端
  // `hive privacy` 仍直达隐私窗口；`hive privacy --classic` 是旧的自绘聊天窗。
  if (mode === 'privacy' || mode === 'window') {
    const isPrivacy = mode === 'privacy';

    // 普通窗口起不来不该拦住人：回退纯终端并说清原因。隐私窗口则必须报错 ——
    // 它的存在意义就是防录屏，静默降级成一个会被录进去的终端才是真问题。
    const fallback = async (why: string): Promise<number | null> => {
      if (isPrivacy) {
        process.stderr.write(`[隐私窗口] ${why}\n`);
        await mcp?.close();
        return 2;
      }
      process.stderr.write(`[窗口界面] ${why}\n`);
      process.stderr.write('[窗口界面] 已回退到纯终端。\n');
      return null;
    };

    if (!privacySupported()) {
      const failed = await fallback('窗口界面只支持 Windows（WinForms + WebView2 + WDA）');
      if (failed !== null) return failed;
      mode = 'repl';
    }

    if (mode === 'privacy' || mode === 'window') {
      const paths = privacyPaths();

      if (!(isPrivacy && rest.includes('--classic'))) {
        const ready = privacyWindowReady();
        if (!ready.ok) {
          const failed = await fallback(
            `${ready.reason}（privacy-window/ 不完整：重新拉仓库，或确认它没被 .gitignore 掉）`,
          );
          if (failed !== null) return failed;
          mode = 'repl';
        } else {
          const win = await launchTuiWindow(paths, {
            command: process.execPath,
            // 只有隐私窗口才带 --redact：普通窗口要正常记账本正文
            args: tuiChildArgs(privacyEntry(), ra.as, paths.events, isPrivacy),
            workDir: process.cwd(),
            title: isPrivacy ? 'hive - privacy mode' : 'hive',
            noProtect: !isPrivacy,
          });
          if (!win.ok) {
            const failed = await fallback(
              `窗口启动失败：${win.reason}` +
                (win.logHint ? `\n           窗口日志：${win.logHint}` : '') +
                '\n           常见原因：缺 pywinpty / WebView2 运行时 / 端口被占。',
            );
            if (failed !== null) return failed;
            mode = 'repl';
          } else {
            if (win.warning) process.stderr.write(`[窗口界面] ${win.warning}\n`);
            if (isPrivacy && win.excluded === false) {
              process.stderr.write('[隐私窗口] 注意：窗口没有确认防录屏（HIVE_PRIVACY_NO_PROTECT=1？）\n');
            }
            process.stdout.write(
              (isPrivacy
                ? '[隐私窗口] 已打开防录屏窗口'
                : '[窗口界面] 已打开窗口') +
                '（后台运行，任务栏和 Alt+Tab 里都没有它）\n' +
                '           界面是对话流：提问、思考、工具调用、markdown 回答都在上面，\n' +
                '           底部输入框，最下一行是模型 / 花费 / 上下文 / 命中缓存 / 余额。\n' +
                '           Ctrl+Alt+P 显示/隐藏   Ctrl+Alt+R 重启终端   Ctrl+Alt+Q 退出\n' +
                `           状态：${paths.status}\n` +
                '           这个终端里不会出现对话内容，可以最小化或直接关掉。\n',
            );
            await mcp?.close();
            return 0;
          }
        }
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
      } // 内层：窗口模式（classic 只有 `hive privacy --classic` 才走到）

    // ---- 到这里窗口模式结束 ----
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
