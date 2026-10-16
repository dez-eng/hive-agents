/**
 * 底部状态行 —— 就是这一行：
 *
 *   hive · deepseek-flash · 谷 · 通用 │ 本轮 $0.000043 思考32% │ 会话 $0.0012/12轮 │ 上下文 7.1k 命中92% │ 历史 $0.0056
 *
 * 默认开，但只放一行、只放最有用的几项。要看细节得敲 /cost。
 * 宽度不够时从右往左丢段，绝不换行 —— 换行会把输入行顶跑。
 */
import { APP_NAME } from '../core/config.js';
import type { Band } from '../core/cost.js';
import type { LedgerTotals } from '../core/ledger.js';
import type { SessionTally, TokenMeter } from '../core/meter.js';
import { agentOf, type AgentModule } from '../core/modules.js';
import { bold, colWidth, cyan, dim, fmtPct, fmtTok, fmtUsd, red, visibleWidth, yellow } from './format.js';

export interface FooterInput {
  model: string;
  band: Band;
  module: AgentModule;
  thread: string;
  tail: boolean;
  /**
   * 模块栈（v2）。只有借调中（深 > 1）才显示 —— 平时单层没有信息量，
   * 而这一行每一列都是抢来的。
   */
  stack: string[];
  lastTurn: TokenMeter | null;
  session: SessionTally;
  history: LedgerTotals | null;
  /** v3 M2：本轮被能力网关拒了几次 —— 0 时这一段完全不出现 */
  denied?: number;
}

const SEP = dim(' │ ');

function bandCn(b: Band): string {
  return b === 'peak' ? '峰' : '谷';
}

/** 组成 footer 的各个片段，按重要性从左到右 */
function segments(f: FooterInput): string[] {
  const out: string[] = [];
  const m = f.lastTurn;

  // 顺序 = 重要性：终端窄时从右往左丢段，所以元信息排最后。
  // 你要看的是「花了多少、命中多少、平均多少」，不是模型名。
  if (m && m.calls) {
    const share = m.cost() ? Math.round((m.reasonCost() / m.cost()) * 100) : 0;
    const kk = m.calls === 1 ? m.kBlocks() : 0;
    out.push(
      `本轮 ${yellow(fmtUsd(m.cost()))}` +
        ` 思考${bold(String(share))}%` +
        // 拒绝是异常信号，跟着「本轮」走（排最右会第一个被宽度丢掉）
        (f.denied ? ` ${red(`拒${f.denied}`)}` : '') +
        (kk ? dim(` k=${kk.toFixed(0)}`) : '') +
        (m.truncated ? ` ${dim('截断')}` : ''),
    );
  }

  if (m && m.inTok) {
    out.push(`上下文 ${cyan(fmtTok(m.inTok))} ${dim('命中')}${cyan(fmtPct(m.hitRate()))}`);
  }

  if (f.session.turns) {
    out.push(
      `会话 ${yellow(fmtUsd(f.session.costUsd))}` +
        dim(` ${f.session.turns}轮`) +
        dim(` 均${fmtUsd(f.session.avgCost)}/轮`),
    );
  }

  out.push(
    `${dim(APP_NAME)} · ${dim(f.model)} · ${dim(bandCn(f.band))}` +
      ` · ${dim(f.module.title)}${f.tail ? dim('+尾') : ''}`,
  );

  if (f.history && f.history.rows) {
    out.push(`历史 ${dim(fmtUsd(f.history.costUsd))} ${dim(`${f.history.rows}行`)}`);
  }

  // 栈段排最右 —— 借调信息排在模型名之后，宽度不够时最先被丢
  if (f.stack.length > 1) {
    out.push(`栈 ${f.stack.map((id) => agentOf(id) ?? '?').join('›')}`);
  }

  return out;
}

export function renderFooter(f: FooterInput): string {
  const width = colWidth();
  const segs = segments(f);
  const kept: string[] = [];
  for (const s of segs) {
    const next = [...kept, s].join(SEP);
    if (visibleWidth(next) > width - 1 && kept.length) break;
    kept.push(s);
  }
  return kept.join(SEP);
}
