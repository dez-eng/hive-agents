"""
Reasonix 学习计划 · 阶段 6.7：贴尾 A/B
langgraph 1.2.14 / langchain-core 1.6.9 / langchain-deepseek 1.1.1

==========================================================
几何律（精确形式 · 41/41，无例外）
==========================================================
    命中   = 64 × floor(入 / 64) − 64k
    未命中 = (入 mod 64) + 64k

    k 通常 2~4。129 / 193 = 64k − 1 是族内毛刺 ±1，同一件事。

    最纯的一次验证：
        第1轮  入 7,320   余 24   未命中 152   152 − 24 = 128 = 2×64   k=2
        第2轮  入 7,354   余 58   未命中 186   186 − 58 = 128 = 2×64   k=2
      两个不同的余数，同一个余额。未命中与内容无关，只与「余数」和「几块」有关。

k 什么时候炸
----------------------------------------------------------
    Δ = 下一轮的入 − 这一轮的入
      = 上一轮的可见输出 + 本轮用户输入（含风格贴尾）

    实测：上一轮出 539（可见 466）→ 下一轮未命中 509，k=7。
          多做出来的 5 块（320 token）全记在未命中账上。
    实测：Δ=34（上轮可见 4 + 输入约 30）→ k 稳在 2，地板。

    → 胖输出双重收费。但输出那头贵 13 倍，尾巴这条是零头。

【6.5 核心发现】钱在看不见的地方
==========================================================
    93146ec5 运行 13 轮：
        可见输出   5/轮
        思考      44/轮      ← 是可见的 9 倍

    规则把话从「嘴上」赶到了「心里」。
    而思考按输出价计费，一分钱不便宜。

    最长的 3 轮（占 80% 总输出）全是思考撑起来的：
        问「你可以做一个中国象棋的小游戏吗」
          答「能，但只能把代码贴在回复里，写不了文件。」   出 213 / 可见 22
        问「谢大王大王大大希望的大地相爱的心啊伟大」
          答「没听懂。」                                  出 173 / 可见  4
        问「123」
          答「要算什么？」                                出 120 / 可见  5

账单的形状（13 轮，谷时）
----------------------------------------------------------
        未命中输入  ~2,860   $0.000429   40%
        命中输入   ~89,000   $0.000267   25%
        思考          572    $0.000343   32%
        可见输出       59    $0.000035    3%

    → 你花在「看得见的回答」上的钱，是总账单的 3%。
      几十轮改规则、削话长，动的就是那 3%。
    → 该换目标：不是「少说」，是「少想」。

【6.7 撤回 6.6 的结论】思考量确实是题目的属性
==========================================================
    「123」三次实测：

        93146ec5  长历史            出 120  思考 115  可见  5
        6.6 事故  "thinktest 123"   出   4  思考   0  可见  4
        aae46685  /new 冷启动       出 122  思考 106  可见 16

    115 → 106。复现了。6.6 写的「思考量不是题目的固有属性」是错的，
    H8 / H9 撤回。

    唯一不同的那次（思考 0）是输入里加了 "thinktest " 前缀 ——
    一个域外前缀让模型不接茬、不掂量。那不是省，是它没干活。

【6.7 核心】规则只是把账单从可见挪到了思考
==========================================================
    「123」两次的总输出：120 → 122。没动。

        可见   5 →  16   （涨了）
        思考 115 → 106   （略降）

    机制写在模型的答案里：
        问「123」 → 「123 是要我读文件还是算数？给我算式或路径。」
        106 个 token 想「123 到底要干嘛」，最后憋出一句问话。

    规则 #6「没听懂就问一句，不要列五种可能」+ 贴尾「一句话答我」
    = 逼它在一句话里解决全部模糊性。它只能挪到地下反复掂量。
    这是 H7 的具体样子。

【6.7 可测预测】/style off 应该：思考 ↓ · 可见 ↑ · 总数 ≈ 不变
==========================================================
    成立 → 贴尾是拿可见的短换思考的长，可能是零和甚至净亏。
    不成立（思考不动）→ 思考另有来源，贴尾无罪。
    这是唯一能判定贴尾值不值得的实验。同题、/new、只动这一个开关。

风格贴尾（6.4.1 起）
==========================================================
    用户消息在 prompt 最末尾。最末尾那段（必然未命中）是每次都要付全价的，
    所以挂在这里的规则提醒，边际成本 ≈ 0。而且它离模型最近 ——
    开头 7,000 token 之前的系统提示够不着。

    定性（最硬）：
      /style off  「小鱼，你这一串都是乱码式的输入，我这边没法理解，
                   也没法处理。有正经需求就直接说。」        27 token，三宗罪全犯
      /style on   「没听懂。」「在。」「读文件、算数。」       4 / 3 / 7 token
      /style on   「能，代码贴回复里。」                      8 token

    ⚠ 但它压可见的同时可能在烧思考。6.7 已把 style_on 写进账本，
      用 /stylecmp 判定。跑之前先看 /stylecmp 的提示。

已证伪的假设（别再往回捡）
==========================================================
    H1  未命中 ≈ 上一轮助手输出            ✗ 上轮出跨 9 倍，尾巴动 1.8 倍
    H2  未命中 ≈ 上轮输出 + 本轮用户输入    ✗ 只在 Δ 大时成立，Δ 小时不成立
    H3  缓存按讨论长度衰减                 ✗ 命中率随对话变长单调上升
    H4  封顶输出能省钱                     ✗ 撞上限只把答案切断
    H5  未命中 341 是工具轮造成的           ✗ calls 全为 1
    H6  k 上界是 4                         ✗ 实测 k=7
    H7  压住可见输出 = 省钱                 ⚠ 6.7 证据支持「是零和」
    H8  思考量不是题目的固有属性（6.6）      ✗ 6.7 撤回。同题 115 → 106，复现了
    H9  改题目措辞能压住思考（6.6）          ✗ H8 的推论，一并撤回

    教训：6.6 那次 0 思考是 "thinktest " 前缀造成的，我把它当成了
          「同一道题的另一次采样」。域外前缀让模型不接茬 ——
          那不是省，是它没干活。以后输入里混了非问题本身的内容，都不算对照。

冻结区警告
==========================================================
    系统提示 + 工具定义。一个字 = $0.000245 全盘作废税。
    要调风格就走 /style，那条路不经过冻结区。

本版新增（6.7）
==========================================================
    撤回 H8 / H9（6.6 的结论是错的）。
    账本加 style_on 列 —— 记下每轮的贴尾状态。
    /stylecmp —— 按贴尾开关自动分组，并排比「可见中位 / 思考中位 / 总数中位」。

沿用（6.6）：缺斜杠的命令自动补上 · thinktest 开头一行确认
沿用（6.5）：命令守卫按首词判断 · /thinktest · 思考 ≥60 单独点名
沿用：账本 /cost /ledger /turns /cachetest /anatomy /misscheck
      /lenstat /tailtest /history /new /style
"""
import os
import ast
import uuid
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from typing import Annotated, TypedDict

from dotenv import load_dotenv
load_dotenv()

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import (BaseMessage, HumanMessage, AIMessage,
                                     ToolMessage, SystemMessage)
from langchain_core.tools import tool
from langchain_deepseek import ChatDeepSeek
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.sqlite import SqliteSaver


# ============ 价格表（美元 / 百万 token）============
PRICE = {
    "deepseek-flash": {
        "in_hit":  {"peak": 0.006, "off": 0.003},
        "in_miss": {"peak": 0.30,  "off": 0.15},
        "out":     {"peak": 1.20,  "off": 0.60},
    },
    "deepseek-v4-pro": {
        "in_hit":  {"peak": 0.044, "off": 0.022},
        "in_miss": {"peak": 1.32,  "off": 0.66},
        "out":     {"peak": 3.96,  "off": 1.98},
    },
}
MODEL_NAME = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")
MAX_OUT = int(os.getenv("MAX_OUT", "0"))   # 0 = 不封顶（推荐）


def is_peak_now() -> bool:
    """峰时 = UTC 周一~周五 01:00-04:00 / 06:00-10:00"""
    now = datetime.now(timezone.utc)
    if now.weekday() >= 5:
        return False
    return (1 <= now.hour < 4) or (6 <= now.hour < 10)


def think_cost(reason_tokens: int) -> float:
    """把思考 token 折算成钱"""
    try:
        p = PRICE.get(MODEL_NAME, PRICE["deepseek-flash"])
        return reason_tokens / 1e6 * p["out"]["peak" if is_peak_now() else "off"]
    except Exception:
        return 0.0


def think_share(reason_tokens: int, total_cost: float):
    """打印「其中思考花了多少 · 占总花费几成」。total_cost 为 0 就不打。"""
    if not total_cost:
        return
    rc = think_cost(reason_tokens)
    print(f"  其中思考 ${rc:.6f} · 占总花费 {rc / total_cost * 100:.0f}%")


def _med(vals):
    """中位数。偶数个样本取中间两个的平均（6.4 之前这里算错，均值 26 报了中位 47）。"""
    v = sorted(vals)
    n = len(v)
    if not n:
        return None
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


# ============ 系统提示 ============
# ⚠ 冻结区。改一个字全盘缓存作废（实测 $0.000245）。
#    6.4 已按实测的四类毛病重写（中位 51→19）。要调风格走 /style，别动这里。
SYSTEM_STATIC = (
    "你是编程助手，只有两个工具：读文件（相对路径）、算数（算式）。\n"
    "历史和工具里没有的信息就说不知道，不要编。\n"
    "\n"
    "输出规则，按优先级：\n"
    "1 只答问题本身。不评论对话（\"我明白你在干嘛\"）、不提议下一步"
    "（\"你可以试试…\"）、不问\"还需要什么\"。\n"
    "2 不用问候、称呼、客套、表情符号。不要称呼用户。\n"
    "3 不解释自己正在做什么、不预告要做什么、不复述用户的意图。\n"
    "4 不把能力或限制列成清单——除非用户明确要求\"列出\"。\n"
    "5 默认一句话。只有用户要求展开、或答案必须分步才有用时才分段。\n"
    "6 没听懂就问一句，不要列五种可能。\n"
    "\n"
    "例子：\n"
    "  问\"你能做什么\" → \"读文件、算数。给我路径或算式。\"\n"
    "  问\"如何改回显名\" → \"改不了，那是客户端设置。要改得动它的配置。\"\n"
)

SYSTEM = SYSTEM_STATIC

# ============ 风格贴尾（6.4.1 实验 · 6.7 待 A/B 判定）============
# 用户消息在 prompt 的最末尾。最末尾那 128~192 token 是每次必然未命中的
# 尾巴 —— 反正都要付全价。所以挂在这里的规则提醒，边际成本 ≈ 0。
#
# 而放在冻结区（开头）的规则，要经过 7,000 token 的历史才能到达模型。
# 实测：开头 6 条规则压不住，尾巴上一条就压住了。
#
# ⚠ 6.7 待判定：它压可见的同时是不是在烧思考。
#    「123」总量对照（120 vs 122）支持「零和」。用 /stylecmp 判定。
STYLE_SUFFIX = "（一句话答我。不要称呼我名字。不要提议下一步。）"
STYLE = {"on": True}

CACHE_KILLER = {"on": False}


# ============ 计量器 ============
def _extract(msg, llm_output):
    """返回 (输入, 输出, 缓存命中, 思考)"""
    in_tok = out_tok = hit = reason = 0
    um = getattr(msg, "usage_metadata", None) if msg is not None else None
    if um:
        in_tok = um.get("input_tokens", 0) or 0
        out_tok = um.get("output_tokens", 0) or 0
        hit = (um.get("input_token_details") or {}).get("cache_read", 0) or 0
        reason = (um.get("output_token_details") or {}).get("reasoning", 0) or 0
    if not in_tok and msg is not None:
        tu = (getattr(msg, "response_metadata", None) or {}).get("token_usage") or {}
        in_tok = tu.get("prompt_tokens", 0) or 0
        out_tok = tu.get("completion_tokens", 0) or 0
        hit = tu.get("prompt_cache_hit_tokens", 0) or 0
        reason = (tu.get("completion_tokens_details") or {}).get("reasoning_tokens", 0) or 0
    if not in_tok and llm_output:
        tu = llm_output.get("token_usage") or {}
        in_tok = tu.get("prompt_tokens", 0) or 0
        out_tok = tu.get("completion_tokens", 0) or 0
        hit = tu.get("prompt_cache_hit_tokens", 0) or 0
        reason = (tu.get("completion_tokens_details") or {}).get("reasoning_tokens", 0) or 0
    return in_tok, out_tok, hit, reason


class Meter(BaseCallbackHandler):
    def __init__(self):
        self.calls = self.in_tok = self.out_tok = self.cache_hit = 0
        self.reasoning = 0
        self.truncated = False      # 输出是否正好顶到 max_tokens

    def on_llm_end(self, response, **kwargs):
        self.calls += 1
        llm_out = getattr(response, "llm_output", None) or {}
        for group in response.generations:
            for gen in group:
                i, o, h, r = _extract(getattr(gen, "message", None), llm_out)
                self.in_tok += i
                self.out_tok += o
                self.cache_hit += h
                self.reasoning += r
        if MAX_OUT and self.out_tok >= MAX_OUT:
            self.truncated = True

    def _band(self):
        return "peak" if is_peak_now() else "off"

    def miss_tok(self):
        """未命中输入 token —— 单调用轮 = (入 mod 64) + 64k"""
        return max(self.in_tok - self.cache_hit, 0)

    def visible_tok(self):
        """可见输出 = 输出 − 思考。钱花在这上面的比例，才是「话长」能管的范围。"""
        return max(self.out_tok - self.reasoning, 0)

    def k_blocks(self):
        """未命中里有几块（余额 ÷ 64）。正常 2~4，上一轮输出太胖会炸到 7+"""
        m = self.miss_tok()
        if not m:
            return 0.0
        return (m - (self.in_tok % 64)) / 64

    def in_cost(self):
        """只算输入侧 —— 缓存实验的正确指标（缓存是纯输入效应）"""
        try:
            p = PRICE.get(MODEL_NAME, PRICE["deepseek-flash"])
            b = self._band()
            return (self.miss_tok() / 1e6 * p["in_miss"][b]
                    + self.cache_hit / 1e6 * p["in_hit"][b])
        except Exception:
            return 0.0

    def cost(self):
        try:
            p = PRICE.get(MODEL_NAME, PRICE["deepseek-flash"])
            b = self._band()
            return (self.miss_tok() / 1e6 * p["in_miss"][b]
                    + self.cache_hit / 1e6 * p["in_hit"][b]
                    + self.out_tok / 1e6 * p["out"][b])
        except Exception:
            return 0.0

    def reason_cost(self):
        return think_cost(self.reasoning)

    def report(self, tag=""):
        """显示账单。任何异常都降级显示，绝不让记账弄挂对话。"""
        try:
            c = self.cost()
            band_cn = "峰" if self._band() == "peak" else "谷"
            rc = self.reason_cost()
            pct = (rc / c * 100) if c else 0
            cut = "  ⚠ 撞上限被截断" if self.truncated else ""
            tool = f" · {self.calls} 次调用" if self.calls > 1 else ""
            kk = self.k_blocks()
            kb = ""
            if self.calls == 1 and kk:
                # k ≥ 6 就标出来 —— 那是上一轮输出太胖留下的账
                kb = f" · k={kk:.0f}块" + ("  ⚠上轮太胖" if kk >= 6 else "")
            print(f"  ── {tag}{self.calls} 次调用{tool} · 入 {self.in_tok:,}"
                  f"(命中 {self.cache_hit:,} / 未命中 {self.miss_tok():,}{kb})"
                  f" · 出 {self.out_tok:,}(思考 {self.reasoning:,})"
                  f" · ${c:.6f} · {band_cn}时 · 思考占 {pct:.0f}%{cut}")
            # 思考单独点名 —— 它看不见，但按输出价计费
            if self.calls == 1 and self.reasoning >= 60:
                vt = self.visible_tok()
                print(f"         ↑ 思考 {self.reasoning:,} / 可见 {vt:,}"
                      f" —— 看不见的那部分在烧钱")
        except Exception as e:
            print(f"  ── {tag}{self.calls} 次调用 · [记账显示异常 {type(e).__name__}]")


SESSION = {"calls": 0, "in": 0, "out": 0, "hit": 0, "reason": 0, "cost": 0.0,
           "truncated": 0, "turns": 0, "tool_turns": 0}


# ============ 跨进程成本账本 ============
LEDGER_PATH = Path("costs.db")
RUN_ID = uuid.uuid4().hex[:8]
_ledger = None


def _head(s, n=50):
    """整段压成一行，取前 n 字。用来在账本里认出「这轮问了什么、答了什么」。"""
    try:
        return " ".join(str(s).split())[:n]
    except Exception:
        return ""


def ledger_init():
    global _ledger
    try:
        _ledger = sqlite3.connect(LEDGER_PATH, check_same_thread=False, timeout=5)
        _ledger.execute("PRAGMA journal_mode=WAL")
        _ledger.execute("""
            CREATE TABLE IF NOT EXISTS ledger (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        TEXT    NOT NULL,
                day       TEXT    NOT NULL,
                run_id    TEXT    NOT NULL,
                thread_id TEXT    NOT NULL,
                model     TEXT    NOT NULL,
                band      TEXT    NOT NULL,
                tag       TEXT    NOT NULL,
                calls     INTEGER NOT NULL,
                in_tok    INTEGER NOT NULL,
                cache_hit INTEGER NOT NULL,
                out_tok   INTEGER NOT NULL,
                reason_tok INTEGER NOT NULL DEFAULT 0,
                user_chars INTEGER NOT NULL DEFAULT 0,
                user_head TEXT    NOT NULL DEFAULT '',
                out_head  TEXT    NOT NULL DEFAULT '',
                cost_usd  REAL    NOT NULL,
                style_on  INTEGER NOT NULL DEFAULT -1
            )
        """)
        # 老库补列
        cols = [r[1] for r in _ledger.execute("PRAGMA table_info(ledger)").fetchall()]
        for col, ddl in (
            ("reason_tok", "ALTER TABLE ledger ADD COLUMN reason_tok INTEGER NOT NULL DEFAULT 0"),
            ("user_chars", "ALTER TABLE ledger ADD COLUMN user_chars INTEGER NOT NULL DEFAULT 0"),
            ("user_head",  "ALTER TABLE ledger ADD COLUMN user_head TEXT NOT NULL DEFAULT ''"),
            ("out_head",   "ALTER TABLE ledger ADD COLUMN out_head  TEXT NOT NULL DEFAULT ''"),
            ("style_on",   "ALTER TABLE ledger ADD COLUMN style_on  INTEGER NOT NULL DEFAULT -1"),
        ):
            if col not in cols:
                _ledger.execute(ddl)
        _ledger.execute("CREATE INDEX IF NOT EXISTS idx_day ON ledger(day)")
        _ledger.execute("CREATE INDEX IF NOT EXISTS idx_run ON ledger(run_id)")
        _ledger.execute("CREATE INDEX IF NOT EXISTS idx_tag ON ledger(tag)")
        _ledger.commit()
        return True
    except Exception as e:
        print(f"[账本初始化失败 {type(e).__name__}: {e} —— 本次运行不落盘]")
        _ledger = None
        return False


def ledger_write(tag, thread_id, meter, user_chars=0, user_head="", out_head="",
                 style_on=-1):
    """user_chars = 本轮用户输入的字符数（不含贴尾）。
    user_head / out_head = 原文开头，用来认出哪一轮最贵。
    style_on = 1 贴尾开 / 0 关 / -1 不适用（实验轮、旧账）。"""
    if _ledger is None or meter.calls == 0:
        return False
    try:
        now = datetime.now(timezone.utc)
        _ledger.execute(
            "INSERT INTO ledger (ts, day, run_id, thread_id, model, band, tag,"
            " calls, in_tok, cache_hit, out_tok, reason_tok, user_chars,"
            " user_head, out_head, cost_usd, style_on)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (now.isoformat(timespec="seconds"),
             now.strftime("%Y-%m-%d"),
             RUN_ID, thread_id, MODEL_NAME,
             "peak" if is_peak_now() else "off",
             tag, meter.calls, meter.in_tok, meter.cache_hit,
             meter.out_tok, meter.reasoning, user_chars,
             _head(user_head), _head(out_head), meter.cost(), style_on),
        )
        _ledger.commit()
        return True
    except Exception as e:
        print(f"  ── [账本写入失败 {type(e).__name__}: {e}] —— 对话继续")
        return False


def ledger_totals(day=None, run_id=None):
    if _ledger is None:
        return None
    try:
        sql = ("SELECT COALESCE(SUM(calls),0), COALESCE(SUM(in_tok),0),"
               " COALESCE(SUM(cache_hit),0), COALESCE(SUM(out_tok),0),"
               " COALESCE(SUM(reason_tok),0), COALESCE(SUM(cost_usd),0),"
               " COUNT(*) FROM ledger")
        where, args = [], []
        if day:
            where.append("day = ?")
            args.append(day)
        if run_id:
            where.append("run_id = ?")
            args.append(run_id)
        if where:
            sql += " WHERE " + " AND ".join(where)
        return _ledger.execute(sql, tuple(args)).fetchone()
    except Exception:
        return None


def ledger_days(limit=7):
    if _ledger is None:
        return []
    try:
        return _ledger.execute(
            "SELECT day, SUM(calls), SUM(in_tok), SUM(cache_hit), SUM(out_tok),"
            " SUM(reason_tok), SUM(cost_usd)"
            " FROM ledger GROUP BY day ORDER BY day DESC LIMIT ?",
            (limit,)).fetchall()
    except Exception:
        return []


def ledger_rows(limit=12):
    if _ledger is None:
        return []
    try:
        return _ledger.execute(
            "SELECT ts, tag, thread_id, calls, in_tok, cache_hit, out_tok,"
            " reason_tok, cost_usd, run_id, user_head, out_head, style_on"
            " FROM ledger ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    except Exception:
        return []


def ledger_since():
    if _ledger is None:
        return None
    try:
        r = _ledger.execute("SELECT MIN(ts) FROM ledger").fetchone()
        return r[0] if r else None
    except Exception:
        return None


# ============ 诊断 ============
def tools_chars():
    n = 0
    for t in TOOLS:
        n += len(t.name) + len(t.description or "")
        try:
            n += len(str(t.args_schema.model_json_schema()))
        except Exception:
            pass
    return n


def anatomy():
    """数一数即将发出去的 prompt 由什么组成。纯本地，0 次调用。"""
    cfg = {"configurable": {"thread_id": STATE["thread"]}}
    msgs = []
    try:
        snap = app.get_state(cfg)
        if snap and snap.values:
            msgs = list(snap.values.get("messages", []))
    except Exception:
        pass

    sys_c = len(SYSTEM)
    tool_c = tools_chars()
    hist_c = sum(len(str(m.content)) for m in msgs)
    ai_msgs = [m for m in msgs if isinstance(m, AIMessage)]
    hu_msgs = [m for m in msgs if isinstance(m, HumanMessage)]
    ai_c = sum(len(str(m.content)) for m in ai_msgs)
    hu_c = sum(len(str(m.content)) for m in hu_msgs)
    total = sys_c + tool_c + hist_c
    ai_share = (ai_c / hist_c * 100) if hist_c else 0
    suffix_c = len(STYLE_SUFFIX) * len(hu_msgs) if STYLE["on"] else 0

    print(f"[Prompt 解剖 · thread={STATE['thread']} · 还没算服务端模板开销]")
    print(f"  系统提示                  {sys_c:>7,} 字符")
    print(f"  工具 schema（{len(TOOLS)} 个）     {tool_c:>7,} 字符")
    print(f"  历史 {len(msgs):>2} 条               {hist_c:>7,} 字符")
    print(f"    ├ 助手回复 {len(ai_msgs):>2} 条        {ai_c:>7,} 字符   ← 占历史 {ai_share:.0f}%")
    print(f"    └ 用户输入 {len(hu_msgs):>2} 条        {hu_c:>7,} 字符")
    if suffix_c:
        print(f"       其中风格贴尾 {len(hu_msgs)} 条 × {len(STYLE_SUFFIX)} 字"
              f" ≈ {suffix_c:,} 字符（贴尾已开）")
    print(f"  ──────────────────────────────────────")
    print(f"  合计                      {total:>7,} 字符   ≈ {total / 3:,.0f} token（中英混排粗估）")
    print()
    print("  读法：助手回复占历史几成，就是风格被它自己带跑了几成。")
    if suffix_c:
        print(f"        贴尾那 {suffix_c:,} 字符是买路钱 —— 挂在每轮末尾，")
        print("        落在必然未命中的尾巴里，但会永久留在历史里按缓存价重发。")
    print()


def misscheck(limit=20):
    """几何律检验：未命中 = (入 mod 64) + 64k。与内容无关。

    ⚠ 只对【单调用轮】成立。工具轮有两次调用，缓存盖不到第二次的新内容，
      合计未命中会额外变大，这种轮次直接跳过。
    """
    if _ledger is None:
        print("[账本没开]\n")
        return
    try:
        rows = _ledger.execute(
            "SELECT ts, thread_id, in_tok, cache_hit, out_tok, calls, run_id"
            " FROM ledger WHERE tag='turn' ORDER BY id").fetchall()
    except Exception as e:
        print(f"[读账本失败 {e}]\n")
        return

    pairs = []
    for prev, cur in zip(rows, rows[1:]):
        if cur[1] != prev[1]:
            continue
        pairs.append((cur[0], cur[2], cur[3], prev[4], cur[5], cur[6], prev[2]))
    pairs = pairs[-limit:]

    if not pairs:
        print("[还没有两轮相邻的真实对话 —— 先正常聊几轮再来]\n")
        return

    print(f"[几何律检验 · 未命中 = (入 mod 64) + 64k · 单调用轮 · 最近 {len(pairs)} 对]")
    print("  时间             run      入  入mod64   命中   未命中   余额    k    Δ  │ 判定")
    ok = bad = skip = ntool = 0
    kcount = {}
    for ts, in_tok, hit, prev_out, calls, rid, prev_in in pairs:
        miss = in_tok - hit
        if calls > 1:
            ntool += 1
            print(f"  {ts[5:19]}  {rid}  {in_tok:>7,}  {'—':>7}  {hit:>6,}  {miss:>6,}"
                  f"  {'—':>5}  {'—':>3}  {'—':>4}  │ ⚙ {calls} 次调用（工具轮）")
            continue
        if hit == 0 and prev_out > 0:
            skip += 1
            print(f"  {ts[5:19]}  {rid}  {in_tok:>7,}  {'—':>7}  {hit:>6,}  {miss:>6,}"
                  f"  {'—':>5}  {'—':>3}  {'—':>4}  │ ⌫ 缓存作废轮")
            continue
        r = in_tok % 64
        bal = miss - r
        k = round(bal / 64)
        delta = in_tok - prev_in
        same = abs(bal - 64 * k) <= 1          # 64k −1 也算同一族
        if same and k >= 2:
            ok += 1
            kcount[k] = kcount.get(k, 0) + 1
            mark = f"✓ k={k}"
            if k >= 6:
                mark += f"  ⚠ Δ={delta} 太大，缓存追不上"
        else:
            bad += 1
            mark = f"✗ 余额 {bal} —— 真的例外"
        print(f"  {ts[5:19]}  {rid}  {in_tok:>7,}  {r:>7}  {hit:>6,}  {miss:>6,}"
              f"  {bal:>5}  {k:>3}  {delta:>4}  │ {mark}")

    print()
    dist = " · ".join(f"k={k}: {v}" for k, v in sorted(kcount.items()))
    print(f"  成立 {ok} · 不符 {bad} · 工具轮 {ntool} · 作废轮 {skip}"
          f"   （k 分布 {dist}）")
    if ok and bad == 0:
        print("  → 一条律：未命中 = (入 mod 64) + 64k。零例外。")
        print("     常态 k ∈ {2,3,4}。k ≥ 6 的轮次，看它的 Δ —— Δ = 上一轮可见输出 + 本轮输入。")
        print("     Δ 小（≤200）→ k 稳。Δ 大（≈470）→ k 炸（实测 7）。")
        print("     内容动不了它，但【自己上一轮说多长】能。")
    else:
        print("  → 还有例外，把这几行连 run 一起发我。")
    print()


def turns_dump(limit=40):
    """原始转储。出 >300 的行会追加原文首尾 —— 直接看见钱花在哪。"""
    if _ledger is None:
        print("[账本没开]\n")
        return
    try:
        rows = _ledger.execute(
            "SELECT ts, run_id, thread_id, tag, calls, in_tok, cache_hit, out_tok,"
            " reason_tok, band, user_head, out_head, style_on"
            " FROM ledger ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    except Exception as e:
        print(f"[读账本失败 {e}]\n")
        return
    if not rows:
        print("[账本为空]\n")
        return
    rows = rows[::-1]

    print(f"[原始转储 · 最近 {len(rows)} 行 · 时间升序 · 标签里 +尾 / −尾 表示贴尾开关]")
    print("  时间             run       thread     标签    调  时        入     命中    未命中     出   思考    k")
    prev_run = None
    for ts, rid, th, tag, c, i, h, o, r, band, uh, oh, st in rows:
        if prev_run is not None and rid != prev_run:
            print("  " + "·" * 100)
        prev_run = rid
        miss = i - h
        if c == 1 and miss:
            k = round((miss - (i % 64)) / 64)
            ks = f"{k:>4}"
        else:
            ks = "   —"
        flag = "⚙" if c > 1 else " "
        bd = "峰" if band == "peak" else "谷"
        tagc = tag + ("+尾" if st == 1 else ("−尾" if st == 0 else ""))
        print(f"  {ts[5:19]}  {rid}  {th:<10} {tagc:<7}{flag}{c:>2}  {bd}"
              f"  {i:>7,}  {h:>7,}  {miss:>7,}  {o:>5,}  {r:>5,}  {ks}")
        if o >= 300:
            if uh:
                print(f"      ↳ 问「{uh[:64]}」")
            if oh:
                print(f"      ↳ 答「{oh[:64]}」")
    print()
    print("  读法：k 应该在 2~4 之间。k ≥ 6 的行，看它上一行的「出」——")
    print("        上一行出得多，这一行的未命中就贵。那就是胖输出的二次收费。")
    print("        出 ≥300 的行会带原文首尾，那几行就是钱的主要去处。")
    print("        但如果「思考」那一列也大，钱就在看不见的地方 —— 见 /lenstat。")
    print()


def lenstat(limit=40, only_run=False):
    """助手每轮说了多少 token —— 并把【思考 / 可见】拆开。

    only_run=True 只看【本次运行】—— 判断改动有没有生效必须这样看，
    否则新轮次会被改动前的旧账稀释（6.4 就踩过这个坑）。
    """
    if _ledger is None:
        print("[账本没开]\n")
        return
    try:
        if only_run:
            rows = _ledger.execute(
                "SELECT ts, out_tok, reason_tok, calls, user_head, out_head"
                " FROM ledger WHERE tag='turn' AND run_id=? ORDER BY id",
                (RUN_ID,)).fetchall()
        else:
            rows = _ledger.execute(
                "SELECT ts, out_tok, reason_tok, calls, user_head, out_head"
                " FROM ledger WHERE tag='turn' ORDER BY id DESC LIMIT ?",
                (limit,)).fetchall()
            rows = rows[::-1]
    except Exception as e:
        print(f"[读账本失败 {e}]\n")
        return
    if not rows:
        print("[本次运行还没有真实对话]\n" if only_run else "[还没有真实对话记录]\n")
        return

    outs = [r[1] for r in rows]
    reasons = [r[2] for r in rows]
    tool_turns = sum(1 for r in rows if r[3] > 1)
    n = len(outs)
    total = sum(outs)
    total_r = sum(reasons)
    total_v = total - total_r
    avg = total / n
    med = _med(outs)
    vmed = _med([o - r for o, r in zip(outs, reasons)])
    scope = (f"本次运行 run_id={RUN_ID}" if only_run
             else f"最近 {n} 轮（含改动前的旧账，只用来看大势）")
    print(f"[助手话长 · {scope}]")
    print(f"  平均 {avg:.1f} token/轮   中位 {med:.1f}"
          f"   最短 {min(outs)}   最长 {max(outs)}   n={n}")
    print(f"  其中可见 {total_v / n:.0f}/轮   思考 {total_r / n:.0f}/轮"
          f"   ← 思考是看不见的那部分")
    if total:
        print(f"  思考占总输出 {total_r / total * 100:.0f}%"
              f"　·　可见输出中位 {vmed:.1f}（这个才是「话长」）")
    if tool_turns:
        print(f"  其中 {tool_turns} 轮是工具轮（out 是聚合值，偏大是正常的）")
    print(f"  总输出 {total:,} token · 风格贴尾 {'开' if STYLE['on'] else '关'}")
    for lo, hi, name in ((0, 20, "≤20"), (20, 50, "21-50"), (50, 100, "51-100"),
                         (100, 200, "101-200"), (200, 400, "201-400"),
                         (400, 10 ** 9, ">400")):
        c = sum(1 for o in outs if lo <= o < hi)
        print(f"  {name:>8}  {c:>3}  {'█' * c}")

    if n >= 5:
        print()
        print("  [最长的 3 轮 —— 钱在这几轮上]")
        for ts, o, r, c, uh, oh in sorted(rows, key=lambda x: -x[1])[:3]:
            share = (o / total * 100) if total else 0
            think_pct = (r / o * 100) if o else 0
            print(f"    {ts[5:19]}  出 {o:>4} ({share:>4.1f}% of 总输出)"
                  f"  思考 {r:>4}（占 {think_pct:>3.0f}%）│ 问「{uh[:24]}」")
            print(f"                 答「{oh[:52]}」")
        top3 = sum(x[1] for x in sorted(rows, key=lambda x: -x[1])[:3])
        top3r = sum(x[2] for x in sorted(rows, key=lambda x: -x[1])[:3])
        if total:
            print(f"    ↳ 这 3 轮占全部输出的 {top3 / total * 100:.0f}%"
                  f"　（其中思考 {top3r:,} = 全部思考的 "
                  f"{top3r / total_r * 100:.0f}%）" if total_r else "")
        if total:
            print(f"      杀掉它们，均值会从 {avg:.0f} 掉到 "
                  f"{(total - top3) / max(n - 3, 1):.0f}/轮")
            if total_r and top3 > top3r:
                print(f"      若连思考也压住：{(total - total_r) / n:.1f}/轮")

    if n <= 10:
        print()
        print("  [样本太少，逐轮列出]")
        for ts, o, r, c, uh, oh in rows:
            print(f"    {ts[5:19]}  出 {o:>4}  思考 {r:>4}"
                  + ("   ⚙ 工具轮" if c > 1 else ""))
            if o >= 100 and (uh or oh):
                print(f"                  问「{uh[:30]}」→「{oh[:40]}」")
    print()
    if only_run:
        print("  读法：可见 18/轮 已经在目标内 —— 可见这条线不用再动了。")
        print("        现在只有「思考」这一栏能降成本。它占总输出 82%。")
        print("        拿它跟 /style off 那一组比（/stylecmp），先分清贴尾有没有在烧它。")
    else:
        print("  读法：这个窗口混了改动前后。判断效果请跑 /lenstat run。")
    print()


def stylecmp(min_n=3):
    """贴尾开 vs 关 —— 判定它是不是拿可见的短换思考的长。

    6.7 核心实验。只统计带 style_on 标记的单调用轮：
      · 工具轮的 out 是聚合值，会污染对比，跳过
      · 6.6 及以前写的旧账没有这个字段（style_on = −1），不计入
    """
    if _ledger is None:
        print("[账本没开]\n")
        return
    try:
        rows = _ledger.execute(
            "SELECT style_on, out_tok, reason_tok, calls, user_head, cost_usd"
            " FROM ledger WHERE tag='turn' AND style_on IN (0,1) ORDER BY id").fetchall()
    except Exception as e:
        print(f"[读账本失败 {e}]\n")
        return

    groups = {0: [], 1: []}
    skipped_tool = 0
    for st, o, r, c, uh, cost in rows:
        if c > 1:
            skipped_tool += 1
            continue
        groups[st].append((o, r, o - r, cost, uh))

    if not rows:
        print("[还没有带贴尾标记的对话 —— 6.6 及以前写的账缺这个字段]\n")
        print("  跑两组再来（各 3 轮，同一批题）：")
        print("    /style on  → /new → 题A → 题B → 题C → /lenstat run")
        print("    /style off → /new → 题A → 题B → 题C → /lenstat run")
        print("    /stylecmp   一条命令出对照\n")
        return

    print("[贴尾 A/B · 只算单调用轮 · 只算本版之后写的账]")
    print(f"  {'':<10}{'n':>4}{'可见中位':>11}{'思考中位':>11}"
          f"{'总数中位':>11}{'$/轮':>13}")
    stats = {}
    for st, name in ((1, "贴尾 开"), (0, "贴尾 关")):
        g = groups[st]
        if not g:
            print(f"  {name:<10}{'—':>4}{'—':>11}{'—':>11}{'—':>11}{'—':>13}")
            continue
        stats[st] = (_med([x[2] for x in g]),
                     _med([x[1] for x in g]),
                     _med([x[0] for x in g]))
        print(f"  {name:<10}{len(g):>4}"
              f"{stats[st][0]:>11.1f}{stats[st][1]:>11.1f}"
              f"{stats[st][2]:>11.1f}"
              f"{sum(x[3] for x in g) / len(g):>13.6f}")
    if skipped_tool:
        print(f"  （跳掉 {skipped_tool} 个工具轮）")

    if len(groups[1]) >= min_n and len(groups[0]) >= min_n:
        g1, g0 = stats[1], stats[0]
        dv, dr, do = g1[0] - g0[0], g1[1] - g0[1], g1[2] - g0[2]
        print()
        print(f"  开关差值（开 − 关）：可见 {dv:+.1f} · 思考 {dr:+.1f} · 总数 {do:+.1f}")
        print()
        if dr >= 15 and dv <= -8 and abs(do) < 20:
            print("  → 预测成立。贴尾拿可见的短换了思考的长，总数不动 —— 一分钱没省。")
            print("    该修的不是措辞，是模型的掂量。前面的风格工程要重估。")
        elif abs(dr) < 15 and dv <= -8:
            print("  → 贴尾只压可见、不烧思考。它是纯赚的，继续开着。")
        elif dr <= -15 and dv >= 8:
            print("  → 反过来了：贴尾反而在压思考。那就留着它，换个方向挖。")
        elif do <= -20:
            print("  → 总量真的降了。不管它挪到哪一栏，贴尾都在省钱 —— 留着。")
        else:
            print("  → 看不出来。样本或变量不够。")
            print("    硬要求：两组各 ≥3 个单调用轮，且必须问同一批题、都从 /new 起。")
            print("    中位数对样本量很敏感 —— n=3 的结论只能当方向，不能当结论。")
    else:
        print()
        print(f"  样本不够：开 {len(groups[1])} 轮 / 关 {len(groups[0])} 轮（各需 ≥{min_n}）")
        print("  跑法：/style on  → /new → 题A 题B 题C → /lenstat run")
        print("        /style off → /new → 题A 题B 题C → /lenstat run")
        print("        /stylecmp  一条命令出对照")
    print()
    print("  ⚠ 两组都必须 /new。长历史和冷启动的思考量不一样（93146ec5 vs aae46685）。")
    print("  ⚠ 两次必须问同一批题。题目变了，这个对比就作废。")
    print()


TAIL_SHORT = "好"
TAIL_LONG = (
    "下面是一段背景资料，读完只回答一个字：好，不要复述、不要解释。资料："
    "缓存是按块切分的，每一块六十四个标记。命中的那一部分按便宜价计费，"
    "没有命中的那一部分按全价计费，两者相差五十倍。"
    "所以要弄清一轮对话里哪一段落了空，等于弄清每一轮到底在为哪一段反复付钱。"
    "如果那一段是结构性的，那么削内容就没用，只能认账；"
    "如果那一段跟着某样东西变，那就找到了真正能拧的螺丝。"
)


# 思考开关候选。思考按输出价计费，压住它 = 直接省三成的账。
# 哪个有效只能试 —— 官方文档没承诺，参数名是按常见几个流派猜的。
THINK_CANDIDATES = [
    ("baseline（什么都不加）", {}),
    ("reasoning_effort=low", {"reasoning_effort": "low"}),
    ("reasoning_effort=none", {"reasoning_effort": "none"}),
    ("thinking={type:disabled}", {"thinking": {"type": "disabled"}}),
    ("enable_thinking=False", {"enable_thinking": False}),
    ("extra_body.thinking=False",
     {"extra_body": {"chat_template_kwargs": {"thinking": False}}}),
]


def thinktest(question="123"):
    """试各种推理开关，看哪个能把【思考】压下去。

    只认「思考」那一列往下掉、且不报错的候选。
    刻意不碰主会话 —— 直接对着模型打，不污染历史、不进账本。
    一轮六次调用，冷缓存，约 $0.0013。

    ⚠ 默认题用「123」：6.7 已确认它稳定复现高思考（115 / 106）。
      基线那一行的思考量应该落在 100 上下；如果它接近 0，
      说明这次调用没进掂量状态，整轮实验作废，重跑。
    """
    print(f"\n[已进入 thinktest · 题：「{question}」· 下面 6 行是候选，不是对话]")
    print("=" * 66)
    print("  思考开关实验 · 六次调用 · 同一道题")
    print("  读法：基线那一行的思考量是分母。看哪个候选把它打下来，且不报错。")
    print("  ⚠ 基线思考量接近 0 的话，这次没进掂量状态，整轮作废，重跑。")
    print("=" * 66)
    base = None
    for name, kw in THINK_CANDIDATES:
        try:
            m = ChatDeepSeek(model=MODEL_NAME, temperature=0,
                             max_retries=0, **kw)
            mb = m.bind_tools(TOOLS)
            meter = Meter()
            res = mb.invoke(
                [SystemMessage(content=SYSTEM), HumanMessage(content=question)],
                {"callbacks": [meter]},
            )
            reply = res.content if isinstance(res.content, str) else str(res.content)
            reply = reply.replace("\n", " ").strip()
            if base is None:
                base = meter.reasoning
            cut = ""
            if base and meter.reasoning < base:
                cut = f"   ← 降 {(1 - meter.reasoning / base) * 100:.0f}%"
            print(f"  {name:<28} 出 {meter.out_tok:>5,}"
                  f"(思考 {meter.reasoning:>5,})  入 {meter.in_tok:>6,}  ✓{cut}")
            print(f"      ↳ 答「{reply[:34]}」")
        except Exception as e:
            msg = str(e).replace("\n", " ")[:70]
            print(f"  {name:<28} ✗ {type(e).__name__}: {msg}")
    if base is not None and base < 20:
        print()
        print(f"  ⚠ 基线思考量只有 {base} —— 这次没进掂量状态。整轮作废，重跑一次。")
    print()
    print("  报错 = 这个 API 不认这个参数名，不是你没配对。")
    print("  全报错 = 这家没有对外暴露思考开关，那三成只能从别处省。")
    print("  命中一个：把它加进 model = ChatDeepSeek(...) 那一行，再 /lenstat run 复核。")
    print("=" * 66 + "\n")


def tailtest(rounds=4, mode="长"):
    """尾巴里到底有什么：只换本轮用户输入的长度，看未命中动不动

    mode="短" 用 TAIL_SHORT 那条短句；mode="长" 用 TAIL_LONG。
    要测「长粘贴会不会撑破尾巴」，把 TAIL_LONG 加长到 800 token 再跑。
    """
    ask = TAIL_SHORT if mode == "短" else TAIL_LONG
    print("\n" + "=" * 66)
    print(f"  尾巴实验（约 {rounds} 次调用）· 输入 {len(ask)} 字 ≈ {len(ask) // 3} token")
    print("  不要复述、不要解释，只回一个字 —— 让输出侧不干扰未命中")
    print("=" * 66)
    tid = "tail-" + uuid.uuid4().hex[:6]
    cfg = {"configurable": {"thread_id": tid}}
    misses, outs, reasons, deltas = [], [], [], []
    prev_in = None
    for i in range(rounds):
        meter = Meter()
        cfg["callbacks"] = [meter]
        app.invoke({"messages": [HumanMessage(content=ask)]}, cfg)
        miss = meter.miss_tok()
        k = (miss - meter.in_tok % 64) / 64 if miss else 0
        delta = (meter.in_tok - prev_in) if prev_in else 0
        misses.append(miss)
        outs.append(meter.out_tok)
        reasons.append(meter.reasoning)
        deltas.append(delta)
        note = "  ⚠ Δ 太大，缓存追不上" if k >= 6 else ""
        print(f"  第{i+1}轮  入 {meter.in_tok:>6,}  命中 {meter.cache_hit:>6,}"
              f"  未命中 {miss:>5,}"
              f"  余数 {meter.in_tok % 64:>2}  k={k:.0f}  Δ={delta:>4}"
              f"  出 {meter.out_tok:>4,}(思考 {meter.reasoning:>4,}){note}")
        prev_in = meter.in_tok
        # 实验轮不走 run_turn，没挂贴尾 → style_on 留 -1
        ledger_write("tail", tid, meter, len(ask), user_head=ask, out_head="")
    warm_m = misses[1:] if len(misses) > 1 else misses
    warm_d = deltas[1:] if len(deltas) > 1 else deltas
    print(f"  ── 第 2 轮起：未命中均值 {sum(warm_m) / len(warm_m):.0f}"
          f" · Δ 均值 {sum(warm_d) / len(warm_d):.0f}"
          f" · 输出均值 {sum(outs) / len(outs):.0f}"
          f" · 思考均值 {sum(reasons) / len(reasons):.0f}")
    print()
    print("  读法：主看 k 那一列。k 稳在 2~4 = 这段输入撑不破尾巴。")
    print("        k 往上爬 = 输入超出尾巴的消化量，开始按全价算。")
    print("        想看拐点，就把 mode 改成「长」并逐次加长 TAIL_LONG。")
    print("=" * 66 + "\n")


# ============ 工具（描述已瘦身 —— 它每轮都在 prompt 里）============
ROOT = Path.cwd().resolve()


@tool
def calculator(expression: str) -> str:
    """算数学表达式，只支持数字和 + - * / ** % ( )。"""
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as e:
        return f"ERROR: 表达式不合法 {e}"
    allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
               ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod,
               ast.USub, ast.UAdd)
    if not all(isinstance(n, allowed) for n in ast.walk(tree)):
        return "ERROR: 表达式里有不允许的内容"
    try:
        return str(eval(compile(tree, "<calc>", "eval"), {"__builtins__": {}}, {}))
    except Exception as e:
        return f"ERROR: {e}"


@tool
def read_file(path: str) -> str:
    """读项目目录内的文件，path 用相对路径。"""
    p = (ROOT / path).resolve()
    if not str(p).startswith(str(ROOT)):
        return "ERROR: 越界，只能读项目目录内的文件"
    if not p.is_file():
        return f"ERROR: 找不到文件 {path}"
    try:
        # 4,000 字符 ≈ 1,300 token。工具结果必然是全价未命中，
        # 一次读取 ≈ $0.0004 ≈ 300 个输出 token，所以这个上限别放大。
        return p.read_text(encoding="utf-8", errors="replace")[:4000]
    except Exception as e:
        return f"ERROR: {e}"


TOOLS = [calculator, read_file]
TOOL_MAP = {t.name: t for t in TOOLS}


# ============ 模型 ============
_opts = {"max_tokens": MAX_OUT} if MAX_OUT else {}
model = ChatDeepSeek(model=MODEL_NAME, temperature=0, max_retries=2, **_opts)
model_with_tools = model.bind_tools(TOOLS)


# ============ 图 ============
class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


def call_model(state: AgentState):
    sys_text = SYSTEM
    if CACHE_KILLER["on"]:
        sys_text = f"[{datetime.now().isoformat()}] " + sys_text
    msgs = [SystemMessage(content=sys_text)] + list(state["messages"])
    return {"messages": [model_with_tools.invoke(msgs)]}


def call_tools(state: AgentState):
    last = state["messages"][-1]
    out = []
    for tc in last.tool_calls:
        fn = TOOL_MAP.get(tc["name"])
        try:
            result = fn.invoke(tc["args"]) if fn else f"ERROR: 没有这个工具 {tc['name']}"
        except Exception as e:
            result = f"ERROR: {type(e).__name__}: {e}"
        out.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))
    return {"messages": out}


def route(state: AgentState):
    last = state["messages"][-1]
    if getattr(last, "tool_calls", None):
        return "tools"
    return END


builder = StateGraph(AgentState)
builder.add_node("agent", call_model)
builder.add_node("tools", call_tools)
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", route, {"tools": "tools", END: END})
builder.add_edge("tools", "agent")

conn = sqlite3.connect("agent_memory.db", check_same_thread=False)
checkpointer = SqliteSaver(conn)
try:
    checkpointer.setup()
except Exception:
    pass
app = builder.compile(checkpointer=checkpointer)


# ============ 缓存实验 ============
PROBE_ASK = "回答一个字：好"


def cache_probe(killer: bool, label: str, rounds: int = 3):
    CACHE_KILLER["on"] = killer
    tid = "probe-" + uuid.uuid4().hex[:6]
    cfg = {"configurable": {"thread_id": tid}}
    print(f"\n【{label}】")
    t_in = t_hit = t_out = t_reason = 0
    t_in_cost = t_cost = 0.0
    try:
        for i in range(rounds):
            meter = Meter()
            cfg["callbacks"] = [meter]
            res = app.invoke({"messages": [HumanMessage(content=PROBE_ASK)]}, cfg)
            rate = (meter.cache_hit / meter.in_tok * 100) if meter.in_tok else 0.0
            print(f"  第{i+1}轮  入 {meter.in_tok:>6,}(命中 {meter.cache_hit:>6,}"
                  f" = {meter.cache_hit // 64} 块)  命中率 {rate:>5.1f}%"
                  f"  │ 未命中 {meter.miss_tok():>5,}  │ 输入 ${meter.in_cost():.6f}")
            last = res["messages"][-1]
            raw = last.content
            reply = raw if isinstance(raw, str) else str(raw)
            reply = reply.replace("\n", " ").strip()
            print(f"         出 {meter.out_tok:>6,}(思考 {meter.reasoning:>5,})"
                  f"  │ 回复「{reply[:30]}」")
            if i == 0:
                print(f"         [诊断] usage_metadata = {last.usage_metadata}")
            t_in += meter.in_tok
            t_hit += meter.cache_hit
            t_out += meter.out_tok
            t_reason += meter.reasoning
            t_in_cost += meter.in_cost()
            t_cost += meter.cost()
            # 实验轮不走 run_turn，没挂贴尾 → style_on 留 -1
            ledger_write("probe", tid, meter, len(PROBE_ASK),
                         user_head=PROBE_ASK, out_head=reply)
    finally:
        CACHE_KILLER["on"] = False
    rate = (t_hit / t_in * 100) if t_in else 0
    print(f"  ── 合计  入 {t_in:,}(命中 {t_hit:,})  命中率 {rate:.1f}%"
          f"  │ 出 {t_out:,}(思考 {t_reason:,})")
    print(f"  ── 输入侧 ${t_in_cost:.6f}   │ 总花费 ${t_cost:.6f}")


# ============ 命令行 ============
STATE = {"thread": "main"}

# 按【首词】判断，带参数的命令才不会被误杀
# （6.5 修：以前 /turns 40、/misscheck 40 会被守卫判成未知命令）
KNOWN_BASE = {"/new", "/history", "/cost", "/ledger", "/turns", "/cachetest",
              "/anatomy", "/misscheck", "/lenstat", "/tailtest", "/style",
              "/thinktest", "/stylecmp", "/exit"}


def run_turn(text: str):
    cfg = {"configurable": {"thread_id": STATE["thread"]}}
    meter = Meter()
    cfg["callbacks"] = [meter]

    # 风格贴尾：挂在用户消息最末尾。这段落在「必然未命中」的尾巴里，
    # 边际成本 ≈ 0，而且它离模型最近 —— 开头 7,000 token 前的系统提示够不着。
    content = text
    if STYLE["on"]:
        content = f"{text}\n{STYLE_SUFFIX}"

    print("\n助手 > ", end="", flush=True)
    reply_parts = []
    try:
        for chunk, meta in app.stream(
            {"messages": [HumanMessage(content=content)]},
            cfg,
            stream_mode="messages",
        ):
            if meta.get("langgraph_node") == "agent" and getattr(chunk, "content", ""):
                reply_parts.append(chunk.content)
                print(chunk.content, end="", flush=True)
        print()
    except Exception as e:
        print(f"\n  ── [调用失败 {type(e).__name__}: {e}] —— 会话还在，可以继续问")

    try:
        if meter.calls:
            meter.report("本轮 ")
            SESSION["calls"] += meter.calls
            SESSION["in"] += meter.in_tok
            SESSION["out"] += meter.out_tok
            SESSION["hit"] += meter.cache_hit
            SESSION["reason"] += meter.reasoning
            SESSION["cost"] += meter.cost()
            SESSION["turns"] += 1
            if meter.calls > 1:
                SESSION["tool_turns"] += 1
            if meter.truncated:
                SESSION["truncated"] += 1
            ledger_write("turn", STATE["thread"], meter, len(text),
                         user_head=text, out_head="".join(reply_parts),
                         style_on=1 if STYLE["on"] else 0)
    except Exception as e:
        print(f"  ── [记账异常 {type(e).__name__}: {e}] —— 对话继续")
    print()


def main():
    ledger_init()
    band = "峰时（全价）" if is_peak_now() else "谷时（半价）"
    print("=" * 66)
    print("  阶段 6.7 · 贴尾 A/B")
    print(f"  模型 {MODEL_NAME} | 当前 {band} | thread={STATE['thread']}")
    print(f"  风格贴尾 {'开' if STYLE['on'] else '关'}：{STYLE_SUFFIX}")
    if MAX_OUT:
        print(f"  ⚠ 输出封顶 max_tokens={MAX_OUT} —— 实测会切断正常答案，建议撤掉")
        print(f"    （set MAX_OUT=  清空，或设 400 当保险丝）")
    print(f"  run_id={RUN_ID} | 账本 {LEDGER_PATH.resolve()}")
    a = ledger_totals()
    if a and a[6] > 0:
        since = (ledger_since() or "")[:10]
        print(f"  历史累计 {a[0]} 次调用 · 入 {a[1]:,}(缓存 {a[2]:,})"
              f" · 出 {a[3]:,}(思考 {a[4]:,}) · ${a[5]:.6f}  (起自 {since}, {a[6]} 行)")
    else:
        print("  历史累计：账本为空，这是第一笔")
    print("  /new 新会话  /history 存档点  /cost 账单  /ledger 账本  /turns 40 原始转储")
    print("  /anatomy 解剖  /misscheck 20 几何律  /lenstat 话长  /lenstat run 只看本次")
    print("  /cachetest 缓存实验  /tailtest 尾巴实验  /style on|off 风格贴尾")
    print("  /stylecmp 贴尾 A/B ← 本版核心")
    print("  /thinktest [题] 思考开关实验   （命令都要带 /，不带会自动补上并提示）")
    print("=" * 66 + "\n")

    while True:
        try:
            text = input("你 > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见。")
            break
        if not text:
            continue

        if text.lower().lstrip("/") in ("exit", "quit", "q", "退出", "再见"):
            print("再见。")
            break

        # 少了斜杠的命令：自动补上。
        # 否则它会变成一条真·付费消息 —— 6.5 实测踩过：/thinktest 打成 thinktest，
        # 两轮 $0.0001，而且账本里留下两行认不出来的 turn。
        if text and not text.startswith("/"):
            _first = text.split()[0].lower()
            if ("/" + _first) in KNOWN_BASE:
                print(f"[自动补上斜杠：/{_first}]\n")
                text = "/" + text

        # 守卫：只看首词。带参数的命令（/turns 40、/thinktest 123）也要放行。
        _parts = text.split()
        _base = _parts[0].lower() if _parts else text.lower()
        if text.startswith("/") and _base not in KNOWN_BASE:
            print(f"[未知命令 {_base}，没有发给模型 —— 省一次调用]\n")
            continue

        if text == "/new":
            STATE["thread"] = uuid.uuid4().hex[:8]
            print(f"[已开新会话 thread_id={STATE['thread']}]")
            print("  （新会话 = 冷缓存，第一轮要重付整个 prompt 的未命中；")
            print("    但历史清空后，风格规则才真正可控 —— 6.4.1 的核心结论）\n")
            continue

        if text == "/anatomy":
            anatomy()
            continue

        if text == "/misscheck":
            misscheck()
            continue

        if text.startswith("/misscheck "):
            try:
                misscheck(int(_parts[1]))
            except Exception:
                print("[用法：/misscheck 40 —— 数字是对数]\n")
            continue

        if text == "/lenstat":
            lenstat()
            continue

        if text == "/lenstat run":
            lenstat(only_run=True)
            continue

        if text == "/stylecmp":
            stylecmp()
            continue

        if text == "/turns":
            turns_dump(40)
            continue

        if text.startswith("/turns "):
            try:
                turns_dump(int(_parts[1]))
            except Exception:
                print("[用法：/turns 40 —— 数字是行数]\n")
            continue

        if text == "/style":
            print(f"[风格贴尾当前 {'开' if STYLE['on'] else '关'}]")
            print(f"  贴的内容：{STYLE_SUFFIX}")
            print("  它挂在用户消息最末尾，落在必然未命中的尾巴里，边际成本 ≈ 0。")
            print("  ⚠ 但它可能在烧思考。判定方法：/stylecmp")
            print("  用法：/style on  /style off\n")
            continue

        if text == "/style on":
            STYLE["on"] = True
            print("[风格贴尾已开]")
            print(f"  每条用户消息后面会挂：{STYLE_SUFFIX}")
            print("  ⚠ 预测：关掉后【思考 ↓ · 可见 ↑ · 总数 ≈ 不变】。")
            print("     三条同时中 = 贴尾是零和游戏，前面的风格工程要重估。")
            print("     思考一动不动 = 贴尾无罪，去跑 /thinktest。")
            print("     两次都必须 /new —— 长历史和冷启动的思考量不一样。\n")
            continue

        if text == "/style off":
            STYLE["on"] = False
            print("[风格贴尾已关]")
            print("  接下来这几轮会被标 style_on=0，/stylecmp 会自动分组对照。")
            print("  ⚠ 记得先 /new，再问跟开着时【同一批】问题。\n")
            continue

        if text == "/thinktest":
            thinktest()
            continue

        if text.startswith("/thinktest "):
            thinktest(text.split(None, 1)[1])
            continue

        if text == "/tailtest" or text == "/tailtest 长":
            tailtest(4, "长")
            continue

        if text == "/tailtest 短":
            tailtest(4, "短")
            continue

        if text == "/history":
            cfg = {"configurable": {"thread_id": STATE["thread"]}}
            snaps = list(app.get_state_history(cfg))
            print(f"[本会话共 {len(snaps)} 个存档点，最近 5 个]")
            for s in snaps[:5]:
                nxt = s.next[0] if s.next else "结束"
                cid = s.config["configurable"].get("checkpoint_id", "")
                print(f"  step={s.metadata.get('step'):<3} next={nxt:<12} id=…{cid[-8:]}")
            print()
            continue

        if text == "/cost":
            band = "峰" if is_peak_now() else "谷"
            print("[本次运行 · 只算真实对话]")
            print(f"  调用 {SESSION['calls']} 次 · 入 {SESSION['in']:,}（缓存 {SESSION['hit']:,}）"
                  f" · 出 {SESSION['out']:,}（思考 {SESSION['reason']:,}）"
                  f" · ${SESSION['cost']:.6f}   （按{band}时价）")
            if SESSION["in"]:
                print(f"  缓存命中率 {SESSION['hit'] / SESSION['in'] * 100:.1f}%")
                miss = SESSION["in"] - SESSION["hit"]
                print(f"  未命中合计 {miss:,} · 贴尾 {'开' if STYLE['on'] else '关'}")
            if SESSION["out"]:
                v = SESSION["out"] - SESSION["reason"]
                p = PRICE.get(MODEL_NAME, PRICE["deepseek-flash"])
                pb = "peak" if is_peak_now() else "off"
                vc = v / 1e6 * p["out"][pb]
                rc = SESSION["reason"] / 1e6 * p["out"][pb]
                print(f"  输出拆分 · 可见 {v:,}({v / SESSION['out'] * 100:.0f}%)"
                      f" · 思考 {SESSION['reason']:,}"
                      f"({SESSION['reason'] / SESSION['out'] * 100:.0f}%)")
                if SESSION["cost"]:
                    print(f"  可见输出 ${vc:.6f}（占总花费 {vc / SESSION['cost'] * 100:.0f}%）"
                          f" · 思考 ${rc:.6f}（占 {rc / SESSION['cost'] * 100:.0f}%）")
            if SESSION["tool_turns"]:
                print(f"  其中 {SESSION['tool_turns']} 轮是工具轮")
            if SESSION["truncated"]:
                print(f"  ⚠ 有 {SESSION['truncated']} 轮撞到输出上限被截断")
            think_share(SESSION["reason"], SESSION["cost"])

            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            t = ledger_totals(today)
            if t:
                print(f"[今日 {today} UTC · 含实验]")
                print(f"  调用 {t[0]} 次 · 入 {t[1]:,}（缓存 {t[2]:,}）"
                      f" · 出 {t[3]:,}（思考 {t[4]:,}）"
                      f" · ${t[5]:.6f}   （{t[6]} 行）")
                think_share(t[4], t[5])

            a = ledger_totals()
            if a and a[6] > 0:
                since = (ledger_since() or "")[:10]
                print(f"[历史累计 · 起自 {since}]")
                print(f"  调用 {a[0]} 次 · 入 {a[1]:,}（缓存 {a[2]:,}）"
                      f" · 出 {a[3]:,}（思考 {a[4]:,}）"
                      f" · ${a[5]:.6f}   （{a[6]} 行）")
                if a[1]:
                    print(f"  总缓存命中率 {a[2] / a[1] * 100:.1f}%")
                think_share(a[4], a[5])
            elif a:
                print(f"[历史累计]  账本里还没有记录（{a[6]} 行）")
            print()
            continue

        if text == "/ledger":
            rows = ledger_rows(12)
            if not rows:
                print("[账本还是空的]\n")
                continue
            print("[最近 12 行]  calls>1 = 工具轮 · 标签 +尾/−尾 = 贴尾开/关")
            print("  时间            标签     thread        调用      入      缓存     出      思考      花费    run    问/答")
            for (ts, tag, th, c, i, h, o, r, cost, rid, uh, oh, st) in rows:
                flag = "⚙" if c > 1 else " "
                head = (uh[:14] + "…" + oh[:14]) if uh else ""
                tagc = tag + ("+尾" if st == 1 else ("−尾" if st == 0 else ""))
                print(f"  {ts[5:19]}  {tagc:<7} {th:<11} {flag}{c:>3}  {i:>7,}  {h:>7,}"
                      f"  {o:>5,}  {r:>6,}  ${cost:.6f}  {rid}  {head}")
            print("\n[按天汇总 · 最近 7 天]")
            for day, c, i, h, o, r, cost in ledger_days(7):
                rate = (h / i * 100) if i else 0
                rs = (r / o * 100) if o else 0
                print(f"  {day}  调用 {c:>3} · 入 {i:>8,}（命中 {rate:>4.1f}%）"
                      f" · 出 {o:>7,}(思考 {r:>7,} = {rs:>2.0f}%) · ${cost:.6f}")
            print()
            print("  想看透未命中逐轮的变化，用 /turns 40。")
            print("  想看贴尾开/关的对照，用 /stylecmp。")
            print()
            continue

        if text == "/cachetest":
            print("\n" + "=" * 66)
            print("  缓存攻防实验（约 6 次调用）")
            print("  读法：只看【输入侧】，总花费会被思考 token 的随机波动污染")
            print("  另外留意：命中量永远整除 64 —— 缓存按 64 token 切块")
            cache_probe(False, "A 前缀稳定 —— 应该每轮都命中")
            cache_probe(True,  "B 每次调用换新时间戳 —— 应该每轮都 0%")
            print("\n" + "=" * 66 + "\n")
            continue

        run_turn(text)


if __name__ == "__main__":
    main()