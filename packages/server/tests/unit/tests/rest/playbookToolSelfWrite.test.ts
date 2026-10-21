import crypto from 'node:crypto';

import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient } from '../../testClient';

/**
 * A dependent case's agent calls a tool whose server writes back with its
 * project's key, forwarding the call's assertion in `X-Soat-On-Behalf-Of`.
 * The key is the same one a direct caller holds, so the write is told apart
 * by the generation the assertion names.
 */

const PROFILE = {
  id: 'profile',
  title: 'Company profile',
  kind: 'collect',
  final: true,
  inputs: [
    {
      name: 'regime',
      schema: { type: 'string' },
      required: true,
      source: 'manual',
    },
  ],
};

type WriteBack = { status: number; code?: string };

describe("Playbook writes from a dependent case's agent through a tool", () => {
  let turn: AgentToolTurn;
  let projectKey: string;
  let companyId: string;
  let dependentId: string;
  let seq = 0;
  const writeBacks: WriteBack[] = [];
  const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const admin = () => {
    return authenticatedTestClient(turn.adminToken);
  };

  const newCase = async (
    playbookId: string,
    upstreams?: Record<string, string>
  ): Promise<string> => {
    seq += 1;
    const res = await admin()
      .post(`/api/v1/playbooks/${playbookId}/cases`)
      .send({ subject: `case-${seq}`, ...(upstreams && { upstreams }) });
    expect(res.status).toBe(201);
    await flushPlaybookExecutions();
    return res.body.id as string;
  };

  const revisionOf = async (args: {
    caseId: string;
    node: string;
    name: string;
  }) => {
    const res = await admin().get(`/api/v1/playbook-cases/${args.caseId}`);
    const node = (
      res.body.nodes as {
        id: string;
        inputs: { name: string; revision: number | null }[];
      }[]
    ).find((candidate) => {
      return candidate.id === args.node;
    });
    const input = node?.inputs.find((candidate) => {
      return candidate.name === args.name;
    });
    return input?.revision ?? null;
  };

  const writeInput = async (args: {
    caseId: string;
    node: string;
    name: string;
    value: unknown;
    credential?: string;
    onBehalfOf?: string;
  }) => {
    const request = authenticatedTestClient(
      args.credential ?? turn.adminToken
    ).post(`/api/v1/playbook-cases/${args.caseId}/inputs`);
    if (args.onBehalfOf) request.set('X-Soat-On-Behalf-Of', args.onBehalfOf);
    return request.send({
      inputs: [
        {
          node_id: args.node,
          name: args.name,
          value: args.value,
          expected_revision: await revisionOf(args),
        },
      ],
    });
  };

  /** Runs the dependent's agent, which writes `target`'s `regime` back. */
  const runAgentWriting = async (args: {
    dependent: string;
    target: { caseId: string; node: string; name: string };
  }) => {
    writeBacks.length = 0;
    const res = await writeInput({
      caseId: args.dependent,
      node: 'review',
      name: 'calls',
      value: [{ name: 'write_back', args: args.target }],
    });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
    expect(writeBacks).toHaveLength(1);
    return writeBacks[0];
  };

  /** A filled company case and a dependent reading it. */
  const boundPair = async () => {
    const company = await newCase(companyId);
    const filled = await writeInput({
      caseId: company,
      node: 'profile',
      name: 'regime',
      value: 'simples',
    });
    expect(filled.status).toBe(200);
    await flushPlaybookExecutions();
    const dependent = await newCase(dependentId, { company });
    return { company, dependent };
  };

  beforeAll(async () => {
    process.env.TOOL_ASSERTION_PRIVATE_KEY = crypto
      .generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'playbooktoolselfwrite' });

    const key = await admin()
      .post('/api/v1/api-keys')
      .send({ name: 'tool server key', project_id: turn.projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key;

    const path = `/${turn.unique('mcp')}`;
    turn.target.reply(path, async (body, request) => {
      if (body.method === 'tools/list') {
        const properties = {
          caseId: { type: 'string' },
          node: { type: 'string' },
          name: { type: 'string' },
        };
        const tool = {
          name: 'write_back',
          inputSchema: { type: 'object', properties },
        };
        return {
          body: { jsonrpc: '2.0', id: body.id, result: { tools: [tool] } },
        };
      }
      const params = body.params as {
        arguments: { caseId: string; node: string; name: string };
      };
      const res = await writeInput({
        ...params.arguments,
        value: 'hacked',
        credential: projectKey,
        onBehalfOf: request.headers['x-soat-tool-assertion'] as string,
      });
      const writeBack = { status: res.status, code: res.body.error?.code };
      writeBacks.push(writeBack);
      const text = JSON.stringify(writeBack);
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
      mcp: { url: `${turn.target.baseUrl}${path}` },
    });
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: tool.id }],
    });

    const playbook = async (definition: unknown) => {
      const res = await admin()
        .post('/api/v1/playbooks')
        .send({
          project_id: turn.projectId,
          name: turn.unique('playbook'),
          definition,
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    companyId = await playbook({ nodes: [PROFILE] });
    dependentId = await playbook({
      upstreams: [{ name: 'company', playbook_id: companyId }],
      nodes: [
        {
          id: 'profile',
          title: 'Company',
          kind: 'upstream',
          upstream: { name: 'company', node_id: 'profile' },
          inputs: [],
        },
        {
          id: 'review',
          title: 'Review',
          kind: 'execute',
          inputs: [
            {
              name: 'regime',
              schema: { type: 'string' },
              required: true,
              source: { node_id: 'profile', field: 'output.regime' },
            },
            {
              name: 'calls',
              schema: { type: 'array' },
              required: true,
              source: 'manual',
            },
          ],
          executor: { type: 'agent', id: agentId },
        },
      ],
    });
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
    await turn.close();
  });

  describe('POST /api/v1/playbook-cases/{case_id}/inputs', () => {
    test('refuses a write into the upstream case', async () => {
      const { company, dependent } = await boundPair();

      const writeBack = await runAgentWriting({
        dependent,
        target: { caseId: company, node: 'profile', name: 'regime' },
      });

      expect(writeBack).toEqual({ status: 403, code: 'PLAYBOOK_SELF_WRITE' });
      expect(
        await revisionOf({ caseId: company, node: 'profile', name: 'regime' })
      ).toBe(1);
    });

    test('refuses a write into the case itself', async () => {
      const { dependent } = await boundPair();

      const writeBack = await runAgentWriting({
        dependent,
        target: { caseId: dependent, node: 'review', name: 'calls' },
      });

      expect(writeBack).toEqual({ status: 403, code: 'PLAYBOOK_SELF_WRITE' });
    });

    test('admits a write into a case it does not read', async () => {
      const { dependent } = await boundPair();
      const { company: unrelated } = await boundPair();

      const writeBack = await runAgentWriting({
        dependent,
        target: { caseId: unrelated, node: 'profile', name: 'regime' },
      });

      expect(writeBack).toEqual({ status: 200 });
    });
  });
});
