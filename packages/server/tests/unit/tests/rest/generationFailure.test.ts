import { db } from 'src/db';
import * as agentNonStreamGenerationModule from 'src/lib/agentNonStreamGeneration';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import * as generationsModule from 'src/lib/generations';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  providerFailure,
  startChatCompletionsStub,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

describe('POST /api/v1/agents/:agent_id/generate — failures', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;

  const createAgent = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({ project_id: projectId, ai_provider_id: aiProviderId, name });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (agentId: string) => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    const setup = await setupProjectWithUsers({
      prefix: 'genrecordfail',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'generations:ListGenerations',
        'generations:GetGeneration',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Record Failure Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stub.baseUrl,
      });
    aiProviderId = providerRes.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await stub.close();
  });

  /**
   * The generation record is written fire-and-forget, inside one transaction
   * with its Trace. A failed write must neither surface to the caller nor leave
   * a Trace with no Generation behind: an orphaned Trace is invisible to the
   * generations listing yet trips `deleteAgent`'s no-dependents precondition.
   */
  describe('a failed generation record write', () => {
    test('a record write failure does not fail a generation that otherwise completes', async () => {
      const agentId = await createAgent('Record Failure Swallowed Agent');
      stub.reply(textCompletion('still answered'));
      // Sanctioned force-failure: drives the `.catch` on the fire-and-forget
      // record write; the turn itself runs for real.
      jest
        .spyOn(generationsModule, 'createGenerationRecord')
        .mockRejectedValueOnce(new Error('db unavailable'));

      const res = await generate(agentId);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.output.content).toBe('still answered');
    });

    test('a failed Generation insert rolls its Trace back with it', async () => {
      const agentId = await createAgent('Record Atomicity Agent');
      stub.reply(providerFailure());
      jest
        .spyOn(db.Generation, 'create')
        .mockRejectedValueOnce(new Error('simulated transient DB failure'));

      const res = await generate(agentId);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('AI_PROVIDER_ERROR');

      const listRes = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?agent_id=${agentId}`
      );
      expect(listRes.status).toBe(200);
      expect(listRes.body.total).toBe(0);

      // An orphaned Trace would make this a 409 though no Generation exists.
      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/agents/${agentId}`
      );
      expect(deleteRes.status).toBe(204);
    });
  });

  describe('a failed turn', () => {
    // A caller that got a `202` and went away learns of a dead background
    // generation only from the event, so it names the turn and the cause.
    test('announces agents.generation.failed with the turn and its error', async () => {
      const agentId = await createAgent('Failure Event Agent');
      stub.reply(providerFailure(400));
      const captured: SoatEvent[] = [];
      const handler = (event: SoatEvent) => {
        if (event.type === 'agents.generation.failed') captured.push(event);
      };
      eventBus.on('soat:event', handler);

      try {
        const res = await generate(agentId);
        expect(res.status).toBe(502);
        const { generation_id: generationId, trace_id: traceId } =
          res.body.error.meta;

        for (let tick = 0; tick < 100 && captured.length === 0; tick += 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        const mine = captured.filter((event) => {
          return event.resourceId === generationId;
        });
        expect(mine).toHaveLength(1);
        expect(mine[0].projectPublicId).toBe(projectId);
        expect(mine[0].resourceType).toBe('generation');
        expect(mine[0].data).toMatchObject({
          id: generationId,
          trace_id: traceId,
          status: 'failed',
          error: { code: 'AI_PROVIDER_ERROR' },
        });
      } finally {
        eventBus.off('soat:event', handler);
      }
    });

    // A thrown value that is not an `Error` carries no message worth showing
    // a caller, but the record still keeps what it was.
    test('a non-Error failure is a GENERATION_FAILED that names its trace', async () => {
      const agentId = await createAgent('Non-Error Failure Agent');
      // Sanctioned force-failure: drives the `.catch` around the dispatch with
      // a value no provider error mapping recognises.
      jest
        .spyOn(agentNonStreamGenerationModule, 'runNonStreamGeneration')
        .mockRejectedValueOnce({ code: 'SOME_OBJECT' });

      const res = await generate(agentId);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('GENERATION_FAILED');
      expect(res.body.error.message).toBe('Internal Server Error');
      expect(res.body.error.meta.trace_id).toMatch(/^trace_/);

      const generation = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${res.body.error.meta.generation_id}`
      );
      expect(generation.status).toBe(200);
      expect(generation.body.status).toBe('failed');
      expect(generation.body.error).toEqual({ message: '[object Object]' });
    });
  });
});
