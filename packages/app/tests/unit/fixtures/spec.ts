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
      get: { operationId: 'getAgent', tags: ['Agents'] },
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
    '/api/v1/projects/{project_id}/webhooks': {
      get: { operationId: 'listWebhooks', tags: ['Webhooks'] },
      post: { operationId: 'createWebhook', tags: ['Webhooks'] },
    },
  },
  components: {
    schemas: {
      CreateAgent: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Agent name' },
          model: { type: 'string', enum: ['gpt-4o', 'gpt-4o-mini'] },
          enabled: { type: 'boolean' },
        },
      },
    },
  },
};
