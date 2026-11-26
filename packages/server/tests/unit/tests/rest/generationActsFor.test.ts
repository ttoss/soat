import {
  type AgentToolTurn,
  type GenerationBody,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * A generation names the principal its IAM token acts for beside the key that
 * minted the token, and keeps its starter's through a resume.
 */
describe('GET /api/v1/generations/:generation_id acts_for', () => {
  let turn: AgentToolTurn;
  let key: string;
  let keyId: string;
  let agentId: string;
  let clientToolName: string;

  const mintToken = async (principal?: { type: string; id: string }) => {
    const res = await authenticatedTestClient(key)
      .post('/api/v1/iam/tokens')
      .send({
        policy: { statement: [{ effect: 'Allow', action: ['*'] }] },
        ...(principal ? { principal } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.token as string;
  };

  const pauseAs = async (credential: string): Promise<GenerationBody> => {
    const res = await authenticatedTestClient(credential)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [proposeCalls([{ name: clientToolName, args: {} }])] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('requires_action');
    return res.body;
  };

  const getGeneration = async (generationId: string) => {
    const res = await turn.api().get(`/api/v1/generations/${generationId}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'genactsfor' });
    const policyId = await turn.createPolicy({
      statement: [
        {
          effect: 'Allow',
          action: [
            'agents:*',
            'generations:ResumeGeneration',
            'iam:CreateToken',
          ],
        },
      ],
    });
    const res = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: turn.unique('key'),
        project_id: turn.projectId,
        policy_ids: [policyId],
      });
    expect(res.status).toBe(201);
    key = res.body.key;
    keyId = res.body.id;
    const tool = await turn.createTool({
      type: 'client',
      execute: undefined,
      parameters: { type: 'object', properties: {} },
    });
    clientToolName = tool.name;
    agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: tool.id }],
    });
  });

  afterAll(async () => {
    await turn.close();
  });

  test("a token's principal is recorded beside the key that minted it", async () => {
    const principal = { type: 'channel_contact', id: 'ch_genactsfor' };
    const paused = await pauseAs(await mintToken(principal));

    const generation = await getGeneration(paused.id);

    expect(generation.started_by_principal_type).toBe('api_key');
    expect(generation.started_by_principal_id).toBe(keyId);
    expect(generation.acted_as).toEqual({
      principal_type: 'api_key',
      principal_id: keyId,
      acts_for: principal,
    });
    expect(generation.acts_for).toEqual(principal);
  });

  test('a generation acting for no principal records null', async () => {
    const paused = await pauseAs(await mintToken());

    expect((await getGeneration(paused.id)).acts_for).toBeNull();
  });

  test("a resumed generation keeps its starter's principal", async () => {
    const starter = { type: 'api_key', id: 'naturali_key_s' };
    const paused = await pauseAs(await mintToken(starter));
    const [call] = paused.required_action?.tool_calls ?? [];

    const resumed = await authenticatedTestClient(
      await mintToken({ type: 'api_key', id: 'naturali_key_w' })
    )
      .post(`/api/v1/agents/${agentId}/generate/${paused.id}/tool-outputs`)
      .send({ tool_outputs: [{ tool_call_id: call.id, output: 'ok' }] });
    expect(resumed.status).toBe(200);

    expect((await getGeneration(paused.id)).acts_for).toEqual(starter);
  });

  test('the listing carries it too', async () => {
    const principal = { type: 'mcp_server', id: 'srv_genactsfor' };
    const paused = await pauseAs(await mintToken(principal));

    const res = await turn
      .api()
      .get('/api/v1/generations')
      .query({ agent_id: agentId });
    expect(res.status).toBe(200);
    const listed = (
      res.body.data as Array<{ id: string; acts_for: unknown }>
    ).find((row) => {
      return row.id === paused.id;
    });
    expect(listed?.acts_for).toEqual(principal);
  });
});
