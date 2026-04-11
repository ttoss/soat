import type { McpServer } from '@ttoss/http-server-mcp';

import { registerTools as registerActorTools } from './actors';
import { registerTools as registerDocumentTools } from './documents';
import { registerTools as registerFileTools } from './files';

const registerTools = (server: McpServer) => {
  registerActorTools(server);
  registerDocumentTools(server);
  registerFileTools(server);
};

export { registerTools };
