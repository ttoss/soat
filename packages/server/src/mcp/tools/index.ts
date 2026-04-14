import type { McpServer } from '@ttoss/http-server-mcp';

import { registerTools as registerActorTools } from './actors';
import { registerTools as registerChatTools } from './chats';
import { registerTools as registerAiProviderTools } from './aiProviders';
import { registerTools as registerConversationTools } from './conversations';
import { registerTools as registerDocumentTools } from './documents';
import { registerTools as registerFileTools } from './files';
import { registerTools as registerProjectTools } from './projects';
import { registerTools as registerSecretTools } from './secrets';

const registerTools = (server: McpServer) => {
  registerActorTools(server);
  registerAiProviderTools(server);
  registerChatTools(server);
  registerConversationTools(server);
  registerDocumentTools(server);
  registerFileTools(server);
  registerProjectTools(server);
  registerSecretTools(server);
};

export { registerTools };
