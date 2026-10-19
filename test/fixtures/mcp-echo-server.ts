/**
 * 真机验收用的最小 MCP stdio server（fixture）。
 *
 * 不属于 npm test（文件名不是 *.test.ts），只给 M4.2 的真机探针用：
 *   node --import tsx test/fixtures/mcp-echo-server.ts
 *
 * 提供两个工具：
 *   echo(text)        —— 回显，证明请求/响应通了
 *   sum(a, b)         —— 数字相加，证明参数 schema 与类型转换通了
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'hive-echo', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '回显给定文本',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text'],
      },
    },
    {
      name: 'sum',
      description: '两个整数相加',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'integer', description: '第一个数' },
          b: { type: 'integer', description: '第二个数' },
        },
        required: ['a', 'b'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (req.params.name === 'echo') {
    return { content: [{ type: 'text', text: `echo: ${String(args['text'] ?? '')}` }] };
  }
  if (req.params.name === 'sum') {
    const a = Number(args['a'] ?? 0);
    const b = Number(args['b'] ?? 0);
    return { content: [{ type: 'text', text: String(a + b) }] };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
