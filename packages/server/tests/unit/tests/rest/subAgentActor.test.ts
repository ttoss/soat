import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

describe('a sub-agent turn started by a builtin tool', () => {
  let turn: AgentToolTurn;
  let parentAgentId: string;
  let childAgentId: string;
  let askTool: { id: string; name: string };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'subagentactor' });
    childAgentId = await turn.createAgent({});
    askTool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['create-agent-generation'],
      preset_parameters: { agent_id: childAgentId },
    });
    parentAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: askTool.id }],
    });
  });

  afterAll(async () => {
    await turn.close();
  });

  test("serves the parent turn's actor", async () => {
    const actor = await turn
      .api()
      .post('/api/v1/actors')
      .send({ project_id: turn.projectId, name: turn.unique('actor') });
    expect(actor.status).toBe(201);
    const session = await turn
      .api()
      .post('/api/v1/sessions')
      .send({ agent_id: parentAgentId, actor_id: actor.body.id });
    expect(session.status).toBe(201);
    const message = await turn
      .api()
      .post(`/api/v1/sessions/${session.body.id}/messages`)
      .send({
        message: JSON.stringify({
          calls: [
            {
              name: `${askTool.name}_create-agent-generation`,
              args: { messages: [{ role: 'user', content: 'hello' }] },
            },
          ],
        }),
      });
    expect(message.status).toBe(201);
    const parent = await turn
      .api()
      .post(`/api/v1/sessions/${session.body.id}/generate?wait=true`)
      .send({});
    expect(parent.status).toBe(200);

    const children = await turn
      .api()
      .get(`/api/v1/generations?agent_id=${childAgentId}`);

    expect(children.status).toBe(200);
    expect(
      children.body.data.map((generation: { actor_id: string | null }) => {
        return generation.actor_id;
      })
    ).toEqual([actor.body.id]);
  });
});
