import { agentsCrudDefinitions } from './agentsCrud';
import { agentToolsDefinitions } from './agentTools';
import { generationsDefinitions } from './generationsTools';
import { tracesDefinitions } from './tracesTools';
import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  ...agentToolsDefinitions,
  ...agentsCrudDefinitions,
  ...generationsDefinitions,
  ...tracesDefinitions,
];
