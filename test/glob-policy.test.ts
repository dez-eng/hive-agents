/**
 * 真机回归：`glob` 的 pattern 不是路径，不该被能力网关当成路径做 realpath 检查。
 *
 * 曾经的 bug：模型调 `glob { pattern: "src/**" }`，网关把 pattern 解析成
 * `D:\langchain\src\**\*.ts`，父目录不存在 → 判越界 → 工具被拒。
 * 现在网关对 glob 用 `.`（roots 内），真正的越界仍由工具层「只从 roots 遍历」兜住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

import { HiveAgent } from '../src/core/agent.js';
import { getModule } from '../src/core/modules.js';

class FakeChat extends BaseChatModel {
  calls = 0;
  readonly seen: BaseMessage[][] = [];
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'fake';
  }
  override bindTools(): this {
    return this;
  }
  override async _generate(messages: BaseMessage[]): Promise<any> {
    this.seen.push(messages);
    const t =
      this.calls === 0
        ? { content: '', toolCalls: [{ name: 'glob', args: { pattern: 'src/core/*.ts' }, id: 'g1' }] }
        : { content: '看到了' };
    this.calls += 1;
    const msg = new AIMessage({
      content: t.content,
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      ...('toolCalls' in t ? { tool_calls: t.toolCalls } : {}),
    });
    return { generations: [{ message: msg, text: t.content }] };
  }
}

test('glob 的 pattern 不再被网关误判越界', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-glob-'));
  try {
    const chat = new FakeChat();
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });
    const res = await agent.run({
      text: '列一下 src/core 的 ts 文件',
      threadId: 'main',
      module: getModule('assistant')!,
      tail: false,
      agent: 'A',
    });

    assert.equal(res.text, '看到了');
    const toolMsg = chat.seen[1]!.at(-1)!;
    const body = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
    assert.ok(!body.includes('被策略拒绝'), `glob 不该被策略拒：${body}`);
    assert.match(body, /src[\\/]core[\\/]/, `glob 该真的列出文件：${body}`);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶尔删不掉 */
    }
  }
});
