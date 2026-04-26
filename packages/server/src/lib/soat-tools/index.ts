import { tools as actorTools } from './actors';
import { tools as agentTools } from './agents';
import { tools as aiProviderTools } from './aiProviders';
import { tools as apiKeyTools } from './apiKeys';
import { tools as chatTools } from './chats';
import { tools as conversationTools } from './conversations';
import { tools as documentTools } from './documents';
import { tools as fileTools } from './files';
import { tools as policyTools } from './policies';
import { tools as projectTools } from './projects';
import { tools as secretTools } from './secrets';
import { tools as sessionTools } from './sessions';
import { tools as webhookTools } from './webhooks';

export type { SoatToolDefinition } from './types';

export const allSoatTools = [
  ...projectTools,
  ...actorTools,
  ...agentTools,
  ...aiProviderTools,
  ...apiKeyTools,
  ...chatTools,
  ...conversationTools,
  ...documentTools,
  ...fileTools,
  ...policyTools,
  ...secretTools,
  ...sessionTools,
  ...webhookTools,
];
