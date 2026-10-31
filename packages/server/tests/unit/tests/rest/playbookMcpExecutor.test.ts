import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient } from '../../testClient';

type McpCall = { name: string; arguments: Record<string, unknown> };

const executesOnAmount = (executor: Record<string, unknown>) => {
  return {
    nodes: [
      {
        id: 'pricing',
        title: 'Pricing',
        kind: 'execute',
        final: true,
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
        executor,
      },
    ],
  };
};

describe('Playbook execute node on an mcp tool', () => {
  let turn: AgentToolTurn;
  let mcpToolId: string;
  let mcpUrl: string;
  const calls: McpCall[] = [];

  const admin = () => {
    return authenticatedTestClient(turn.adminToken);
  };

  const createPlaybook = (definition: unknown) => {
    return admin()
      .post('/api/v1/playbooks')
      .send({
        project_id: turn.projectId,
        name: turn.unique('playbook'),
        definition,
      });
  };

  const runCase = async (playbookId: string) => {
    const created = await admin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: turn.unique('case') });
    expect(created.status).toBe(201);
    const caseId = created.body.id as string;
    await flushPlaybookExecutions();
    const written = await admin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          {
            node_id: 'pricing',
            name: 'amount',
            value: 21,
            expected_revision: null,
          },
        ],
      });
    expect(written.status).toBe(200);
    await flushPlaybookExecutions();
    const read = await admin().get(`/api/v1/playbook-cases/${caseId}`);
    return (read.body.nodes as { id: string; state: string }[]).find((node) => {
      return node.id === 'pricing';
    });
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'playbookmcpexecutor' });
    const path = `/${turn.unique('mcp')}`;
    mcpUrl = `${turn.target.baseUrl}${path}`;
    turn.target.reply(path, async (body) => {
      if (body.method === 'tools/list') {
        const inputSchema = {
          type: 'object',
          properties: { value: { type: 'number' } },
        };
        const tools = [
          { name: 'double', inputSchema },
          { name: 'negate', inputSchema },
        ];
        return { body: { jsonrpc: '2.0', id: body.id, result: { tools } } };
      }
      const params = body.params as McpCall;
      calls.push({ name: params.name, arguments: params.arguments });
      const text = JSON.stringify({ called: params.name });
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text }] },
        },
      };
    });
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: mcpUrl },
    });
    mcpToolId = tool.id;
  });

  afterAll(async () => {
    await turn.close();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  describe('POST /api/v1/playbook-cases/{case_id}/inputs', () => {
    test('calls the action `operation_id` names', async () => {
      const playbook = await createPlaybook(
        executesOnAmount({
          type: 'tool',
          id: mcpToolId,
          operation_id: 'negate',
          input: { value: { var: 'amount' } },
        })
      );
      expect(playbook.status).toBe(201);

      const node = await runCase(playbook.body.id);

      expect(calls).toEqual([{ name: 'negate', arguments: { value: 21 } }]);
      expect(node?.state).toBe('done');
    });

    test('fails the node when the tool withholds its action after the playbook was written', async () => {
      const tool = await turn.createTool({
        type: 'mcp',
        execute: undefined,
        parameters: undefined,
        mcp: { url: mcpUrl },
      });
      const playbook = await createPlaybook(
        executesOnAmount({ type: 'tool', id: tool.id, operation_id: 'negate' })
      );
      expect(playbook.status).toBe(201);
      const withheld = await admin()
        .patch(`/api/v1/tools/${tool.id}`)
        .send({ denied_actions: ['negate'] });
      expect(withheld.status).toBe(200);

      const node = await runCase(playbook.body.id);

      expect(calls).toEqual([]);
      expect(node?.state).toBe('failed');
    });
  });

  describe('POST /api/v1/playbooks', () => {
    test('echoes the executor `operation_id`', async () => {
      const res = await createPlaybook(
        executesOnAmount({
          type: 'tool',
          id: mcpToolId,
          operation_id: 'double',
        })
      );

      expect(res.status).toBe(201);
      expect(res.body.definition.nodes[0].executor).toEqual({
        type: 'tool',
        id: mcpToolId,
        operation_id: 'double',
      });
    });

    test('refuses an `operation_id` that is not a non-empty string', async () => {
      const res = await createPlaybook(
        executesOnAmount({ type: 'tool', id: mcpToolId, operation_id: '' })
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses an `operation_id` on an executor that is not a tool', async () => {
      const res = await createPlaybook(
        executesOnAmount({
          type: 'agent',
          id: 'agt_V1StGXR8Z5jdHi6B',
          operation_id: 'double',
        })
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
