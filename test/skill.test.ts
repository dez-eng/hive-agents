/**
 * v4 M4.2b skill 装载的零 API 测试。
 *
 * 要证明三件事：
 *   1. 清单：只扫一层 `*.md`、名字白名单、超限跳过、标题取第一条 `# `
 *   2. 装载：只接受冻结清单里的名字；按身份装配
 *   3. 贴尾：只改**发送视图**里最后一条 HumanMessage —— checkpoint 一个字节不动
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';

import { HiveAgent } from '../src/core/agent.js';
import { findCommand, type Ctx } from '../src/commands.js';
import {
  CAPABILITIES,
  declaredOnly,
  registerCapabilityTools,
  toolNamesFor,
  toolsCharsFor,
} from '../src/core/capability.js';
import { Ledger } from '../src/core/ledger.js';
import { SessionTally } from '../src/core/meter.js';
import { AGENTS, getModule } from '../src/core/modules.js';
import { newReplState } from '../src/core/session.js';
import { parseSettings } from '../src/core/settings.js';
import {
  SKILL_TOOL,
  activateSkills,
  enableSkillFor,
  loadSkillByName,
  loadSkillTool,
  scanSkills,
  setSkillSummary,
  skillTitle,
  withSkill,
} from '../src/core/skill.js';

const REVIEW = `# 代码复核

只报有证据的问题，每条带文件与行号。
`;

interface FakeTurn {
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
}

/** 记下每次 _generate 收到的完整消息列表（发送视图就在这里） */
class SpyChat extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  private calls = 0;
  constructor(private readonly turns: FakeTurn[]) {
    super({});
  }
  _llmType(): string {
    return 'spy';
  }
  override bindTools(): this {
    return this;
  }
  override async _generate(messages: BaseMessage[]): Promise<any> {
    this.seen.push(messages);
    const t = this.turns[Math.min(this.calls, this.turns.length - 1)]!;
    this.calls += 1;
    const msg = new AIMessage({
      content: t.content,
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      ...(t.toolCalls ? { tool_calls: t.toolCalls } : {}),
    });
    return { generations: [{ message: msg, text: t.content }] };
  }
}

const origCaps = Object.fromEntries(
  (Object.keys(AGENTS) as Array<keyof typeof AGENTS>).map((k) => [k, [...AGENTS[k].capabilities]]),
) as Record<keyof typeof AGENTS, string[]>;

function restore(): void {
  for (const k of Object.keys(AGENTS) as Array<keyof typeof AGENTS>) {
    AGENTS[k].capabilities = [...origCaps[k]] as typeof AGENTS[typeof k]['capabilities'];
  }
  registerCapabilityTools('skill', []);
  setSkillSummary(null);
}

function withSkillDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hive-skill-'));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

test.after(restore);

test('扫描：只认一层 *.md，非法名字与子目录跳过，标题取第一条 # 行', () => {
  withSkillDir((dir) => {
    writeFileSync(join(dir, 'review.md'), REVIEW, 'utf8');
    writeFileSync(join(dir, 'plain.md'), '没有标题\n正文', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'x', 'utf8');
    writeFileSync(join(dir, 'bad name.md'), '# x', 'utf8');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'deep.md'), '# 深层', 'utf8');

    const scan = scanSkills(dir);
    assert.deepEqual(scan.skills.map((s) => s.name).sort(), ['plain', 'review']);
    assert.equal(scan.skills.find((s) => s.name === 'review')!.title, '代码复核');
    assert.equal(scan.skills.find((s) => s.name === 'plain')!.title, 'plain');
    assert.ok(scan.warnings.some((w) => w.includes('bad name.md')), '非法名字要说出来');
  });
});

test('扫描：目录不存在 = 0 个 skill，不报错；超限跳过', () => {
  withSkillDir((dir) => {
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(200), 'utf8');
    const scan = scanSkills(dir, { maxBytes: 50 });
    assert.equal(scan.skills.length, 0);
    assert.ok(scan.warnings.some((w) => w.includes('超过上限')));
    assert.deepEqual(scanSkills(join(dir, 'nope')).skills, []);
  });
});

test('标题：没有 # 行就退回文件名', () => {
  assert.equal(skillTitle('普通文本\n', 'x'), 'x');
  assert.equal(skillTitle('#  两个空格  \n', 'x'), '两个空格');
});

test('settings：skills.dir/agents 解析，写坏给原因', () => {
  const ok = parseSettings({ skills: { dir: 'my-skills', agents: ['A', 'B'] } });
  assert.ok(ok.ok);
  assert.equal(ok.value.skills?.dir, 'my-skills');
  assert.deepEqual(ok.value.skills?.agents, ['A', 'B']);

  const def = parseSettings({ skills: {} });
  assert.ok(def.ok);
  assert.equal(def.value.skills?.dir, '.hive/skills');
  assert.deepEqual(def.value.skills?.agents, ['A']);

  assert.equal(parseSettings({ skills: [] }).ok, false);
  assert.equal(parseSettings({ skills: { dir: '  ' } }).ok, false);
  assert.equal(parseSettings({ skills: { agents: 'A' } }).ok, false);
});

test('装载：只接受冻结清单里的名字，未知名字给可用清单', () => {
  withSkillDir((dir) => {
    writeFileSync(join(dir, 'review.md'), REVIEW, 'utf8');
    const scan = scanSkills(dir);
    setSkillSummary({ dir: scan.dir, skills: scan.skills, agents: ['A'] });

    const ok = loadSkillByName('review');
    assert.ok(ok.ok);
    assert.equal(ok.skill.text, REVIEW);

    setSkillSummary(null);
    const none = loadSkillByName('review');
    assert.equal(none.ok, false);
    assert.ok(none.msg.includes('skills.dir'));

    setSkillSummary({ dir: scan.dir, skills: scan.skills, agents: ['A'] });
    const miss = loadSkillByName('../etc/passwd');
    assert.equal(miss.ok, false);
    assert.ok(miss.msg.includes('review'), '要把可用名字带上');
  });
});

test('withSkill：只克隆发送视图，不改入参', () => {
  const msgs = [new HumanMessage('原问题')];
  const out = withSkill(msgs, { name: 'review', text: 'USE THIS' });
  assert.notEqual(out, msgs);
  assert.equal((msgs[0] as HumanMessage).content, '原问题');
  const sent = (out[0] as HumanMessage).content as string;
  assert.ok(sent.startsWith('原问题'));
  assert.ok(sent.includes('【skill:review】'));
  assert.ok(sent.includes('USE THIS'));
  assert.equal(withSkill(msgs, null), msgs, '没装 = 原样返回同一个数组');
});

test('装配：skills.agents 之外的身份没有 load_skill；declaredOnly 不再列出 skill', () => {
  activateSkills(scanSkills(join(tmpdir(), 'hive-skill-不存在')), ['A']);
  assert.ok(!toolNamesFor('A').includes(SKILL_TOOL), '清单为空时不注册');

  withSkillDir((dir) => {
    writeFileSync(join(dir, 'review.md'), REVIEW, 'utf8');
    activateSkills(scanSkills(dir), ['A']);
    assert.ok(toolNamesFor('A').includes(SKILL_TOOL));
    assert.ok(!toolNamesFor('C').includes(SKILL_TOOL), '没开 skill 的身份不该有');
    assert.ok(!declaredOnly().includes('skill'));
    assert.equal(CAPABILITIES.skill.tools.length, 1);
  });
});

test('缓存：注册 load_skill 只让装了的身份多付 schema', () => {
  // 前面的用例可能已经激活过 —— 先回到干净状态再量
  registerCapabilityTools('skill', []);
  AGENTS.A.capabilities = [...origCaps.A] as typeof AGENTS.A.capabilities;

  const beforeA = toolsCharsFor('A');
  const beforeC = toolsCharsFor('C');
  registerCapabilityTools('skill', [loadSkillTool]);
  enableSkillFor(['A']);
  assert.ok(toolsCharsFor('A') > beforeA);
  assert.equal(toolsCharsFor('C'), beforeC, 'C 没装，字符数一个不差');
});

test('真链路：工具装载 → 发送视图带 skill，checkpoint 不带', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-skill-run-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  try {
    writeFileSync(join(dir, 'review.md'), REVIEW, 'utf8');
    activateSkills(scanSkills(dir), ['A']);

    const chat = new SpyChat([
      { content: '', toolCalls: [{ name: SKILL_TOOL, args: { name: 'review' }, id: 's1' }] },
      { content: '按复核清单看过了' },
    ]);
    const agent = new HiveAgent({
      model: 'deepseek-flash',
      memoryPath: join(dir, 'm.db'),
      chat,
    });

    const req = {
      text: '复核一下 a.ts',
      threadId: 't1',
      module: getModule('assistant')!,
      tail: true,
      agent: 'A' as const,
    };
    const res = await agent.run(req);
    assert.equal(res.text, '按复核清单看过了');
    assert.equal(chat.seen.length, 2, '一次工具轮 = 两次模型调用');

    const first = chat.seen[0]!.at(-1) as HumanMessage;
    assert.ok(!String(first.content).includes('【skill:review】'), '装载前不该有 skill');

    const second = chat.seen[1]!;
    // 工具轮的历史末尾是 ToolMessage —— skill 贴的是**那条 HumanMessage**，
    // 所以要从整份发送视图里找，而不是只看末尾
    const humans2 = second.filter((m) => m instanceof HumanMessage) as HumanMessage[];
    const sent = String(humans2.at(-1)!.content);
    assert.ok(sent.includes('【skill:review】'), '装载后发送视图要带上 skill');
    assert.ok(sent.includes('只报有证据的问题'), '全文要贴进去');

    // 第二轮 request 里那条 HumanMessage 在历史中（不是末尾）—— 仍然带上
    const hist = await agent.history('t1');
    const humans = hist.filter((m) => m instanceof HumanMessage) as HumanMessage[];
    assert.equal(humans.length, 1);
    assert.ok(String(humans[0]!.content).includes('复核一下 a.ts'));
    assert.ok(
      !String(humans[0]!.content).includes('【skill:review】'),
      'checkpoint 里不能有 skill 全文',
    );
    assert.equal(agent.skillOf('t1')?.name, 'review', '工具装载按 thread 记住');
    assert.equal(agent.skillOf('别的 thread'), null);
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
});

test('/skill：list / load / off 的状态流转', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-skill-cmd-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  try {
    writeFileSync(join(dir, 'review.md'), REVIEW, 'utf8');
    activateSkills(scanSkills(dir), ['A']);
    const agent = new HiveAgent({
      model: 'deepseek-flash',
      memoryPath: join(dir, 'm.db'),
      chat: new SpyChat([{ content: 'x' }]),
    });
    const lines: string[] = [];
    const ctx: Ctx = {
      agent,
      ledger: led,
      session: new SessionTally(),
      state: newReplState('main'),
      out: (s = '') => {
        lines.push(s);
      },
    };
    const cmd = findCommand('/skill')!;

    await cmd.run(ctx, ['load', 'review']);
    assert.equal(agent.skillOf('main')?.name, 'review');
    assert.ok(lines.join('\n').includes('已装载'));

    lines.length = 0;
    await cmd.run(ctx, ['list']);
    assert.ok(lines.join('\n').includes('▸'));
    assert.ok(lines.join('\n').includes('代码复核'));

    lines.length = 0;
    await cmd.run(ctx, ['load', 'nope']);
    assert.ok(lines.join('\n').includes('没有 skill nope'));
    assert.equal(agent.skillOf('main')?.name, 'review', '装载失败不动现状');

    await cmd.run(ctx, ['off']);
    assert.equal(agent.skillOf('main'), null);
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
});
