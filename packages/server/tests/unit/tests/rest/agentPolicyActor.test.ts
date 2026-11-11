import { agentPolicyDenial } from 'src/lib/agentPolicyDenial';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

/**
 * `${iam:ActorId}` in an agent's policy binds to the end user the
 * generation runs for, so one policy confines every end user to their own
 * resources.
 */
describe('agent policy_ids bind ${iam:ActorId} to the generation actor', () => {
  let turn: AgentToolTurn;
  let ownStoreAgentId: string;
  let otherStoreAgentId: string;
  let actorId: string;

  const createActor = async (name: string): Promise<string> => {
    const res = await turn
      .api()
      .post('/api/v1/actors')
      .send({ project_id: turn.projectId, name });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createStore = async (owner: string): Promise<string> => {
    const res = await turn
      .api()
      .post('/api/v1/memory-stores')
      .send({
        project_id: turn.projectId,
        name: turn.unique('store'),
        tags: { owner },
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const WRITE = [{ name: 'write_memory', args: { content: 'Prefers tea.' } }];

  const writeAsActor = async (
    agentId: string
  ): Promise<Record<string, unknown>> => {
    const session = await turn
      .api()
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, actor_id: actorId });
    expect(session.status).toBe(201);
    const message = await turn
      .api()
      .post(`/api/v1/sessions/${session.body.id}/messages`)
      .send({
        message: JSON.stringify({ calls: WRITE }),
      });
    expect(message.status).toBe(201);
    const res = await turn
      .api()
      .post(`/api/v1/sessions/${session.body.id}/generate?wait=true`)
      .send({});
    expect(res.status).toBe(200);
    return JSON.parse(res.body.content)[0];
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'agentpolactor' });
    actorId = await createActor('own');
    const otherActorId = await createActor('other');

    const policy = await turn
      .api()
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['memories:*'],
              condition: {
                StringEquals: { 'iam:ResourceTag/owner': '${iam:ActorId}' },
              },
            },
          ],
        },
      });
    expect(policy.status).toBe(201);

    const agentWriting = (memoryStoreId: string) => {
      return turn.createAgent({
        knowledge_config: { write_memory_store_id: memoryStoreId },
        policy_ids: [policy.body.id],
      });
    };
    ownStoreAgentId = await agentWriting(await createStore(actorId));
    otherStoreAgentId = await agentWriting(await createStore(otherActorId));
  });

  afterAll(async () => {
    await turn.close();
  });

  test('the actor writes to a store tagged with its own id', async () => {
    const result = await writeAsActor(ownStoreAgentId);

    expect(result.error).toBeUndefined();
  });

  test("another actor's store is refused", async () => {
    expect(await writeAsActor(otherStoreAgentId)).toEqual({
      error: agentPolicyDenial({ action: 'memories:CreateMemory' }),
    });
  });

  test('a generation with no actor binds nothing and is refused', async () => {
    const { results } = await turn.generate({
      agentId: ownStoreAgentId,
      calls: WRITE,
    });

    expect(results).toEqual([
      { error: agentPolicyDenial({ action: 'memories:CreateMemory' }) },
    ]);
  });
});
