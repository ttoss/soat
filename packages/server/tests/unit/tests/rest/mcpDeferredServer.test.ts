import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import { App, bodyParser } from '@ttoss/http-server';
import {
  createMcpRouter,
  McpServer,
  registerTools,
} from '@ttoss/http-server-mcp';
import { resolveMcpTools } from 'src/lib/agentToolResolverMcp';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A binding's `actions` / `denied_actions` over a server that defers its tools
 * behind `search` / `describe` / `call` (SOAT's own `/mcp` among them). Its
 * listing names the proxies, so the lists have to be applied to the tool a
 * `call` targets: otherwise an allowlist matches nothing, and a denied tool
 * runs through `call`. Served by a real deferred server, so what is asserted
 * is what reached it.
 */

const UNMETERED = { projectId: 0, toolId: null, attribution: {} };

describe('MCP bindings over a deferred server', () => {
  let server: http.Server;
  let mcpUrl: string;
  let adminToken: string;
  let projectId: string;
  const reached: string[] = [];

  const remoteTool = (name: string) => {
    return {
      name,
      description: `The ${name} tool.`,
      inputSchema: { type: 'object' as const, properties: {} },
      handler: async () => {
        reached.push(name);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ name }) }],
        };
      },
    };
  };

  beforeAll(async () => {
    const mcp = new McpServer({ name: 'deferred', version: '1.0.0' });
    registerTools({
      server: mcp,
      tools: [remoteTool('list-items'), remoteTool('delete-item')],
      defer: true,
    });
    const app = new App();
    app.use(bodyParser());
    app.use(createMcpRouter(mcp).routes());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => {
      server.once('listening', resolve);
    });
    mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const setup = await setupProjectWithUsers({
      prefix: 'mcpdeferred',
      policyActions: ['tools:CreateTool', 'tools:CallTool'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    reached.length = 0;
  });

  const createTool = async (lists: {
    actions?: string[];
    denied_actions?: string[];
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: `deferred-${Object.keys(lists).join('-')}-${Date.now()}`,
        type: 'mcp',
        mcp: { url: mcpUrl },
        ...lists,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const callTool = (args: {
    toolId: string;
    action: string;
    input: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/tools/${args.toolId}/call`)
      .send({ action: args.action, input: args.input });
  };

  describe('POST /api/v1/tools/:tool_id/call', () => {
    test('a denied tool cannot be reached through the proxy', async () => {
      const toolId = await createTool({ denied_actions: ['delete-item'] });

      const res = await callTool({
        toolId,
        action: 'call',
        input: { name: 'delete-item', arguments: {} },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(reached).toEqual([]);
    });

    test('a tool behind the proxy is called by its own name', async () => {
      const toolId = await createTool({ denied_actions: ['delete-item'] });

      const res = await callTool({ toolId, action: 'list-items', input: {} });

      expect(res.status).toBe(200);
      expect(reached).toEqual(['list-items']);
    });

    test('an allowlist admits its tools and not the proxy', async () => {
      const toolId = await createTool({ actions: ['list-items'] });

      const allowed = await callTool({
        toolId,
        action: 'list-items',
        input: {},
      });
      const proxied = await callTool({
        toolId,
        action: 'call',
        input: { name: 'delete-item', arguments: {} },
      });

      expect(allowed.status).toBe(200);
      expect(proxied.status).toBe(400);
      expect(reached).toEqual(['list-items']);
    });
  });

  describe('agent resolution', () => {
    const resolve = (lists: {
      actions?: string[];
      deniedActions?: string[];
    }) => {
      return resolveMcpTools({
        meter: UNMETERED,
        typedTool: { mcp: { url: mcpUrl }, ...lists },
        buildContextHeaders: () => {
          return {};
        },
        logToolCallingError: jest.fn(),
      });
    };

    const run = async (tool: unknown, input: unknown) => {
      if (
        typeof tool !== 'object' ||
        tool === null ||
        !('execute' in tool) ||
        typeof tool.execute !== 'function'
      ) {
        throw new Error('tool resolved without an execute');
      }
      return tool.execute(input, {});
    };

    test('an allowlist attaches the tools it names, not the proxies', async () => {
      const tools = await resolve({ actions: ['list-items'] });

      expect(Object.keys(tools)).toEqual(['list-items']);
      await run(tools['list-items'], {});
      expect(reached).toEqual(['list-items']);
    });

    test('an allowlist keeps a listed tool it names beside those behind the proxy', async () => {
      const tools = await resolve({ actions: ['search', 'list-items'] });

      expect(Object.keys(tools).sort()).toEqual(['list-items', 'search']);
    });

    test('a denylist keeps the proxies but refuses a denied target', async () => {
      const tools = await resolve({ deniedActions: ['delete-item'] });

      expect(Object.keys(tools).sort()).toEqual(['call', 'describe', 'search']);
      await expect(
        run(tools.call, { name: 'delete-item', arguments: {} })
      ).rejects.toThrow('action "delete-item" is not available on this tool.');
      await run(tools.call, { name: 'list-items', arguments: {} });
      expect(reached).toEqual(['list-items']);
    });
  });
});
