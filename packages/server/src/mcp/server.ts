import { createMcpRouter, Server as McpServer } from '@ttoss/http-server-mcp';

import pkg from '../../package.json' with { type: 'json' };
import {
  createDocumentTool,
  deleteDocumentTool,
  getDocumentTool,
  listDocumentsTool,
  searchDocumentsTool,
  updateDocumentTool,
} from './tools';

const mcpServer = new McpServer({
  name: 'soat-server',
  version: pkg.version,
});

mcpServer.registerTool(
  listDocumentsTool.name,
  {
    description: listDocumentsTool.description,
    inputSchema: listDocumentsTool.inputSchema,
  },
  listDocumentsTool.handler
);

mcpServer.registerTool(
  createDocumentTool.name,
  {
    description: createDocumentTool.description,
    inputSchema: createDocumentTool.inputSchema,
  },
  createDocumentTool.handler
);

mcpServer.registerTool(
  getDocumentTool.name,
  {
    description: getDocumentTool.description,
    inputSchema: getDocumentTool.inputSchema,
  },
  getDocumentTool.handler
);

mcpServer.registerTool(
  updateDocumentTool.name,
  {
    description: updateDocumentTool.description,
    inputSchema: updateDocumentTool.inputSchema,
  },
  updateDocumentTool.handler
);

mcpServer.registerTool(
  deleteDocumentTool.name,
  {
    description: deleteDocumentTool.description,
    inputSchema: deleteDocumentTool.inputSchema,
  },
  deleteDocumentTool.handler
);

mcpServer.registerTool(
  searchDocumentsTool.name,
  {
    description: searchDocumentsTool.description,
    inputSchema: searchDocumentsTool.inputSchema,
  },
  searchDocumentsTool.handler
);

export const mcpRouter = createMcpRouter(mcpServer, {
  path: '/mcp',
});
