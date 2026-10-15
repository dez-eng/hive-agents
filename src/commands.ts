/**
 * 命令表。
 *
 * 分工：底部状态行默认只给一行（够用），细节全部藏在命令里。
 * 「某个聊天段花了多少 token」= /turn N 或 /turn N-M 或 /find 词。
 */
import { BLOCK, VERSION, APP_NAME, currentBand, hasApiKey, memoryPath } from './core/config.js';
import { priceFor } from './core/cost.js';
import type { HiveAgent } from './core/agent.js';
import { Ledger, head, missOf, type LedgerRow } from './core/ledger.js';
import { SessionTally, type TokenMeter } from './core/meter.js';
import { getModule, moduleList } from './core/modules.js';
import { STABLE_PREFIX, TAIL_MARK } from './core/prompt.js';
import type { ReplState } from './core/session.js';
import { ALL_TOOLS, ROOT, toolsChars } from './core/tools.js';
import { bold, dim, fmtInt, fmtPct, fmtTok, fmtUsd, green, red, yellow } from './ui/format.js';
import { renderFooter } from './ui/footer.js';

export interface Ctx {
  agent: HiveAgent;
  ledger: Ledger;
  session: SessionTally;
  state: ReplState;
  out: (s?: string) => void;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  /** 诊断类命令，/help 默认不列 */
  hidden?: boolean;
  run(ctx: Ctx, args: string[]): Promise<void>;
}

function bandCn(): string {
  return currentBand() === 'peak' ? '峰' : '谷';
}

function hitRate(inTok: number, cacheHit: number): number {
  return inTok ? cacheHit / inTok : 0;
}

interface RowSum {
  turns: number;
  calls: number;
  inTok: number;
  cacheHit: number;
  outTok: number;
  reasoning: number;
  cost: number;
}

function sumRows(rows: LedgerRow[]): RowSum {
  const s: RowSum = { turns: 0, calls: 0, inTok: 0, cacheHit: 0, outTok: 0, reasoning: 0, cost: 0 };
  for (const r of rows) {
    s.turns += 1;
    s.calls += r.calls;
    s.inTok += r.inTok;
    s.cacheHit += r.cacheHit;
    s.outTok += r.outTok;
    s.reasoning += r.reasoning;
    s.cost += r.costUsd;
  }
  return s;
}

function sumLine(s: RowSum): string {
  return (
    `${s.turns} 轮 · ${s.calls} 次调用 · 入 ${fmtInt(s.inTok)}` +
    `(命中 ${fmtInt(s.cacheHit)} ${fmtPct(hitRate(s.inTok, s.cacheHit))})` +
    ` · 出 ${fmtInt(s.outTok)}(可见 ${fmtInt(s.outTok - s.reasoning)} / 思考 ${fmtInt(s.reasoning)})` +
    ` · ${yellow(fmtUsd(s.cost))}`
  );
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2]! : (v[n / 2 - 1]! + v[n / 2]!) / 2;
}

function moduleOf(id: string) {
  return getModule(id) ?? getModule('assistant')!;
}

export const COMMANDS: Command[] = [
  {
    name: '/help',
    usage: '/help [all]',
    summary: '这张表',
    async run(ctx, args) {
      const all = args[0] === 'all';
      ctx.out(`${APP_NAME} ${VERSION} 命令`);
      for (const c of COMMANDS) {
        if (c.hidden && !all) continue;
        ctx.out(`  ${c.usage.padEnd(20)} ${dim(c.summary)}`);
      }
      if (!all) ctx.out(dim('  （/help all 连诊断类命令一起列）'));
      ctx.out();
      ctx.out(dim('  不是命令的输入会直接发给模型 —— 尾部会挂当前模块的角色片。'));
    },
  },

  {
    name: '/cost',
    usage: '/cost',
    summary: '账单：本轮 / 会话 / 今日 / 历史',
    async run(ctx) {
      const st = ctx.state;
      const m = st.lastTurn;
      const price = priceFor(ctx.agent.modelId);
      ctx.out(bold('[本次运行 · 只算真实对话]'));
      ctx.out(
        `  调用 ${ctx.session.total.calls} 次 · 入 ${fmtInt(ctx.session.total.inTok)}` +
          `（缓存 ${fmtInt(ctx.session.total.cacheHit)}` +
          ` ${fmtPct(hitRate(ctx.session.total.inTok, ctx.session.total.cacheHit))}）` +
          ` · 出 ${fmtInt(ctx.session.total.outTok)}` +
          `（思考 ${fmtInt(ctx.session.total.reasoning)}）` +
          ` · ${yellow(fmtUsd(ctx.session.costUsd))}   （按${bandCn()}时价）`,
      );
      if (ctx.session.turns) {
        ctx.out(
          `  ${ctx.session.turns} 轮 · 均 ${fmtUsd(ctx.session.avgCost)}/轮` +
            ` · 均 ${fmtTok(ctx.session.avgOut)} token 出/轮` +
            (ctx.session.toolTurns ? ` · 工具轮 ${ctx.session.toolTurns}` : '') +
            (ctx.session.truncated ? red(` · 截断 ${ctx.session.truncated}`) : ''),
        );
        const total = ctx.session.total;
        if (total.outTok) {
          const visible = total.outTok - total.reasoning;
          ctx.out(
            `  输出拆分 · 可见 ${fmtInt(visible)}(${fmtPct(visible / total.outTok)})` +
              ` · 思考 ${fmtInt(total.reasoning)}(${fmtPct(total.reasoning / total.outTok)})`,
          );
          const band = currentBand();
          const visCost = (visible / 1e6) * price.out[band];
          const reasonCost = (total.reasoning / 1e6) * price.out[band];
          if (ctx.session.costUsd) {
            ctx.out(
              `  可见输出 ${fmtUsd(visCost)}（占总花费 ${fmtPct(visCost / ctx.session.costUsd)}）` +
                ` · 思考 ${fmtUsd(reasonCost)}（占 ${fmtPct(reasonCost / ctx.session.costUsd)}）`,
            );
          }
        }
      }
      if (m) {
        ctx.out();
        ctx.out(bold('[最近一轮]'));
        ctx.out(
          `  ${m.calls} 次调用 · 入 ${fmtInt(m.inTok)}(命中 ${fmtInt(m.cacheHit)} ${fmtPct(m.hitRate())})` +
            ` · 出 ${fmtInt(m.outTok)}(可见 ${fmtInt(m.visibleTok())} / 思考 ${fmtInt(m.reasoning)})` +
            ` · ${yellow(fmtUsd(m.cost()))}`,
        );
        if (m.inTok) {
          ctx.out(
            `  未命中 ${fmtInt(m.missTok())} · 余额 ${fmtInt(m.missTok() - (m.inTok % BLOCK))}` +
              ` · k=${m.kBlocks().toFixed(0)} 块` +
              (m.kBlocks() >= 6 ? red('  ⚠ 上轮输出太胖，缓存追不上') : ''),
          );
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      const t = ctx.ledger.totals({ day: today });
      if (t && t.rows) {
        ctx.out();
        ctx.out(bold(`[今日 ${today} UTC · 含实验]`));
        ctx.out(
          `  ${t.calls} 次调用 · 入 ${fmtInt(t.inTok)}（缓存 ${fmtInt(t.cacheHit)}）` +
            ` · 出 ${fmtInt(t.outTok)}（思考 ${fmtInt(t.reasoning)}）` +
            ` · ${yellow(fmtUsd(t.costUsd))}   （${t.rows} 行）`,
        );
      }
      const all = ctx.ledger.totals();
      if (all && all.rows) {
        const since = (ctx.ledger.since() ?? '').slice(0, 10);
        ctx.out();
        ctx.out(bold(`[历史累计 · 起自 ${since}]`));
        ctx.out(
          `  ${all.calls} 次调用 · 入 ${fmtInt(all.inTok)}（缓存 ${fmtInt(all.cacheHit)}` +
            ` ${fmtPct(hitRate(all.inTok, all.cacheHit))}）` +
            ` · 出 ${fmtInt(all.outTok)}（思考 ${fmtInt(all.reasoning)}）` +
            ` · ${yellow(fmtUsd(all.costUsd))}   （${all.rows} 行）`,
        );
      }
      ctx.out();
      ctx.out(dim(`  价格表 ${ctx.agent.modelId} · 入(命中) ${price.in_hit.off}/${price.in_hit.peak} 美元每百万`));
      ctx.out(dim('  要看某一轮：/turn N    要看某一段：/turn N-M    要搜词：/find 关键词'));
    },
  },

  {
    name: '/turn',
    usage: '/turn [N|N-M]',
    summary: '查聊天段消耗：不给参数列本会话逐轮，给序号看单轮/区间',
    async run(ctx, args) {
      const turns = ctx.ledger.turnsOf(ctx.state.thread);
      if (!turns.length) {
        ctx.out(dim('[本会话还没有落账的轮次]\n'));
        return;
      }
      const spec = args[0];
      if (!spec) {
        ctx.out(bold(`[本会话逐轮 · thread=${ctx.state.thread} · 共 ${turns.length} 轮]`));
        ctx.out(
          dim('  #    时间     模块     调        入      命中     未命中       出     思考      k      花费'),
        );
        turns.forEach((r, i) => {
          const k = r.calls > 1 ? '—' : r.cacheHit === 0 ? '⌫' : String(Math.round(kOf(r)));
          ctx.out(
            `  ${String(i + 1).padStart(2)}  ${r.ts.slice(5, 19)}  ${(r.module || '—').padEnd(7)}` +
              ` ${r.calls}  ${fmtInt(r.inTok).padStart(8)}  ${fmtInt(r.cacheHit).padStart(8)}` +
              `  ${fmtInt(missOf(r.inTok, r.cacheHit)).padStart(8)}` +
              `  ${fmtInt(r.outTok).padStart(7)}  ${fmtInt(r.reasoning).padStart(6)}` +
              `  ${String(k).padStart(4)}  ${fmtUsd(r.costUsd)}`,
          );
        });
        ctx.out();
        ctx.out(`  ${sumLine(sumRows(turns))}`);
        ctx.out(dim('  /turn 3 → 第 3 轮明细    /turn 2-5 → 第 2~5 轮合计'));
        ctx.out();
        return;
      }

      const range = /^(\d+)\s*-\s*(\d+)$/.exec(spec);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        const slice = turns.slice(Math.max(a, 1) - 1, b);
        if (!slice.length) {
          ctx.out(red(`[第 ${a}~${b} 轮不存在 · 本会话只有 ${turns.length} 轮]\n`));
          return;
        }
        ctx.out(bold(`[第 ${a}~${b} 轮 · ${slice.length} 轮]`));
        ctx.out(`  ${sumLine(sumRows(slice))}`);
        ctx.out();
        return;
      }

      const n = Number(spec);
      const row = Number.isFinite(n) ? turns[n - 1] : undefined;
      if (!row) {
        ctx.out(red(`[没有第 ${spec} 轮 · 本会话只有 ${turns.length} 轮]\n`));
        return;
      }
      ctx.out(bold(`[第 ${n} 轮]`));
      ctx.out(`  ${rowDetail(row)}`);
      ctx.out(`  问「${row.userHead}」`);
      if (row.outHead) ctx.out(`  答「${row.outHead}」`);
      if (row.calls === 1) {
        ctx.out(
          `  几何律 · 未命中 ${fmtInt(missOf(row.inTok, row.cacheHit))}` +
            ` = (入 mod 64 = ${row.inTok % BLOCK}) + 64×${kOf(row)}`,
        );
      } else {
        ctx.out(dim(`  （工具轮 ${row.calls} 次调用，未命中是聚合值）`));
      }
      ctx.out();
    },
  },

  {
    name: '/find',
    usage: '/find <词>',
    summary: '跨历史搜轮次（问句或答句里含这个词）',
    async run(ctx, args) {
      const q = args.join(' ').trim();
      if (!q) {
        ctx.out('[用法：/find 渗透 —— 在问句/答句里找]\n');
        return;
      }
      const rows = ctx.ledger.search(q, 20);
      if (!rows.length) {
        ctx.out(dim(`[没找到含「${q}」的轮次]\n`));
        return;
      }
      ctx.out(bold(`[含「${q}」的轮次 · ${rows.length} 条 · 新的在前]`));
      for (const r of rows) {
        ctx.out(
          `  ${r.ts.slice(5, 19)}  ${(r.module || '—').padEnd(7)} ` +
            `入 ${fmtInt(r.inTok)} 出 ${fmtInt(r.outTok)}(思考 ${fmtInt(r.reasoning)}) ` +
            `${fmtUsd(r.costUsd)}`,
        );
        ctx.out(dim(`      问「${r.userHead}」`));
      }
      ctx.out();
      ctx.out(`  ${sumLine(sumRows(rows))}`);
      ctx.out();
    },
  },

  {
    name: '/modules',
    usage: '/modules',
    summary: '列模块（角色片挂 prompt 尾部，切它不动前缀缓存）',
    async run(ctx) {
      ctx.out(bold(`[模块 · 当前 ${ctx.state.moduleId} · 尾部角色片 ${ctx.state.tail ? '开' : '关'}]`));
      for (const m of moduleList()) {
        const mark = m.id === ctx.state.moduleId ? green('▸') : ' ';
        ctx.out(
          `${mark} ${m.id.padEnd(10)} ${m.title.padEnd(4)} ${dim(m.summary)}` +
            `  ${dim(`[工具 ${m.tools.join(',') || '无'} · 思考 ${m.think}${m.owner ? ` · 归属 ${m.owner}` : ''}]`)}`,
        );
      }
      ctx.out();
      ctx.out(dim('  /use <id> 切模块 —— 只换用户消息尾部那一段，system 前缀与历史都不动。'));
      ctx.out();
    },
  },

  {
    name: '/use',
    usage: '/use <id>',
    summary: '切模块',
    async run(ctx, args) {
      const id = (args[0] ?? '').trim();
      const m = getModule(id);
      if (!m) {
        ctx.out(red(`[没有模块 ${id || '(空)'} · 敲 /modules 看可用的]\n`));
        return;
      }
      ctx.state.moduleId = m.id;
      ctx.out(`[已切到 ${m.id}｜${m.title}]`);
      ctx.out(dim(`  尾部角色片：${m.fragment}`));
      ctx.out(dim('  前缀缓存不受影响 —— system 与历史一个字节都没动。\n'));
    },
  },

  {
    name: '/tail',
    usage: '/tail on|off',
    summary: '尾部角色片开关（关掉 = 跨模块同字节，做 A/B 用）',
    async run(ctx, args) {
      const v = (args[0] ?? '').trim();
      if (v !== 'on' && v !== 'off') {
        ctx.out(`[尾部角色片当前 ${ctx.state.tail ? '开' : '关'}]`);
        ctx.out(dim('  /tail off 后，模块仍生效于工具权限，但不再往 prompt 里写角色片。\n'));
        return;
      }
      ctx.state.tail = v === 'on';
      ctx.out(`[尾部角色片已${ctx.state.tail ? '开' : '关'}]`);
      if (!ctx.state.tail) {
        ctx.out(dim('  注意：关掉后模型看不到模块提示，只有工具权限还在按模块收。\n'));
      } else {
        ctx.out();
      }
    },
  },

  {
    name: '/status',
    usage: '/status on|off',
    summary: '底部状态行开关',
    async run(ctx, args) {
      const v = (args[0] ?? '').trim();
      if (v === 'on' || v === 'off') {
        ctx.state.footer = v === 'on';
      }
      ctx.out(`[底部状态行 ${ctx.state.footer ? '开' : '关'}]`);
      if (ctx.state.footer) {
        ctx.out(`  ${renderFooter(footerInput(ctx))}\n`);
      } else {
        ctx.out(dim('  关掉后账单不再自动显示 —— /cost 仍然随时可查。\n'));
      }
    },
  },

  {
    name: '/new',
    usage: '/new',
    summary: '开新会话（冷缓存，第一轮要重付整段前缀）',
    async run(ctx) {
      const thread = Math.random().toString(16).slice(2, 10);
      ctx.state.thread = thread;
      ctx.out(`[已开新会话 thread_id=${thread}]`);
      ctx.out(dim('  冷缓存：下一轮整段 prompt 都要按全价未命中付一次。'));
      ctx.out(dim('  好处是历史清空，风格与模块的影响变干净。\n'));
    },
  },

  {
    name: '/history',
    usage: '/history',
    summary: '本会话的存档点',
    async run(ctx) {
      const snaps = await ctx.agent.checkpoints(ctx.state.thread, 6);
      ctx.out(`[本会话存档点 · 最近 ${snaps.length} 个]`);
      for (const s of snaps) {
        ctx.out(`  step=${String(s.step).padEnd(3)} next=${s.next.padEnd(12)} id=…${s.id.slice(-8)}`);
      }
      ctx.out();
    },
  },

  {
    name: '/anatomy',
    usage: '/anatomy',
    summary: '解剖即将发出去的 prompt（纯本地，0 次调用）',
    hidden: true,
    async run(ctx) {
      const msgs = await ctx.agent.history(ctx.state.thread);
      const ai = msgs.filter((m) => m.getType() === 'ai');
      const hu = msgs.filter((m) => m.getType() === 'human');
      const aiChars = ai.reduce((n, m) => n + String(m.content).length, 0);
      const huChars = hu.reduce((n, m) => n + String(m.content).length, 0);
      const toolChars = toolsChars();
      const tailChars = ctx.state.tail
        ? hu.length * (TAIL_MARK.length + moduleOf(ctx.state.moduleId).fragment.length + 8)
        : 0;
      const total = STABLE_PREFIX.length + toolChars + aiChars + huChars;
      ctx.out(bold(`[Prompt 解剖 · thread=${ctx.state.thread} · 未含服务端模板开销]`));
      ctx.out(`  system 前缀（冻结区）     ${String(STABLE_PREFIX.length).padStart(7)} 字符`);
      ctx.out(`  工具 schema（${ALL_TOOLS.length} 个）     ${String(toolChars).padStart(7)} 字符`);
      ctx.out(
        `  历史 ${String(msgs.length).padStart(2)} 条               ${String(aiChars + huChars).padStart(7)} 字符`,
      );
      ctx.out(
        `    ├ 助手 ${String(ai.length).padStart(2)} 条            ${String(aiChars).padStart(7)} 字符` +
          dim(`   ← 占历史 ${aiChars + huChars ? Math.round((aiChars / (aiChars + huChars)) * 100) : 0}%`),
      );
      ctx.out(`    └ 用户 ${String(hu.length).padStart(2)} 条            ${String(huChars).padStart(7)} 字符`);
      if (tailChars) {
        ctx.out(dim(`       其中尾部角色片约 ${tailChars} 字符（挂在每条用户消息末尾）`));
      }
      ctx.out('  ──────────────────────────────────────');
      ctx.out(`  合计                      ${String(total).padStart(7)} 字符   ≈ ${fmtTok(Math.ceil(total / 3))} token`);
      ctx.out();
      ctx.out(dim('  读法：助手回复占历史几成，风格就被它自己带跑了几成。'));
      ctx.out(dim('        尾部那段是买路钱 —— 落在必然未命中的尾巴里，边际成本≈0。'));
      ctx.out();
    },
  },

  {
    name: '/misscheck',
    usage: '/misscheck [n]',
    summary: '几何律检验：未命中 = (入 mod 64) + 64k',
    hidden: true,
    async run(ctx, args) {
      const limit = Number(args[0]) || 20;
      const rows = ctx.ledger.allTurns();
      const pairs: Array<{ cur: LedgerRow; prev: LedgerRow }> = [];
      for (let i = 1; i < rows.length; i += 1) {
        const cur = rows[i]!;
        const prev = rows[i - 1]!;
        if (cur.threadId !== prev.threadId) continue;
        pairs.push({ cur, prev });
      }
      if (!pairs.length) {
        ctx.out('[还没有两轮相邻的真实对话 —— 先正常聊几轮再来]\n');
        return;
      }
      const view = pairs.slice(-limit);
      ctx.out(bold(`[几何律检验 · 最近 ${view.length} 对 · 单调用轮才成立]`));
      ctx.out(
        dim('  时间             入  入mod64   命中   未命中   余额    k    Δ  │ 判定'),
      );
      let ok = 0;
      let bad = 0;
      let skip = 0;
      let ntool = 0;
      const kcount = new Map<number, number>();
      for (const { cur, prev } of view) {
        const miss = missOf(cur.inTok, cur.cacheHit);
        const delta = cur.inTok - prev.inTok;
        if (cur.calls > 1) {
          ntool += 1;
          ctx.out(`  ${cur.ts.slice(5, 19)}  ${fmtInt(cur.inTok).padStart(8)}  ${'—'.padStart(7)}  ${fmtInt(cur.cacheHit).padStart(6)}  ${fmtInt(miss).padStart(6)}  ${'—'.padStart(5)}  ${'—'.padStart(3)}  ${'—'.padStart(4)}  │ ⚙ 工具轮`);
          continue;
        }
        if (cur.cacheHit === 0 && prev.outTok > 0) {
          skip += 1;
          ctx.out(`  ${cur.ts.slice(5, 19)}  ${fmtInt(cur.inTok).padStart(8)}  ${'—'.padStart(7)}  ${'0'.padStart(6)}  ${fmtInt(miss).padStart(6)}  ${'—'.padStart(5)}  ${'—'.padStart(3)}  ${'—'.padStart(4)}  │ ⌫ 缓存作废轮`);
          continue;
        }
        const r = cur.inTok % BLOCK;
        const bal = miss - r;
        const k = Math.round(bal / BLOCK);
        const same = Math.abs(bal - BLOCK * k) <= 1;
        let mark: string;
        if (same && k >= 2) {
          ok += 1;
          kcount.set(k, (kcount.get(k) ?? 0) + 1);
          mark = `✓ k=${k}` + (k >= 6 ? red('  ⚠ Δ 太大，缓存追不上') : '');
        } else {
          bad += 1;
          mark = red(`✗ 余额 ${bal} —— 真的例外`);
        }
        ctx.out(
          `  ${cur.ts.slice(5, 19)}  ${fmtInt(cur.inTok).padStart(8)}  ${String(r).padStart(7)}` +
            `  ${fmtInt(cur.cacheHit).padStart(6)}  ${fmtInt(miss).padStart(6)}` +
            `  ${String(bal).padStart(5)}  ${String(k).padStart(3)}  ${String(delta).padStart(4)}  │ ${mark}`,
        );
      }
      const dist = [...kcount.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `k=${k}: ${v}`).join(' · ');
      ctx.out();
      ctx.out(`  成立 ${ok} · 不符 ${bad} · 工具轮 ${ntool} · 作废轮 ${skip}   （k 分布 ${dist || '—'}）`);
      if (ok && !bad) {
        ctx.out(dim('  → 一条律：未命中 = (入 mod 64) + 64k。常态 k ∈ {2,3,4}。'));
        ctx.out(dim('     Δ = 上一轮可见输出 + 本轮输入。Δ 大 → k 炸。'));
      }
      ctx.out();
    },
  },

  {
    name: '/lenstat',
    usage: '/lenstat [run]',
    summary: '话长分布（可见 / 思考拆开）',
    hidden: true,
    async run(ctx, args) {
      const onlyRun = (args[0] ?? '') === 'run';
      const rows = onlyRun ? ctx.ledger.turnsOfRun() : ctx.ledger.allTurns();
      if (!rows.length) {
        ctx.out(dim(onlyRun ? '[本次运行还没有真实对话]\n' : '[还没有真实对话记录]\n'));
        return;
      }
      const outs = rows.map((r) => r.outTok);
      const reasons = rows.map((r) => r.reasoning);
      const total = outs.reduce((a, b) => a + b, 0);
      const totalR = reasons.reduce((a, b) => a + b, 0);
      ctx.out(bold(`[助手话长 · ${onlyRun ? `本次运行 run_id=${ctx.ledger.runId}` : `最近 ${rows.length} 轮（含旧账）`}]`));
      ctx.out(
        `  平均 ${(total / rows.length).toFixed(1)} token/轮   中位 ${median(outs).toFixed(1)}` +
          `   最短 ${Math.min(...outs)}   最长 ${Math.max(...outs)}   n=${rows.length}`,
      );
      ctx.out(
        `  其中可见 ${(total - totalR) / rows.length | 0}/轮   思考 ${(totalR / rows.length) | 0}/轮` +
          dim('   ← 思考是看不见的那部分'),
      );
      if (total) ctx.out(`  思考占总输出 ${fmtPct(totalR / total)}`);
      for (const [lo, hi, name] of [
        [0, 20, '≤20'],
        [20, 50, '21-50'],
        [50, 100, '51-100'],
        [100, 200, '101-200'],
        [200, 400, '201-400'],
        [400, Number.MAX_SAFE_INTEGER, '>400'],
      ] as Array<[number, number, string]>) {
        const c = outs.filter((o) => o >= lo && o < hi).length;
        ctx.out(`  ${name.padStart(8)}  ${String(c).padStart(3)}  ${'█'.repeat(c)}`);
      }
      const top = [...rows].sort((a, b) => b.outTok - a.outTok).slice(0, 3);
      if (rows.length >= 5) {
        ctx.out();
        ctx.out(bold('  [最长的 3 轮 —— 钱在这几轮上]'));
        for (const r of top) {
          ctx.out(
            `    ${r.ts.slice(5, 19)}  出 ${String(r.outTok).padStart(4)}` +
              ` (${fmtPct(r.outTok / total)}) 思考 ${String(r.reasoning).padStart(4)}` +
              `（占 ${fmtPct(r.outTok ? r.reasoning / r.outTok : 0)}）│ 问「${r.userHead.slice(0, 24)}」`,
          );
          ctx.out(dim(`                 答「${r.outHead.slice(0, 52)}」`));
        }
      }
      ctx.out();
    },
  },

  {
    name: '/ledger',
    usage: '/ledger [n]',
    summary: '账本原始行 + 按天汇总',
    async run(ctx, args) {
      const limit = Number(args[0]) || 12;
      const rows = ctx.ledger.recent(limit);
      if (!rows.length) {
        ctx.out(dim('[账本还是空的]\n'));
        return;
      }
      ctx.out(bold(`[最近 ${rows.length} 行] · 标签+尾/−尾 = 尾部角色片开/关`));
      for (const r of rows) {
        const flag = r.calls > 1 ? '⚙' : ' ';
        const tag = r.kind + (r.styleOn === 1 ? '+尾' : r.styleOn === 0 ? '−尾' : '');
        ctx.out(
          `  ${r.ts.slice(5, 19)}  ${tag.padEnd(7)} ${(r.threadId || '').padEnd(10)} ${flag}${r.calls}` +
            `  ${fmtInt(r.inTok).padStart(8)}  ${fmtInt(r.cacheHit).padStart(8)}` +
            `  ${fmtInt(r.outTok).padStart(6)}  ${fmtInt(r.reasoning).padStart(7)}  ${fmtUsd(r.costUsd)}` +
            `  ${(r.module || '—').padEnd(7)} ${head(r.userHead, 18)}`,
        );
      }
      const days = ctx.ledger.days(7);
      if (days.length) {
        ctx.out();
        ctx.out(bold('[按天汇总 · 最近 7 天]'));
        for (const d of days) {
          ctx.out(
            `  ${d.day}  调用 ${String(d.calls).padStart(3)} · 入 ${fmtInt(d.inTok).padStart(9)}` +
              `（命中 ${fmtPct(hitRate(d.inTok, d.cacheHit)).padStart(5)}）` +
              ` · 出 ${fmtInt(d.outTok).padStart(8)}(思考 ${fmtInt(d.reasoning).padStart(7)}` +
              ` = ${fmtPct(d.outTok ? d.reasoning / d.outTok : 0).padStart(4)}) · ${fmtUsd(d.costUsd)}`,
          );
        }
      }
      ctx.out();
      ctx.out(dim('  逐轮看 /turn   搜词看 /find   几何律看 /misscheck'));
      ctx.out();
    },
  },

  {
    name: '/doctor',
    usage: '/doctor',
    summary: '环境自检（账本、sqlite、key、计量字段校准）',
    hidden: true,
    async run(ctx) {
      ctx.out(bold(`[${APP_NAME} ${VERSION} 自检]`));
      ctx.out(`  node          ${process.version} · ${process.platform}/${process.arch}`);
      ctx.out(`  模型          ${ctx.agent.modelId}（${bandCn()}时价）`);
      ctx.out(`  API key       ${hasApiKey() ? green('已设置') : red('未设置（.env 里填 DEEPSEEK_API_KEY）')}`);
      ctx.out(`  账本          ${ctx.ledger.open_ ? green('已打开') : red('打不开')} · ${ctx.ledger.path}`);
      ctx.out(`  checkpoint    ${ctx.agent.memoryFile}`);
      ctx.out(`  工作目录      ${ROOT}`);
      const t = ctx.ledger.totals();
      if (t) ctx.out(`  账本行数      ${t.rows} 行 · 起自 ${(ctx.ledger.since() ?? '—').slice(0, 19)}`);
      ctx.out(`  工具          ${ALL_TOOLS.map((x) => x.name).join(', ')}（描述合计 ${toolsChars()} 字符）`);
      ctx.out(`  命令          ${COMMANDS.length} 个`);
      const m = ctx.state.lastTurn;
      if (m?.lastRaw) {
        const raw = m.lastRaw.message as { usage_metadata?: unknown; response_metadata?: unknown } | undefined;
        ctx.out();
        ctx.out(bold('  [最近一次调用的原始计量 —— 字段名对不上时看这里]'));
        ctx.out(dim(`    usage_metadata   = ${JSON.stringify(raw?.usage_metadata ?? null)}`));
        ctx.out(dim(`    tokenUsage       = ${JSON.stringify((raw?.response_metadata as { tokenUsage?: unknown })?.tokenUsage ?? null)}`));
      } else {
        ctx.out(dim('\n  还没有调用记录 —— 先问一句再来自检。'));
      }
      ctx.out();
    },
  },

  {
    name: '/exit',
    usage: '/exit',
    summary: '退出',
    async run() {
      /* repl 自己处理 */
    },
  },
];

export function findCommand(first: string): Command | undefined {
  return COMMANDS.find((c) => c.name === first);
}

export function knownCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

/** 账本行里的 k 块 */
function kOf(r: LedgerRow): number {
  return (missOf(r.inTok, r.cacheHit) - (r.inTok % BLOCK)) / BLOCK;
}

function rowDetail(r: LedgerRow): string {
  return (
    `${r.ts.slice(5, 19)} · ${(r.module || '—')} · ${r.calls} 次调用 · 入 ${fmtInt(r.inTok)}` +
    `(命中 ${fmtInt(r.cacheHit)} ${fmtPct(hitRate(r.inTok, r.cacheHit))})` +
    ` · 出 ${fmtInt(r.outTok)}(思考 ${fmtInt(r.reasoning)}) ` +
    `${yellow(fmtUsd(r.costUsd))}`
  );
}

export function footerInput(ctx: Ctx) {
  return {
    model: ctx.agent.modelId,
    band: currentBand(),
    module: moduleOf(ctx.state.moduleId),
    thread: ctx.state.thread,
    tail: ctx.state.tail,
    lastTurn: ctx.state.lastTurn,
    session: ctx.session,
    history: ctx.ledger.totals(),
  };
}

export const HELP_HINT = dim(`敲 /help 看命令（${knownCommandNames().length} 个）`);
