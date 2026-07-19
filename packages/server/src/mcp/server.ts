import { API_KEY_RAW_PREFIX } from '@soat/postgresdb';
import type { App } from '@ttoss/http-server';
import {
  createMcpRouter,
  McpServer,
  registerToolFromSchema,
} from '@ttoss/http-server-mcp';

import { version } from '../../package.json' with { type: 'json' };
import { getDocPage, getDocsIndex } from '../lib/docs';
import { soatTools } from '../lib/soatTools';
import { verifyApiKeyToken } from '../middleware/auth';
import { ISSUER, verifyOauthAccessToken } from '../oauth/server';
import { callApi, mcpAuthorizationStore } from './callApi';
import { toMcpText } from './toMcpText';

const apiBaseUrl = `http://localhost:${process.env.PORT || 5047}`;

const mcpServer = new McpServer({
  name: 'soat',
  title: 'SOAT',
  version,
  description:
    'Infrastructure for AI Apps — backend, identity, storage, memory, and orchestration. LLMs docs: https://soat.ttoss.dev/llms.txt',
  websiteUrl: 'https://soat.ttoss.dev',
  icons: [
    {
      src: 'https://soat.ttoss.dev/img/soat-logo.png',
      mimeType: 'image/png',
    },
  ],
});

// Register all SOAT tools as MCP tools
for (const tool of soatTools) {
  registerToolFromSchema(mcpServer, {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (args: Record<string, unknown>) => {
      const url = tool.path(args) + (tool.query ? tool.query(args) : '');
      const data = await callApi({
        apiBaseUrl,
        method: tool.method,
        url,
        body: tool.body ? tool.body(args) : undefined,
      });
      return { content: [{ type: 'text' as const, text: toMcpText(data) }] };
    },
  });
}

// ── Docs tools (MCP-only, not backed by REST) ─────────────────────────────

registerToolFromSchema(mcpServer, {
  name: 'get-docs',
  description:
    'Returns the SOAT documentation index in llms.txt format. The response lists all available documentation pages with their URLs. Use get-doc-page with a URL from this index to read a specific page.',
  inputSchema: { type: 'object' as const, properties: {} },
  handler: async () => {
    const content = await getDocsIndex();
    return { content: [{ type: 'text' as const, text: content }] };
  },
});

registerToolFromSchema(mcpServer, {
  name: 'get-doc-page',
  description:
    'Fetches the full content of a SOAT documentation page by URL. Use get-docs first to obtain the list of valid page URLs.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description:
          'Full URL of the documentation page (must be from the SOAT documentation site)',
      },
    },
    required: ['url'],
  },
  handler: async (args: Record<string, unknown>) => {
    const content = await getDocPage({ url: args.url as string });
    return { content: [{ type: 'text' as const, text: content }] };
  },
});

const mcpRouter = createMcpRouter(mcpServer, {
  aliases: ['/'],
  apiBaseUrl,
  getApiHeaders: (ctx) => {
    const authorization = (ctx.headers.authorization as string) ?? '';
    // Populates callApi's AsyncLocalStorage for the remainder of this
    // request's async chain, including the tool handlers above.
    mcpAuthorizationStore.enterWith(authorization);
    return { authorization };
  },
  auth: {
    verifyToken: async (token) => {
      // Project-scoped `sk_` API keys are a first-class MCP credential (the
      // headless-agent path), verified against the ApiKey table. Per-request
      // authorization is still enforced when the tool handler forwards this same
      // bearer token to the REST API (see callApi + resolveProjectKey).
      if (token.startsWith(API_KEY_RAW_PREFIX)) {
        const apiKeyPayload = await verifyApiKeyToken(token);
        if (!apiKeyPayload) throw new Error('Invalid token');
        return apiKeyPayload;
      }
      const payload = verifyOauthAccessToken(token);
      if (!payload) throw new Error('Invalid token');
      return payload;
    },
    // Protect every JSON-RPC method, including `initialize`. The default
    // (`['initialize', 'tools/list']`) lets the handshake start unauthenticated,
    // which makes OAuth-aware clients (e.g. Claude connectors) treat the server
    // as public and never begin the OAuth flow — while `notifications/initialized`
    // still 401s and breaks the handshake. Challenging on `initialize` with a
    // `WWW-Authenticate` header is what triggers the client's OAuth discovery.
    publicMethods: [],
    resourceServerUrl: ISSUER,
    authorizationServerUrl: ISSUER,
    resourceMetadataUrl: `${ISSUER}/.well-known/oauth-protected-resource`,
  },
});

export const setupMcpMiddleware = (app: App) => {
  app.use(mcpRouter.routes());
  app.use(mcpRouter.allowedMethods());
};
