import type { McpServer } from '@ttoss/http-server-mcp';

import { registerTools as registerActorTools } from './actors';
import { registerTools as registerConversationTools } from './conversations';
import { registerTools as registerDocumentTools } from './documents';
import { registerTools as registerFileTools } from './files';
import { registerTools as registerProjectTools } from './projects';

const registerTools = (server: McpServer) => {
  registerActorTools(server);
  registerConversationTools(server);
  registerDocumentTools(server);
  registerFileTools(server);
  registerProjectTools(server);
};

export { registerTools };
