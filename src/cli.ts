#!/usr/bin/env node
/**
 * hive 入口。
 *
 * 第一件事是把 node:sqlite 的实验性警告滤掉 —— 必须在任何模块加载
 * node:sqlite 之前，所以账本那边用 createRequire 延迟加载。
 */
import { silenceSqliteWarning } from './core/warn.js';

silenceSqliteWarning();

import { APP_NAME, VERSION, hasApiKey, loadDotEnv, modelName } from './core/config.js';
import { getModule, DEFAULT_MODULE } from './core/modules.js';
import { COMMANDS, findCommand } from './commands.js';
import { buildContext, printFooter, startRepl } from './repl.js';
import { dim, gray, red } from './ui/format.js';

const USAGE = `${APP_NAME} ${VERSION} —— 缓存友好型 agent CLI

用法：
  ${APP_NAME}                进入交互会话
  ${APP_NAME} run <问题>     单轮问答（脚本用），结果写 stdout
  ${APP_NAME} doctor         环境自检
  ${APP_NAME} --version      版本
  ${APP_NAME} --help         这份帮助

会话里敲 /help 看命令。`;

function parse(argv: string[]): { mode: string; rest: string[] } {
  const [first, ...rest] = argv;
  if (!first) return { mode: 'repl', rest: [] };
  if (first === '--help' || first === '-h' || first === 'help') return { mode: 'help', rest };
  if (first === '--version' || first === '-v' || first === 'version') return { mode: 'version', rest };
  if (first === 'doctor') return { mode: 'doctor', rest };
  if (first === 'run') return { mode: 'run', rest };
  return { mode: 'run', rest: argv };
}

async function main(): Promise<number> {
  loadDotEnv();
  const { mode, rest } = parse(process.argv.slice(2));

  if (mode === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (mode === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (mode === 'doctor') {
    const { ctx } = buildContext();
    const cmd = findCommand('/doctor')!;
    await cmd.run(ctx, []);
    return 0;
  }
  if (mode === 'run') {
    const text = rest.join(' ').trim();
    if (!text) {
      process.stderr.write('用法：hive run <问题>\n');
      return 2;
    }
    const { ctx } = buildContext({ thread: 'cli' });
    const mod = getModule(DEFAULT_MODULE) ?? getModule('assistant')!;
    try {
      const res = await ctx.agent.run(
        { text, threadId: ctx.state.thread, module: mod, tail: ctx.state.tail },
        (piece) => process.stdout.write(piece),
      );
      process.stdout.write('\n');
      ctx.state.lastTurn = res.meter;
      ctx.session.add(res.meter);
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
      });
      printFooter(ctx);
      return 0;
    } catch (e) {
      process.stderr.write(`调用失败：${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  if (!hasApiKey()) {
    process.stdout.write(
      gray(`提示：还没设 DEEPSEEK_API_KEY —— 把 .env.example 复制成 .env 填上即可。\n`) +
        dim(`      模型 ${modelName()} · 命令 ${COMMANDS.length} 个\n\n`),
    );
  }
  await startRepl();
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
