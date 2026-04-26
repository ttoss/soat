import { createMcpRouter, McpServer } from '@ttoss/http-server-mcp';

import { registerTools } from './tools/index';

const mcpServer = new McpServer({
  name: 'soat',
  title: 'SOAT',
  version: '1.0.0',
  description:
    'Infrastructure for AI Apps — backend, identity, storage, memory, and orchestration. LLMs docs: https://soat.ttoss.dev/llms.txt',
  websiteUrl: 'https://soat.ttoss.dev',
  icons: [
    {
      src: 'https://soat.ttoss.dev/img/soat-logo-no-bg.png',
      mimeType: 'image/png',
    },
  ],
});

registerTools(mcpServer);

const mcpRouter = createMcpRouter(mcpServer, {
  apiBaseUrl: `http://localhost:${process.env.PORT || 5047}/api/v1`,
  getApiHeaders: (ctx) => {
    return {
      authorization: (ctx.headers.authorization as string) ?? '',
    };
  },
});

export { mcpRouter };
