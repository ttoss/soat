import { forbiddenHints } from '../../fixtures/agentRefusal';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * A project's `agent_policy_ids` cap every turn of every agent it owns, on
 * every check the turn's authority makes, its stored `knowledge_config`
 * retrieval included.
 */

const OPEN_PATH = '/open/cafeteria.txt';
const SECRET_PATH = '/secret/merger.txt';
const OPEN_TEXT = 'The cafeteria opens at nine.';
const SECRET_TEXT = 'The merger closes on Friday.';

const ALLOW_ALL = { effect: 'Allow', action: ['*'], resource: ['*'] };

const projectRefusal = (args: { projectId: string; action: string }) => {
  return {
    status: 403,
    error: {
      code: 'FORBIDDEN',
      ...forbiddenHints(),
      message: expect.stringMatching(
        new RegExp(
          `^Forbidden: project ${args.projectId}'s policies deny ${args.action}`
        )
      ),
      meta: expect.objectContaining({
        action: args.action,
        denied_by: { type: 'project', id: args.projectId },
      }),
    },
  };
};

describe("a project's agent_policy_ids", () => {
  let turn: AgentToolTurn;
  let openDocumentId: string;

  const setCap = async (statement: object[] | null) => {
    const policyIds = statement
      ? [await turn.createPolicy({ statement })]
      : null;
    const res = await turn
      .api()
      .patch(`/api/v1/projects/${turn.projectId}`)
      .send({ agent_policy_ids: policyIds });
    expect(res.status).toBe(200);
    expect(res.body.agent_policy_ids).toEqual(policyIds);
    return policyIds;
  };

  /** Hides the secret document from knowledge search, allowing the rest. */
  const denySecret = () => {
    return [
      ALLOW_ALL,
      {
        effect: 'Deny',
        action: ['knowledge:SearchKnowledge'],
        resource: [`srn:${turn.projectId}:document:${SECRET_PATH}`],
      },
    ];
  };

  /** The knowledge block the turn sent the model, or `''` when none. */
  const injected = async (args: {
    agentId: string;
    token?: string;
    knowledgeConfig?: object;
  }): Promise<string> => {
    const before = turn.model.requests.length;
    const res = await authenticatedTestClient(args.token ?? turn.adminToken)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({
        messages: [
          {
            role: 'user',
            content: 'What do we know?',
          },
        ],
        ...(args.knowledgeConfig
          ? { knowledge_config: args.knowledgeConfig }
          : {}),
      });
    expect(res.body).toEqual(expect.objectContaining({ status: 'completed' }));
    const block = turn.model.requests[before].messages?.find((message) => {
      return (
        typeof message.content === 'string' &&
        message.content.includes('<knowledge>')
      );
    });
    return typeof block?.content === 'string' ? block.content : '';
  };

  const storedKnowledgeAgent = (body: Record<string, unknown> = {}) => {
    return turn.createAgent({
      knowledge_config: { document_paths: ['/open/', '/secret/'] },
      ...body,
    });
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'projagentcap' });
    for (const [path, content] of [
      [OPEN_PATH, OPEN_TEXT],
      [SECRET_PATH, SECRET_TEXT],
    ]) {
      const res = await turn
        .api()
        .post('/api/v1/documents')
        .send({ project_id: turn.projectId, content, path });
      expect(res.status).toBe(201);
      if (path === OPEN_PATH) openDocumentId = res.body.id;
    }
  });

  afterEach(async () => {
    await setCap(null);
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('PATCH /api/v1/projects/:project_id', () => {
    test('sets, reads back and clears the cap', async () => {
      const policyIds = await setCap([ALLOW_ALL]);

      const read = await turn.api().get(`/api/v1/projects/${turn.projectId}`);
      expect(read.body.agent_policy_ids).toEqual(policyIds);

      await setCap(null);
    });

    test('an unknown policy id is 400 POLICY_NOT_FOUND', async () => {
      const res = await turn
        .api()
        .patch(`/api/v1/projects/${turn.projectId}`)
        .send({ agent_policy_ids: ['pol_doesnotexist'] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('POLICY_NOT_FOUND');
    });

    test('an empty entry is 400 VALIDATION_FAILED naming agent_policy_ids', async () => {
      const res = await turn
        .api()
        .patch(`/api/v1/projects/${turn.projectId}`)
        .send({ agent_policy_ids: [''] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta).toEqual({ field: 'agent_policy_ids' });
    });

    test('a carried policy cannot be deleted', async () => {
      const [policyId] = (await setCap([ALLOW_ALL])) as string[];

      const res = await turn.api().delete(`/api/v1/policies/${policyId}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('POLICY_HAS_DEPENDENTS');
      expect(res.body.error.meta.project_sample).toEqual([turn.projectId]);
    });

    describe('a writer', () => {
      const writerWith = async (actions: string[]) => {
        const username = turn.unique('capwriter');
        const user = await turn
          .api()
          .post('/api/v1/users')
          .send({ username, password: 'capwriterpass' });
        expect(user.body).toEqual(
          expect.objectContaining({ id: expect.any(String) })
        );
        const policyId = await turn.createPolicy({
          statement: [
            {
              effect: 'Allow',
              action: actions,
              resource: ['*'],
            },
          ],
        });
        await turn
          .api()
          .put(`/api/v1/users/${user.body.id}/policies`)
          .send({ policy_ids: [policyId] });
        return loginAs(username, 'capwriterpass');
      };

      const patchAs = async (token: string, statement: object) => {
        return authenticatedTestClient(token)
          .patch(`/api/v1/projects/${turn.projectId}`)
          .send({
            agent_policy_ids: [
              await turn.createPolicy({ statement: [statement] }),
            ],
          });
      };

      test('without projects:UpdateProject is 403', async () => {
        const token = await writerWith(['files:GetFile']);

        const res = await patchAs(token, {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: ['*'],
        });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      });

      test('that does not hold a grant the cap names is 403 POLICY_GRANT_NOT_HELD', async () => {
        const token = await writerWith(['projects:UpdateProject']);

        const res = await patchAs(token, {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: ['*'],
        });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
      });
    });
  });

  describe('stored knowledge_config retrieval', () => {
    test('an agent created after the cap is bounded by it with no configuration of its own', async () => {
      await setCap(denySecret());
      const agentId = await storedKnowledgeAgent();

      const text = await injected({ agentId });

      expect(text).toContain(OPEN_TEXT);
      expect(text).not.toContain(SECRET_TEXT);
    });

    test("the same deny in the agent's policy_ids bounds stored retrieval too", async () => {
      const agentId = await storedKnowledgeAgent({
        policy_ids: [await turn.createPolicy({ statement: denySecret() })],
      });

      const text = await injected({ agentId });

      expect(text).toContain(OPEN_TEXT);
      expect(text).not.toContain(SECRET_TEXT);
    });

    test('a knowledge_config override is bounded by the cap', async () => {
      await setCap(denySecret());
      const agentId = await turn.createAgent({});

      const text = await injected({
        agentId,
        knowledgeConfig: { document_paths: ['/open/', '/secret/'] },
      });

      expect(text).toContain(OPEN_TEXT);
      expect(text).not.toContain(SECRET_TEXT);
    });

    test("a shared agent's stored retrieval reads as a caller that cannot search its owner's project", async () => {
      const agentId = await storedKnowledgeAgent();
      const grantee = await turn
        .api()
        .post('/api/v1/projects')
        .send({ name: turn.unique('grantee') });
      const granteeKey = await turn
        .api()
        .post('/api/v1/api-keys')
        .send({
          name: turn.unique('grantee-key'),
          project_id: grantee.body.id,
        });
      const share = await turn
        .api()
        .post('/api/v1/shares')
        .send({
          project_id: turn.projectId,
          resource: `srn:${turn.projectId}:agent:${agentId}`,
          actions: ['agents:CreateAgentGeneration'],
          grantee: grantee.body.id,
        });
      expect(share.status).toBe(201);
      const accepted = await authenticatedTestClient(granteeKey.body.key).post(
        `/api/v1/shares/${share.body.id}/accept`
      );
      expect(accepted.status).toBe(200);

      const text = await injected({ agentId, token: granteeKey.body.key });

      expect(text).toBe('');
    });

    test('lifting the cap restores the stored retrieval', async () => {
      await setCap(denySecret());
      const agentId = await storedKnowledgeAgent();
      await setCap(null);

      const text = await injected({ agentId });

      expect(text).toContain(SECRET_TEXT);
    });
  });

  describe('builtin calls', () => {
    const DENY_GET_FILE = [
      ALLOW_ALL,
      { effect: 'Deny', action: ['files:GetFile'], resource: ['*'] },
    ];

    const listFiles = () => {
      return turn.createTool({
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        actions: ['list-files'],
      });
    };

    const callThroughAgent = async (
      tool: { id: string; name: string },
      callName = `${tool.name}_list-files`
    ) => {
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });
      const { results } = await turn.generate({
        agentId,
        calls: [{ name: callName, args: {} }],
      });
      return results[0];
    };

    test('a refusal names the project as what denied', async () => {
      const tool = await listFiles();
      await setCap(DENY_GET_FILE);

      expect(await callThroughAgent(tool)).toEqual(
        projectRefusal({ projectId: turn.projectId, action: 'files:GetFile' })
      );
    });

    test('a pipeline step is held to the cap', async () => {
      const builtin = await turn.createTool({
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        actions: ['get-document'],
      });
      const pipeline = await turn.createTool({
        type: 'pipeline',
        execute: undefined,
        parameters: { type: 'object', properties: {} },
        pipeline: {
          steps: [
            {
              id: 'read',
              tool_id: builtin.id,
              action: 'get-document',
              input: { document_id: openDocumentId },
            },
          ],
        },
      });
      await setCap([
        ALLOW_ALL,
        { effect: 'Deny', action: ['documents:GetDocument'], resource: ['*'] },
      ]);

      expect(
        JSON.stringify(await callThroughAgent(pipeline, pipeline.name))
      ).toContain(
        `Forbidden: project ${turn.projectId}'s policies deny documents:GetDocument`
      );
    });

    test('a run_as agent turn is held to the cap', async () => {
      const tool = await listFiles();
      await setCap(DENY_GET_FILE);
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
        run_as: 'agent',
        policy_ids: [await turn.createPolicy({ statement: [ALLOW_ALL] })],
      });

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: `${tool.name}_list-files`, args: {} }],
      });

      expect(results[0]).toEqual(
        projectRefusal({ projectId: turn.projectId, action: 'files:GetFile' })
      );
    });

    test('with no cap the call runs', async () => {
      const tool = await listFiles();

      const result = await callThroughAgent(tool);

      expect(Array.isArray(result.data)).toBe(true);
    });
  });
});
