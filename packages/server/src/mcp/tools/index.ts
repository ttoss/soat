import type { McpServer } from '@ttoss/http-server-mcp';

import { registerTools as registerFileTools } from './files';

const registerTools = (server: McpServer) => {
  registerFileTools(server);
};

export { registerTools };
