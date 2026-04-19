export type { SoatToolDefinition } from './types';

import { tools as actorTools } from './actors';
import { tools as agentTools } from './agents';
import { tools as aiProviderTools } from './aiProviders';
import { tools as chatTools } from './chats';
import { tools as conversationTools } from './conversations';
import { tools as documentTools } from './documents';
import { tools as fileTools } from './files';
import { tools as projectTools } from './projects';
import { tools as secretTools } from './secrets';

export const allSoatTools = [
  ...projectTools,
  ...actorTools,
  ...agentTools,
  ...aiProviderTools,
  ...chatTools,
  ...conversationTools,
  ...documentTools,
  ...fileTools,
  ...secretTools,
];
