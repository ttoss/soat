import {
  apiCall,
  createMcpRouter,
  McpServer,
  registerToolFromSchema,
} from '@ttoss/http-server-mcp';

import { version } from '../../package.json' with { type: 'json' };
import { soatTools } from '../lib/soatTools';
import { toMcpText } from './toMcpText';

const mcpServer = new McpServer({
  name: 'soat',
  title: 'SOAT',
  version,
  description:
    'Infrastructure for AI Apps — backend, identity, storage, memory, and orchestration. LLMs docs: https://soat.ttoss.dev/llms.txt',
  websiteUrl: 'https://soat.ttoss.dev',
  icons: [
    {
      src: 'https://soat.ttoss.dev/img/soat-logo.png',
      mimeType: 'image/png',
    },
  ],
});

// Register all SOAT tools as MCP tools
for (const tool of soatTools) {
  registerToolFromSchema(mcpServer, {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (args: Record<string, unknown>) => {
      const data = await apiCall(
        tool.method,
        tool.path(args),
        tool.body ? { body: tool.body(args) } : {}
      );
      return { content: [{ type: 'text' as const, text: toMcpText(data) }] };
    },
  });
}

const mcpRouter = createMcpRouter(mcpServer, {
  apiBaseUrl: `http://localhost:${process.env.PORT || 5047}/api/v1`,
  getApiHeaders: (ctx) => {
    return {
      authorization: (ctx.headers.authorization as string) ?? '',
    };
  },
});

export { mcpRouter };
