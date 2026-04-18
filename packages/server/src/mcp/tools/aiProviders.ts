import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, z } from '@ttoss/http-server-mcp';

const AI_PROVIDER_SLUGS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'groq',
  'ollama',
  'azure',
  'bedrock',
  'gateway',
  'custom',
] as const;

const registerTools = (server: McpServer) => {
  server.registerTool(
    'list-ai-providers',
    {
      description: 'List AI providers in a project.',
      inputSchema: {
        projectId: z.string().optional().describe('Project ID to filter by'),
      },
    },
    async ({ projectId }) => {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiCall('GET', `/ai-providers${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get-ai-provider',
    {
      description: 'Get an AI provider by ID.',
      inputSchema: {
        id: z.string().describe('AI Provider ID'),
      },
    },
    async ({ id }) => {
      const data = await apiCall('GET', `/ai-providers/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'create-ai-provider',
    {
      description: 'Create a new AI provider configuration.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe(
            'Project ID. Required for JWT auth; omit when using a project key.'
          ),
        secretId: z
          .string()
          .optional()
          .describe(
            'Secret ID containing the provider credentials. Use this or apiKey, not both.'
          ),
        apiKey: z
          .string()
          .optional()
          .describe(
            'API key for the provider. If provided, a secret is created automatically and linked. Use this or secretId, not both.'
          ),
        name: z.string().describe('Display name for this AI provider'),
        provider: z.enum(AI_PROVIDER_SLUGS).describe('Provider type'),
        defaultModel: z.string().describe('Default model to use'),
        baseUrl: z
          .string()
          .optional()
          .describe('Custom base URL for the provider API'),
        config: z
          .record(z.unknown())
          .optional()
          .describe('Provider-specific configuration as a JSON object'),
      },
    },
    async ({
      projectId,
      secretId,
      apiKey,
      name,
      provider,
      defaultModel,
      baseUrl,
      config,
    }) => {
      if (secretId && apiKey) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Provide either secretId or apiKey, not both.',
              }),
            },
          ],
          isError: true,
        };
      }
      let resolvedSecretId = secretId;
      if (apiKey) {
        try {
          const secret = (await apiCall('POST', '/secrets', {
            body: {
              projectId,
              name: `${name} API Key`,
              value: apiKey,
            },
          })) as { id: string };
          resolvedSecretId = secret.id;
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: `Failed to auto-create secret for provider "${name}" (projectId: ${projectId ?? 'inferred'}): ${err instanceof Error ? err.message : String(err)}`,
                }),
              },
            ],
            isError: true,
          };
        }
      }
      const data = await apiCall('POST', '/ai-providers', {
        body: {
          projectId,
          secretId: resolvedSecretId,
          name,
          provider,
          defaultModel,
          baseUrl,
          config,
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'update-ai-provider',
    {
      description: 'Update an AI provider configuration.',
      inputSchema: {
        id: z.string().describe('AI Provider ID'),
        secretId: z.string().optional().describe('New Secret ID'),
        name: z.string().optional().describe('New display name'),
        provider: z
          .enum(AI_PROVIDER_SLUGS)
          .optional()
          .describe('New provider type'),
        defaultModel: z.string().optional().describe('New default model'),
        baseUrl: z.string().optional().describe('New base URL'),
        config: z
          .record(z.unknown())
          .optional()
          .describe('New provider-specific configuration'),
      },
    },
    async ({ id, secretId, name, provider, defaultModel, baseUrl, config }) => {
      const data = await apiCall('PATCH', `/ai-providers/${id}`, {
        body: { secretId, name, provider, defaultModel, baseUrl, config },
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'delete-ai-provider',
    {
      description: 'Delete an AI provider.',
      inputSchema: {
        id: z.string().describe('AI Provider ID'),
      },
    },
    async ({ id }) => {
      const data = await apiCall('DELETE', `/ai-providers/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );
};

export { registerTools };
