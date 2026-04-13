import { createMcpRouter, McpServer } from '@ttoss/http-server-mcp';

import { registerTools } from './tools/index';

const mcpServer = new McpServer({
  name: 'soat',
  version: '1.0.0',
});

registerTools(mcpServer);

const mcpRouter = createMcpRouter(mcpServer, {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  apiBaseUrl: `http://localhost:${process.env.PORT || 5047}/api/v1`,
  getApiHeaders: (ctx) => {
    return {
      authorization: (ctx.headers.authorization as string) ?? '',
    };
  },
});

export { mcpRouter };
