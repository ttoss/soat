import crypto from 'node:crypto';

import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient } from '../../testClient';

/**
 * A case's `tool` or `orchestration` executor calls a tool whose server writes
 * back with its project's key, forwarding the call's assertion in
 * `X-Soat-On-Behalf-Of`. No generation makes the call, so the write is told
 * apart by the work the assertion names.
 */

type WriteBack = { status: number; code?: string };

describe("Playbook writes from a case's own tool and orchestration executors", () => {
  let turn: AgentToolTurn;
  let projectKey: string;
  let toolId: string;
  let toolPlaybookId: string;
  let orchestrationPlaybookId: string;
  let seq = 0;
  const writeBacks: WriteBack[] = [];
  const assertions: Record<string, unknown>[] = [];
  const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const admin = () => {
    return authenticatedTestClient(turn.adminToken);
  };

  const newCase = async (playbookId: string): Promise<string> => {
    seq += 1;
    const res = await admin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `case-${seq}` });
    expect(res.status).toBe(201);
    await flushPlaybookExecutions();
    return res.body.id as string;
  };

  const nodeOf = async (args: { caseId: string; node: string }) => {
    const res = await admin().get(`/api/v1/playbook-cases/${args.caseId}`);
    return (
      res.body.nodes as {
        id: string;
        state: string;
        inputs: { name: string; value: unknown; revision: number | null }[];
      }[]
    ).find((candidate) => {
      return candidate.id === args.node;
    });
  };

  /** Writes `w.cid`, which runs `w`'s executor against case `target`. */
  const runExecutorWriting = async (args: {
    caseId: string;
    target: string;
  }) => {
    writeBacks.length = 0;
    assertions.length = 0;
    const res = await admin()
      .post(`/api/v1/playbook-cases/${args.caseId}/inputs`)
      .send({
        inputs: [
          {
            node_id: 'w',
            name: 'cid',
            value: args.target,
            expected_revision: null,
          },
        ],
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
    expect(writeBacks).toHaveLength(1);
    return writeBacks[0];
  };

  const definition = (executor: Record<string, unknown>) => {
    return {
      nodes: [
        {
          id: 'a',
          title: 'A',
          kind: 'collect',
          inputs: [
            {
              name: 'x',
              schema: { type: 'string' },
              required: false,
              source: 'manual',
            },
          ],
        },
        {
          id: 'w',
          title: 'Write',
          kind: 'execute',
          final: true,
          inputs: [
            {
              name: 'cid',
              schema: { type: 'string' },
              required: true,
              source: 'manual',
            },
          ],
          executor,
        },
      ],
    };
  };

  beforeAll(async () => {
    process.env.TOOL_ASSERTION_PRIVATE_KEY = crypto
      .generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'playbookexecselfwrite' });

    const key = await admin()
      .post('/api/v1/api-keys')
      .send({ name: 'tool server key', project_id: turn.projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key;

    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, async (body, request) => {
      if (body.method === 'tools/list') {
        const tool = {
          name: 'write_back',
          inputSchema: {
            type: 'object',
            properties: { case_id: { type: 'string' } },
          },
        };
        return {
          body: { jsonrpc: '2.0', id: body.id, result: { tools: [tool] } },
        };
      }
      const params = body.params as { arguments: { case_id: string } };
      const assertion = request.headers['x-soat-tool-assertion'] as string;
      assertions.push(
        JSON.parse(
          Buffer.from(assertion.split('.')[1], 'base64url').toString('utf-8')
        )
      );
      const res = await authenticatedTestClient(projectKey)
        .post(`/api/v1/playbook-cases/${params.arguments.case_id}/inputs`)
        .set('X-Soat-On-Behalf-Of', assertion)
        .send({
          inputs: [
            {
              node_id: 'a',
              name: 'x',
              value: 'direct',
              expected_revision: null,
            },
          ],
        });
      const writeBack = { status: res.status, code: res.body.error?.code };
      writeBacks.push(writeBack);
      const text = JSON.stringify(writeBack);
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text }],
            isError: res.status >= 400,
          },
        },
      };
    });
    toolId = (
      await turn.createTool({
        type: 'mcp',
        execute: undefined,
        parameters: undefined,
        mcp: { url: `${turn.target.baseUrl}${path}` },
      })
    ).id;

    const orchestration = await admin()
      .post('/api/v1/orchestrations')
      .send({
        project_id: turn.projectId,
        name: turn.unique('orchestration'),
        nodes: [
          {
            id: 'call',
            type: 'tool',
            tool_id: toolId,
            operation_id: 'write_back',
            input_mapping: { case_id: { var: 'input.case_id' } },
          },
        ],
        edges: [],
      });
    expect(orchestration.status).toBe(201);

    const playbook = async (executor: Record<string, unknown>) => {
      const res = await admin()
        .post('/api/v1/playbooks')
        .send({
          project_id: turn.projectId,
          name: turn.unique('playbook'),
          definition: definition(executor),
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    toolPlaybookId = await playbook({
      type: 'tool',
      id: toolId,
      operation_id: 'write_back',
      input: { case_id: { var: 'cid' } },
    });
    orchestrationPlaybookId = await playbook({
      type: 'orchestration',
      id: orchestration.body.id,
      input: { case_id: { var: 'cid' } },
    });
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
    await turn.close();
  });

  describe('POST /api/v1/playbook-cases/{case_id}/inputs', () => {
    describe.each([
      [
        'tool',
        () => {
          return toolPlaybookId;
        },
      ],
      [
        'orchestration',
        () => {
          return orchestrationPlaybookId;
        },
      ],
    ])('from a %s executor', (_kind, playbookOf) => {
      test('refuses a write into the case itself', async () => {
        const caseId = await newCase(playbookOf());

        const writeBack = await runExecutorWriting({ caseId, target: caseId });

        expect(writeBack).toEqual({ status: 403, code: 'PLAYBOOK_SELF_WRITE' });
        expect(await nodeOf({ caseId, node: 'w' })).toMatchObject({
          state: 'failed',
        });
        const a = await nodeOf({ caseId, node: 'a' });
        expect(a?.inputs[0].revision).toBeNull();
      });

      test('admits a write into another case', async () => {
        const caseId = await newCase(playbookOf());
        const other = await newCase(playbookOf());

        const writeBack = await runExecutorWriting({ caseId, target: other });

        expect(writeBack).toEqual({ status: 200 });
      });

      test('the assertion names the work in `work_id`', async () => {
        const caseId = await newCase(playbookOf());
        const other = await newCase(playbookOf());

        await runExecutorWriting({ caseId, target: other });

        expect(assertions[0].work_id).toEqual(expect.any(String));
      });
    });
  });
});
