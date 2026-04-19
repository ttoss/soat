import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'list-conversations',
    description:
      'List conversations. If projectId is omitted, returns all conversations accessible to the caller.',
    method: 'GET',
    path: (args) => {
      const params = new URLSearchParams();
      if (args.projectId) params.set('projectId', String(args.projectId));
      if (args.actorId) params.set('actorId', String(args.actorId));
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      const qs = params.toString();
      return qs ? `/conversations?${qs}` : '/conversations';
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to filter by' },
        actorId: { type: 'string', description: 'Actor ID to filter by' },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
        offset: { type: 'number', description: 'Number of results to skip' },
      },
    },
    iamAction: 'conversations:ListConversations',
  },
  {
    name: 'get-conversation',
    description: 'Get a conversation by ID',
    method: 'GET',
    path: (args) => {
      return `/conversations/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
      },
      required: ['id'],
    },
    iamAction: 'conversations:GetConversation',
  },
  {
    name: 'create-conversation',
    description:
      'Create a new conversation. Project keys infer the project automatically.',
    method: 'POST',
    path: () => {
      return '/conversations';
    },
    body: (args) => {
      return {
        projectId: args.projectId,
        status: args.status,
        name: args.name,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        status: { type: 'string', description: 'Conversation status' },
        name: { type: 'string', description: 'Conversation name' },
      },
    },
    iamAction: 'conversations:CreateConversation',
  },
  {
    name: 'update-conversation',
    description: "Update a conversation's status or name",
    method: 'PATCH',
    path: (args) => {
      return `/conversations/${args.id}`;
    },
    body: (args) => {
      return {
        status: args.status,
        name: args.name,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
        status: { type: 'string', description: 'New status' },
        name: { type: 'string', description: 'New name' },
      },
      required: ['id'],
    },
    iamAction: 'conversations:UpdateConversation',
  },
  {
    name: 'delete-conversation',
    description: 'Delete a conversation by ID',
    method: 'DELETE',
    path: (args) => {
      return `/conversations/${args.id}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
      },
      required: ['id'],
    },
    iamAction: 'conversations:DeleteConversation',
  },
  {
    name: 'list-conversation-messages',
    description:
      'List all messages (documents) in a conversation, ordered by position',
    method: 'GET',
    path: (args) => {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      const qs = params.toString();
      return qs
        ? `/conversations/${args.id}/messages?${qs}`
        : `/conversations/${args.id}/messages`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
        },
        offset: { type: 'number', description: 'Number of results to skip' },
      },
      required: ['id'],
    },
    iamAction: 'conversations:ListConversationMessages',
  },
  {
    name: 'add-conversation-message',
    description: 'Add a message to a conversation.',
    method: 'POST',
    path: (args) => {
      return `/conversations/${args.id}/messages`;
    },
    body: (args) => {
      return {
        message: args.message,
        actorId: args.actorId,
        position: args.position,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
        message: { type: 'string', description: 'Message content' },
        actorId: {
          type: 'string',
          description: 'Actor ID sending the message',
        },
        position: {
          type: 'number',
          description: 'Position of the message (optional)',
        },
      },
      required: ['id', 'message', 'actorId'],
    },
    iamAction: 'conversations:AddConversationMessage',
  },
  {
    name: 'list-conversation-actors',
    description:
      'List all distinct actors who have sent at least one message in the conversation.',
    method: 'GET',
    path: (args) => {
      return `/conversations/${args.id}/actors`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
      },
      required: ['id'],
    },
    iamAction: 'conversations:ListConversationActors',
  },
  {
    name: 'remove-conversation-message',
    description: 'Remove a document from a conversation',
    method: 'DELETE',
    path: (args) => {
      return `/conversations/${args.id}/messages/${args.documentId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
        documentId: { type: 'string', description: 'Document ID to remove' },
      },
      required: ['id', 'documentId'],
    },
    iamAction: 'conversations:RemoveConversationMessage',
  },
  {
    name: 'generate-conversation-message',
    description:
      'Generate the next message in a conversation using an agent actor.',
    method: 'POST',
    path: (args) => {
      return `/conversations/${args.conversationId}/generate`;
    },
    body: (args) => {
      return {
        actorId: args.actorId,
        model: args.model,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation ID' },
        actorId: {
          type: 'string',
          description: 'Actor ID of the agent to generate the message',
        },
        model: {
          type: 'string',
          description: 'Model override (optional)',
        },
      },
      required: ['conversationId', 'actorId'],
    },
    iamAction: 'conversations:GenerateConversationMessage',
  },
];
