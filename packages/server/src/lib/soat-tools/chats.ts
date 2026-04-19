import type { SoatToolDefinition } from './types';

export const tools: SoatToolDefinition[] = [
  {
    name: 'create-chat',
    description: 'Create a new chat bound to an AI provider.',
    method: 'POST',
    path: () => {
      return '/chats';
    },
    body: (args) => {
      return {
        aiProviderId: args.aiProviderId,
        projectId: args.projectId,
        name: args.name,
        systemMessage: args.systemMessage,
        model: args.model,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        aiProviderId: {
          type: 'string',
          description: 'AI provider ID to use',
        },
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Chat name' },
        systemMessage: {
          type: 'string',
          description: 'System message for the chat',
        },
        model: { type: 'string', description: 'Model identifier' },
      },
      required: ['aiProviderId'],
    },
    iamAction: 'chats:CreateChat',
  },
  {
    name: 'list-chats',
    description: 'List all chats in a project.',
    method: 'GET',
    path: (args) => {
      const qs = args.projectId
        ? `?projectId=${encodeURIComponent(String(args.projectId))}`
        : '';
      return `/chats${qs}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to filter by' },
      },
    },
    iamAction: 'chats:ListChats',
  },
  {
    name: 'get-chat',
    description: 'Get a chat by ID.',
    method: 'GET',
    path: (args) => {
      return `/chats/${args.chatId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Chat ID' },
      },
      required: ['chatId'],
    },
    iamAction: 'chats:GetChat',
  },
  {
    name: 'delete-chat',
    description: 'Delete a chat by ID.',
    method: 'DELETE',
    path: (args) => {
      return `/chats/${args.chatId}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Chat ID' },
      },
      required: ['chatId'],
    },
    iamAction: 'chats:DeleteChat',
  },
  {
    name: 'create-chat-completion-for-chat',
    description:
      'Run a completion using the AI provider and settings stored in a chat.',
    method: 'POST',
    path: (args) => {
      return `/chats/${args.chatId}/completions`;
    },
    body: (args) => {
      return {
        messages: args.messages,
        model: args.model,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Chat ID' },
        messages: {
          type: 'array',
          description: 'Messages to send',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        model: {
          type: 'string',
          description: 'Model override (optional)',
        },
      },
      required: ['chatId', 'messages'],
    },
    iamAction: 'chats:CreateChatCompletionForChat',
  },
  {
    name: 'create-chat-completion',
    description:
      'Send a list of messages to an AI provider and receive a completion.',
    method: 'POST',
    path: () => {
      return '/chats/completions';
    },
    body: (args) => {
      return {
        messages: args.messages,
        aiProviderId: args.aiProviderId,
        model: args.model,
      };
    },
    inputSchema: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          description: 'Messages to send',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        aiProviderId: {
          type: 'string',
          description: 'AI provider ID to use',
        },
        model: { type: 'string', description: 'Model identifier' },
      },
      required: ['messages'],
    },
    iamAction: 'chats:CreateChatCompletion',
  },
];
