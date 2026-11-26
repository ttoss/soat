import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  providerFailure,
  startChatCompletionsStub,
  type StubReply,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { pollUntil } from '../../fixtures/poll';
import { authenticatedTestClient, testClient } from '../../testClient';

/** A chat-completions SSE answer streaming `content`. */
const streamedCompletion = (content: string): StubReply => {
  const chunk = (payload: Record<string, unknown>): string => {
    return `data: ${JSON.stringify({
      id: 'chatcmpl-forwarded-stream',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'vendor-b-smart',
      ...payload,
    })}\n\n`;
  };
  return {
    contentType: 'text/event-stream',
    body: Buffer.from(
      chunk({
        choices: [{ index: 0, delta: { role: 'assistant', content } }],
      }) +
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }) +
        'data: [DONE]\n\n'
    ),
  };
};

/**
 * A facade provider whose `model_aliases` forward to other providers of the
 * same project: each alias is served by its target's endpoint and vendor id,
 * and everything the caller reads names the facade and the alias.
 */
describe('AI provider model_aliases forwarding to another provider', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let stubA: ChatCompletionsStub;
  let stubB: ChatCompletionsStub;
  let sourceA: string;
  let sourceB: string;
  let facade: string;
  let counter = 0;

  const unique = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${Date.now()}-${counter}`;
  };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createProvider = async (body: Record<string, unknown>) => {
    return asAdmin()
      .post('/api/v1/ai-providers')
      .send({ project_id: projectId, name: unique('forwarding'), ...body });
  };

  const createSource = async (stub: ChatCompletionsStub) => {
    const res = await createProvider({
      provider: 'ollama',
      base_url: stub.baseUrl,
      default_model: 'vendor-default',
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createFacade = async (extra: Record<string, unknown> = {}) => {
    return createProvider({
      provider: 'openai',
      default_model: 'fast',
      model_aliases: {
        fast: { ai_provider_id: sourceA, model: 'vendor-a-fast' },
        smart: { ai_provider_id: sourceB, model: 'vendor-b-smart' },
      },
      model_aliases_only: true,
      ...extra,
    });
  };

  const createAgent = async (args: { providerId: string; model: string }) => {
    const res = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: unique('forwarding-agent'),
        ai_provider_id: args.providerId,
        model: args.model,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const generate = async (agentId: string) => {
    return asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
  };

  const usageEvents = (generationId: string) => {
    return pollUntil({
      read: async () => {
        const usage = await asAdmin()
          .get('/api/v1/usage/events')
          .query({ generation_id: generationId, meter_type: 'llm_tokens' });
        return usage.body.data as Array<{
          model: string;
          ai_provider_id: string;
        }>;
      },
      done: (events) => {
        return events.length > 0;
      },
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'aliasforward',
      policyActions: ['ai-providers:GetAiProvider'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    stubA = await startChatCompletionsStub();
    stubB = await startChatCompletionsStub();
    sourceA = await createSource(stubA);
    sourceB = await createSource(stubB);
    const created = await createFacade();
    expect(created.status).toBe(201);
    facade = created.body.id;
  });

  afterAll(async () => {
    await stubA.close();
    await stubB.close();
  });

  describe('POST /api/v1/ai-providers', () => {
    test('a facade whose aliases all forward needs no credential and reads its targets', async () => {
      const read = await asAdmin().get(`/api/v1/ai-providers/${facade}`);
      expect(read.status).toBe(200);
      expect(read.body.secret_id).toBeNull();
      expect(read.body.model_aliases).toEqual({
        fast: { ai_provider_id: sourceA, model: 'vendor-a-fast' },
        smart: { ai_provider_id: sourceB, model: 'vendor-b-smart' },
      });
    });

    test('401 without credentials', async () => {
      const res = await testClient.post('/api/v1/ai-providers').send({
        project_id: projectId,
        name: unique('forwarding'),
        provider: 'openai',
        default_model: 'fast',
        model_aliases: { fast: { ai_provider_id: sourceA, model: 'x' } },
      });
      expect(res.status).toBe(401);
    });

    test('403 without ai-providers:CreateAiProvider', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: unique('forwarding'),
          provider: 'openai',
          default_model: 'fast',
          model_aliases: { fast: { ai_provider_id: sourceA, model: 'x' } },
        });
      expect(res.status).toBe(403);
    });

    test('a forward missing its model is 400', async () => {
      const res = await createFacade({
        model_aliases: { fast: { ai_provider_id: sourceA } },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a target that does not exist is 400', async () => {
      const res = await createFacade({
        model_aliases: {
          fast: { ai_provider_id: 'aip_doesnotexist0000', model: 'x' },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a target in another project is 400', async () => {
      const other = await asAdmin()
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: unique('forwarding-other'),
          provider: 'ollama',
          base_url: stubA.baseUrl,
          default_model: 'vendor-default',
        });
      expect(other.status).toBe(201);
      const res = await createFacade({
        model_aliases: { fast: { ai_provider_id: other.body.id, model: 'x' } },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a target that itself forwards is 400', async () => {
      const res = await createFacade({
        model_aliases: { fast: { ai_provider_id: facade, model: 'smart' } },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH /api/v1/ai-providers/{ai_provider_id}', () => {
    test('a target may not start forwarding', async () => {
      const res = await asAdmin()
        .patch(`/api/v1/ai-providers/${sourceA}`)
        .send({
          model_aliases: {
            other: { ai_provider_id: sourceB, model: 'vendor-b-smart' },
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a provider may not forward to itself', async () => {
      const created = await createFacade();
      const res = await asAdmin()
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({
          model_aliases: {
            fast: { ai_provider_id: created.body.id, model: 'x' },
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('DELETE /api/v1/ai-providers/{ai_provider_id}', () => {
    test('deleting a provider an alias targets is 409, even with force', async () => {
      const res = await asAdmin()
        .delete(`/api/v1/ai-providers/${sourceB}`)
        .query({ force: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('AI_PROVIDER_HAS_DEPENDENTS');
      expect(res.body.error.meta.ai_provider_ids).toContain(facade);
      expect(res.body.error.meta.forcible).toBe(false);
    });
  });

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test('two aliases are served by two sources, metered on the facade under the alias', async () => {
      const fastAgent = await createAgent({
        providerId: facade,
        model: 'fast',
      });
      const smartAgent = await createAgent({
        providerId: facade,
        model: 'smart',
      });

      stubA.reply(textCompletion('from a'));
      stubB.reply(textCompletion('from b'));
      const beforeA = stubA.completions.length;
      const beforeB = stubB.completions.length;

      const fast = await generate(fastAgent);
      expect(fast.status).toBe(200);
      expect(stubA.completions[beforeA].body.model).toBe('vendor-a-fast');
      expect(fast.body.output.model).toBe('fast');

      const smart = await generate(smartAgent);
      expect(smart.status).toBe(200);
      expect(stubB.completions[beforeB].body.model).toBe('vendor-b-smart');
      expect(smart.body.output.model).toBe('smart');

      const fastEvents = await usageEvents(fast.body.id);
      expect(fastEvents).toHaveLength(1);
      expect(fastEvents[0].ai_provider_id).toBe(facade);
      expect(fastEvents[0].model).toBe('fast');

      const smartEvents = await usageEvents(smart.body.id);
      expect(smartEvents).toHaveLength(1);
      expect(smartEvents[0].ai_provider_id).toBe(facade);
      expect(smartEvents[0].model).toBe('smart');
    });

    test('a vendor failure on a forwarded alias names the facade and the alias only', async () => {
      const agent = await createAgent({ providerId: facade, model: 'smart' });
      stubB.reply(providerFailure(400));
      const res = await generate(agent);
      stubB.reply(textCompletion('recovered'));

      const body = JSON.stringify(res.body);
      expect(body).toContain('AI_PROVIDER_ERROR');
      expect(body).toContain(facade);
      expect(body).toContain("'smart'");
      expect(body).not.toContain(sourceB);
      expect(body).not.toContain('vendor-b-smart');
      expect(body).not.toContain('ollama');
      expect(body).not.toContain('upstream unavailable');
    });

    test('an unpriced alias under require_priced_model is 409 naming the facade and the alias', async () => {
      const priced = await createFacade({ require_priced_model: true });
      expect(priced.status).toBe(201);
      const agent = await createAgent({
        providerId: priced.body.id,
        model: 'smart',
      });
      const res = await generate(agent);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MODEL_NOT_PRICED');
      expect(res.body.error.meta.unpriced_rows).toEqual([
        { provider: 'openai', model: 'smart', component: 'input_tokens' },
        { provider: 'openai', model: 'smart', component: 'output_tokens' },
      ]);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(sourceB);
      expect(body).not.toContain('vendor-b-smart');
      expect(body).not.toContain('ollama');
    });
  });

  describe('POST /api/v1/chat/completions', () => {
    test('a model outside the aliases is 400 MODEL_NOT_OFFERED', async () => {
      const res = await asAdmin()
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: facade,
          model: 'vendor-a-fast',
          messages: [{ role: 'user', content: 'hello' }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
    });

    test('a forwarded alias is served by its target and answers the alias', async () => {
      stubB.reply(textCompletion('chat from b'));
      const before = stubB.completions.length;
      const res = await asAdmin()
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: facade,
          model: 'smart',
          messages: [{ role: 'user', content: 'hello' }],
        });
      expect(res.status).toBe(200);
      expect(stubB.completions[before].body.model).toBe('vendor-b-smart');
      expect(res.body.model).toBe('smart');
    });

    const streamSmart = async () => {
      return asAdmin()
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: facade,
          model: 'smart',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        });
    };

    test('a streamed forwarded alias is served by its target', async () => {
      stubB.reply(streamedCompletion('streamed from b'));
      const before = stubB.completions.length;
      const res = await streamSmart();
      expect(res.status).toBe(200);
      expect(stubB.completions[before].body.model).toBe('vendor-b-smart');
      expect(res.text).toContain('streamed from b');
      expect(res.text).not.toContain('"error"');
    });

    test('a streamed vendor failure on a forwarded alias names the facade and the alias only', async () => {
      stubB.reply(providerFailure(400));
      const res = await streamSmart();
      stubB.reply(textCompletion('recovered'));

      expect(res.status).toBe(200);
      const frame = res.text.split('\n').find((line) => {
        return line.startsWith('data:') && line.includes('"error"');
      });
      expect(frame).toBeDefined();
      const payload = JSON.parse((frame ?? '').slice('data:'.length)) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code).toBe('AI_PROVIDER_ERROR');
      expect(payload.error.message).toContain(facade);
      expect(payload.error.message).toContain("'smart'");
      expect(res.text).not.toContain(sourceB);
      expect(res.text).not.toContain('vendor-b-smart');
      expect(res.text).not.toContain('ollama');
      expect(res.text).not.toContain('upstream unavailable');
    });
  });
});
