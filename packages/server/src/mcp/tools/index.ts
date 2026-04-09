import type { McpServer } from '@ttoss/http-server-mcp';

import { registerTools as registerDocumentTools } from './documents';
import { registerTools as registerFileTools } from './files';

const registerTools = (server: McpServer) => {
  registerDocumentTools(server);
  registerFileTools(server);
};

export { registerTools };
