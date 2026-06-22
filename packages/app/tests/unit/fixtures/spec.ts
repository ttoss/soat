import type { OpenApiSpec } from '@/engine/types';

/**
 * A compact but realistic OpenAPI spec used to drive the generic engine in
 * tests. It exercises every classification path: list/get/create/update/delete,
 * an item-scoped action (generate), a $ref request body, an enum field, and a
 * project-scoped sub-resource.
 */
export const testSpec: OpenApiSpec = {
  openapi: '3.0.0',
  info: { title: 'SOAT', version: 'test' },
  paths: {
    '/api/v1/agents': {
      get: {
        operationId: 'listAgents',
        tags: ['Agents'],
        summary: 'List agents',
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Agent' },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createAgent',
        tags: ['Agents'],
        summary: 'Create an agent',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateAgent' },
            },
          },
        },
      },
    },
    '/api/v1/agents/{agent_id}': {
      get: {
        operationId: 'getAgent',
        tags: ['Agents'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Agent' },
              },
            },
          },
        },
      },
      put: {
        operationId: 'updateAgent',
        tags: ['Agents'],
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateAgent' },
            },
          },
        },
      },
      delete: { operationId: 'deleteAgent', tags: ['Agents'] },
    },
    '/api/v1/agents/{agent_id}/generate': {
      post: {
        operationId: 'generateAgent',
        tags: ['Agents'],
        summary: 'Run a generation',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['prompt'],
                properties: {
                  prompt: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/projects': {
      get: { operationId: 'listProjects', tags: ['Projects'] },
      post: {
        operationId: 'createProject',
        tags: ['Projects'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    '/api/v1/projects/{project_id}': {
      get: { operationId: 'getProject', tags: ['Projects'] },
      put: {
        operationId: 'updateProject',
        tags: ['Projects'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
      },
      delete: { operationId: 'deleteProject', tags: ['Projects'] },
    },
    '/api/v1/projects/{project_id}/webhooks': {
      get: { operationId: 'listWebhooks', tags: ['Webhooks'] },
      post: { operationId: 'createWebhook', tags: ['Webhooks'] },
    },
    '/api/v1/agents/{agent_id}/sessions': {
      get: {
        operationId: 'listAgentSessions',
        tags: ['Sessions'],
        summary: 'List agent sessions',
      },
    },
    '/api/v1/agents/{agent_id}/sessions/{session_id}': {
      get: {
        operationId: 'getAgentSession',
        tags: ['Sessions'],
        summary: 'Get an agent session',
      },
    },
    '/api/v1/users': {
      get: { operationId: 'listUsers', tags: ['Users'], summary: 'List users' },
      post: {
        operationId: 'createUser',
        tags: ['Users'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/users/{user_id}': {
      get: { operationId: 'getUser', tags: ['Users'] },
      put: {
        operationId: 'updateUser',
        tags: ['Users'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { username: { type: 'string' } },
              },
            },
          },
        },
      },
      delete: { operationId: 'deleteUser', tags: ['Users'] },
    },
    '/api/v1/policies': {
      get: {
        operationId: 'listPolicies',
        tags: ['Policies'],
        summary: 'List policies',
      },
      post: {
        operationId: 'createPolicy',
        tags: ['Policies'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    '/api/v1/ai-providers': {
      get: {
        operationId: 'listAiProviders',
        tags: ['Ai Providers'],
        summary: 'List AI providers',
      },
      post: {
        operationId: 'createAiProvider',
        tags: ['Ai Providers'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    '/api/v1/tools': {
      get: { operationId: 'listTools', tags: ['Tools'], summary: 'List tools' },
    },
    '/api/v1/tools/{tool_id}': {
      get: { operationId: 'getTool', tags: ['Tools'] },
    },
    '/api/v1/projects/{project_id}/api-keys': {
      get: {
        operationId: 'listApiKeys',
        tags: ['Api Keys'],
        summary: 'List API keys',
      },
      post: {
        operationId: 'createApiKey',
        tags: ['Api Keys'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    '/api/v1/projects/{project_id}/api-keys/{key_id}': {
      delete: { operationId: 'deleteApiKey', tags: ['Api Keys'] },
    },
  },
  components: {
    schemas: {
      Agent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          model: { type: 'string' },
          project_id: { type: 'string', 'x-soat-ref': 'projects' },
          tool_ids: {
            type: 'array',
            items: { type: 'string' },
            'x-soat-ref': 'tools',
          },
          // References a nested resource (sessions live under an agent). It
          // links only when the parent agent_id can be resolved from the row
          // or the current path params; otherwise it renders as plain text.
          session_id: { type: 'string', 'x-soat-ref': 'sessions' },
        },
      },
      CreateAgent: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Agent name' },
          model: { type: 'string', enum: ['gpt-4o', 'gpt-4o-mini'] },
          enabled: { type: 'boolean' },
          project_id: { type: 'string', 'x-soat-ref': 'projects' },
        },
      },
    },
  },
};
