import type { McpServer } from '@ttoss/http-server-mcp';

import { registerTools as registerActorTools } from './actors';
import { registerTools as registerAgentTools } from './agents';
import { registerTools as registerAiProviderTools } from './aiProviders';
import { registerTools as registerApiKeyTools } from './apiKeys';
import { registerTools as registerChatTools } from './chats';
import { registerTools as registerConversationTools } from './conversations';
import { registerTools as registerDocumentTools } from './documents';
import { registerTools as registerFileTools } from './files';
import { registerTools as registerPolicyTools } from './policies';
import { registerTools as registerProjectTools } from './projects';
import { registerTools as registerSecretTools } from './secrets';
import { registerTools as registerSessionTools } from './sessions';
import { registerTools as registerWebhookTools } from './webhooks';

const registerTools = (server: McpServer) => {
  registerActorTools(server);
  registerAgentTools(server);
  registerAiProviderTools(server);
  registerApiKeyTools(server);
  registerChatTools(server);
  registerConversationTools(server);
  registerDocumentTools(server);
  registerFileTools(server);
  registerPolicyTools(server);
  registerProjectTools(server);
  registerSecretTools(server);
  registerSessionTools(server);
  registerWebhookTools(server);
};

export { registerTools };
