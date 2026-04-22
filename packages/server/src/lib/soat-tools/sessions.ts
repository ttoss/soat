import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'create-agent-session',
    description: 'Create a new session for an agent.',
    method: 'POST',
    path: (args) => {
      return `/agents/${args.agentId}/sessions`;
    },
    body: (args) => {
      return {
        name: args.name,
        actorId: args.actorId,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        name: { type: 'string', description: 'Optional session display name' },
        actorId: {
          type: 'string',
          description:
            'Optional public ID of an existing actor to use as the user actor',
        },
      },
      required: ['agentId'],
    },
    iamAction: 'agents:CreateSession',
  },
  {
    name: 'list-agent-sessions',
    description: 'List sessions for an agent.',
    method: 'GET',
    path: (args) => {
      const params = new URLSearchParams();
      if (args.status) {
        params.set('status', String(args.status));
      }
      if (args.actorId) {
        params.set('actorId', String(args.actorId));
      }
      const qs = params.toString();
      return `/agents/${args.agentId}/sessions${qs ? `?${qs}` : ''}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        status: {
          type: 'string',
          description: 'Filter by status (open or closed)',
        },
        actorId: {
          type: 'string',
          description: 'Filter by actor public ID',
        },
      },
      required: ['agentId'],
    },
    iamAction: 'agents:ListSessions',
  },
  {
    name: 'get-agent-session',
    description: 'Get session details.',
    method: 'GET',
    path: (args) => {
      return `/agents/${args.agentId}/sessions/${args.sessionId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        sessionId: {
          type: 'string',
          description: 'Public ID of the session',
        },
      },
      required: ['agentId', 'sessionId'],
    },
    iamAction: 'agents:GetSession',
  },
  {
    name: 'delete-agent-session',
    description: 'Delete a session.',
    method: 'DELETE',
    path: (args) => {
      return `/agents/${args.agentId}/sessions/${args.sessionId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        sessionId: {
          type: 'string',
          description: 'Public ID of the session to delete',
        },
      },
      required: ['agentId', 'sessionId'],
    },
    iamAction: 'agents:DeleteSession',
  },
  {
    name: 'add-agent-session-message',
    description:
      'Save a user message to a session without triggering generation. ' +
      'Call generate-agent-session-response afterwards to get the agent reply.',
    method: 'POST',
    path: (args) => {
      return `/agents/${args.agentId}/sessions/${args.sessionId}/messages`;
    },
    body: (args) => {
      return {
        message: args.message,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        sessionId: {
          type: 'string',
          description: 'Public ID of the session',
        },
        message: { type: 'string', description: 'The user message to save' },
      },
      required: ['agentId', 'sessionId', 'message'],
    },
    iamAction: 'agents:SendSessionMessage',
  },
  {
    name: 'generate-agent-session-response',
    description:
      'Trigger agent generation for a session. Returns the assistant reply ' +
      'or a requires_action status if the agent needs client tool outputs.',
    method: 'POST',
    path: (args) => {
      return `/agents/${args.agentId}/sessions/${args.sessionId}/generate`;
    },
    body: (args) => {
      return {
        model: args.model,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        sessionId: {
          type: 'string',
          description: 'Public ID of the session',
        },
        model: {
          type: 'string',
          description: 'Optional model override for this generation',
        },
      },
      required: ['agentId', 'sessionId'],
    },
    iamAction: 'agents:SendSessionMessage',
  },
  {
    name: 'list-agent-session-messages',
    description: 'List messages in a session.',
    method: 'GET',
    path: (args) => {
      return `/agents/${args.agentId}/sessions/${args.sessionId}/messages`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Public ID of the agent' },
        sessionId: {
          type: 'string',
          description: 'Public ID of the session',
        },
      },
      required: ['agentId', 'sessionId'],
    },
    iamAction: 'agents:ListSessionMessages',
  },
];
