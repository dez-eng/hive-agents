/**
 * 一句话备注 —— 右栏每段思考后面那行中文小字。
 *
 * 为什么不是前端自己截一句：模型的思考正文是**英文**（deepseek 系列一律用英文想），
 * 直接贴给用户看不懂。所以每段思考结束再调一次 flash，让它用中文说清「此刻在干什么」。
 * 实测成本：输入约 300–1200 字 + 输出 30 字，单价按 flash 算不到一分钱。
 *
 * 三条护栏：
 *   · **串行**：一段一轮里可能连开几段思考，串行保证了备注顺序与事件顺序一致。
 *   · **超时就放弃**：模型卡住不能拖住 UI，8s 拿不到就退回规则版。
 *   · **开关**：`HIVE_UI_GIST=0` 直接走规则版，一分钱不多花。
 */
import { ChatDeepSeek } from '@langchain/deepseek';
import { HumanMessage } from '@langchain/core/messages';

import { modelName } from './config.js';

export interface GistResult {
  gist: string;
  source: 'model' | 'rule';
}

export interface GistOptions {
  /** 这段思考的正文（英文） */
  thinking: string;
  /** 用户这一轮说了什么 —— 有上下文才说得准「它在干什么」 */
  task?: string;
  model?: string;
  timeoutMs?: number;
}

/** 思考送进去的前多少字。再长对「一句话总结」也没有增益，只是烧钱 */
const THINK_CLIP = 1200;
const MAX_GIST = 48;

const SYSTEM = [
  '你在替用户旁注另一个 AI 的思考。用户只想知道「它此刻在干什么」。',
  '输出**一句**中文，不超过 30 字，句式像旁注：「先看现有代码，再决定改哪一处」。',
  '硬性要求：',
  '- 只描述动作与意图，不要复述它想出来的内容、答案、方案；',
  '- 不要输出编号、序号、列表、步骤清单（那是答案，不是旁注）；',
  '- 不要以数字开头，不要加引号、解释、前缀；',
  '- 绝对不要输出工具调用、标签、代码或 XML 片段。',
].join('\n');

/** 判一条备注是不是在「复述答案」：编号开头或有多个序号 */
export function looksLikeAnswer(s: string): boolean {
  if (/^\s*\d+\s*[.、)）]/.test(s)) return true;
  return (s.match(/\d+\s*[.、)）]/g) ?? []).length >= 2;
}

/** 规则版：做不到中文（原文是英文），但至少给一条能看的痕迹，并标明来源 */
export function ruleGist(thinking: string): string {
  const lines = thinking
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines[lines.length - 1] ?? '';
  const src = tail || thinking.trim();
  if (!src) return '（这段思考没有正文）';
  const cut = src.length > MAX_GIST ? `${src.slice(0, MAX_GIST)}…` : src;
  return cut;
}

/** 备注本身也别太脏：去掉引号、换行、多余空白，以及模型擅自续写的工具语法 */
function tidy(s: string): string {
  const one = s
    // 实测：不拦的话模型会接着往外吐 `<read_file> <path>src/...`，
    // 那是它把「下一步要调的工具」也写进备注了 —— 右栏只要一句中文。
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return one.length > MAX_GIST ? `${one.slice(0, MAX_GIST)}…` : one;
}

/** 串行队列：上一个备注回来再发下一个，顺序与思考顺序一致 */
let queue: Promise<unknown> = Promise.resolve();

async function callModel(o: GistOptions, thinking: string): Promise<string> {
  const llm = new ChatDeepSeek({
    model: o.model ?? modelName(),
    temperature: 0,
    maxRetries: 0,
    maxTokens: 80,
    // 备注是「总结」不是「再想一遍」——关掉思考，省一半 token
    modelKwargs: { thinking: { type: 'disabled' } },
  });
  const user = [
    o.task ? `【用户这一轮的请求】\n${o.task.slice(0, 400)}\n` : '',
    `【它的思考】\n${thinking.slice(0, THINK_CLIP)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 8000);
  try {
    const res = await llm.invoke([new HumanMessage(user)], { signal: ac.signal });
    const text = typeof res.content === 'string' ? res.content : '';
    return tidy(text);
  } finally {
    clearTimeout(timer);
  }
}

/** 模型只想着组织答案时的中性旁注 —— 比硬塞一段复述诚实 */
const ANSWERING = '（在直接组织回答，没走工具）';

/**
 * 生成一句话备注。**永不抛异常** —— UI 缺一行字远好过对话中断。
 */
export async function gistFor(o: GistOptions): Promise<GistResult> {
  const thinking = (o.thinking ?? '').trim();
  if (!thinking) return { gist: '（这段思考没有正文）', source: 'rule' };
  if (process.env.HIVE_UI_GIST === '0') return { gist: ruleGist(thinking), source: 'rule' };

  const run = queue.then(async (): Promise<GistResult> => {
    try {
      const gist = await callModel(o, thinking);
      if (!gist) return { gist: ruleGist(thinking), source: 'rule' };
      // 实测过：思考里直接就是答案时，模型会把答案抄成「1. … 2. …」。
      // 那不是旁注，宁可给一句中性的，也不要在右栏贴一份和左边重复的清单。
      if (looksLikeAnswer(gist)) return { gist: ANSWERING, source: 'rule' };
      return { gist, source: 'model' };
    } catch {
      // 断网 / 没 key / 超时：退规则版，别让右栏空着
      return { gist: ruleGist(thinking), source: 'rule' };
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** 测试用：等队列里所有备注落地 */
export async function gistDrained(): Promise<void> {
  await queue.catch(() => undefined);
}
