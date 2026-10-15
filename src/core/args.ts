/**
 * 命令行解析。
 *
 * 从 cli.ts 抽出来的唯一理由：**能单独测**。cli.ts 顶层会执行 `main()`，
 * import 它有副作用，所以解析逻辑不能留在那里（见 docs/V3-PLAN.md §2.2）。
 *
 * v3：`--as <A|B|C|D>` 让任一 agent 独立启动；`--continue` 是「续独立会话」的显式说法
 * （独立会话本就挂在固定的 `solo#<id>` 上，天然可续）。
 */
import { AGENTS, getAgent, type AgentId } from './modules.js';

export interface Parsed {
  /** repl / run / doctor / help / version */
  mode: string;
  /** 位置参数（命令名之后的） */
  rest: string[];
  /** --as 指定的身份；没给就是 null（= 主控 A） */
  as: AgentId | null;
  /** --continue / -c */
  cont: boolean;
}

export function parse(argv: string[]): Parsed {
  let as: AgentId | null = null;
  let cont = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--as') {
      // 取下一个词当身份；缺了就是空
      const v = (argv[i + 1] ?? '').trim().toUpperCase();
      as = (v || null) as AgentId | null;
      i += 1;
      continue;
    }
    if (a === '--continue' || a === '-c') {
      cont = true;
      continue;
    }
    rest.push(a!);
  }

  const first = rest[0];
  const tail = rest.slice(1);
  if (!first) return { mode: 'repl', rest: [], as, cont };
  if (first === '--help' || first === '-h' || first === 'help') return { mode: 'help', rest: tail, as, cont };
  if (first === '--version' || first === '-v' || first === 'version') return { mode: 'version', rest: tail, as, cont };
  if (first === 'doctor') return { mode: 'doctor', rest: tail, as, cont };
  if (first === 'run') return { mode: 'run', rest: tail, as, cont };
  return { mode: 'run', rest, as, cont };
}

export type AsVerdict = { ok: true; as: AgentId | null } | { ok: false; msg: string };

/** --as 的校验：身份必须存在，且允许独立启动（`AGENTS[i].standalone`） */
export function resolveAs(as: AgentId | null): AsVerdict {
  if (as === null) return { ok: true, as: null };
  const spec = getAgent(as);
  if (!spec) return { ok: false, msg: `没有身份 ${as}（可选 ${Object.keys(AGENTS).join('/')}）` };
  if (!spec.standalone) return { ok: false, msg: `身份 ${as} 不允许独立启动` };
  return { ok: true, as };
}
