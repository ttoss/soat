import { runJudgeCompletion } from 'src/lib/evaluationJudge';
import { runExtractionCompletion } from 'src/lib/memoryExtractionCompletion';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { freshProjectAndAgent, seedUsageEvent } from '../../fixtures/quotaSeed';
import {
  startStubChatProvider,
  type StubChatProvider,
} from '../../fixtures/stubChatProvider';
import { authenticatedTestClient } from '../../testClient';

/**
 * Token and cost quotas on the model calls that are not an agent generation:
 * a chat completion, an eval judge and memory extraction. Each spends tokens,
 * so each is refused by an `enforce` budget its project already spent.
 */

type Fresh = Awaited<ReturnType<typeof freshProjectAndAgent>>;

describe('token and cost quotas on agentless model spend', () => {
  let adminToken: string;
  let stub: StubChatProvider;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'spendquota',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    stub = await startStubChatProvider();
  });

  afterAll(async () => {
    await stub.close();
  });

  const spent = async (name: string): Promise<Fresh> => {
    const ctx = await freshProjectAndAgent({
      adminToken,
      name,
      baseUrl: stub.baseUrl,
    });
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      agentInternalId: ctx.agentInternalId,
      tokens: { input: 600, output: 600 },
    });
    return ctx;
  };

  const createQuota = async (
    ctx: Fresh,
    body: Record<string, unknown>
  ): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/quotas')
      .send({
        project_id: ctx.projectPublicId,
        window: 'calendar_month',
        metric: 'tokens',
        limit: 1000,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const complete = (ctx: Fresh) => {
    return authenticatedTestClient(adminToken)
      .post('/api/v1/chat/completions')
      .send({
        ai_provider_id: ctx.aiProviderPublicId,
        messages: [{ role: 'user', content: 'hello' }],
      });
  };

  describe('POST /api/v1/chat/completions', () => {
    test('a spent project budget refuses the completion', async () => {
      const ctx = await spent('spendquota-chat-breach');
      const quotaId = await createQuota(ctx, { scope: 'project' });
      const before = stub.completions();

      const res = await complete(ctx);

      expect(res.status).toBe(429);
      expect(res.body.error).toMatchObject({
        code: 'QUOTA_EXCEEDED',
        meta: { quota_id: quotaId, metric: 'tokens' },
      });
      expect(stub.completions()).toBe(before);
    });

    test('a budget under its limit admits the completion', async () => {
      const ctx = await spent('spendquota-chat-under');
      await createQuota(ctx, { scope: 'project', limit: 5000 });

      expect((await complete(ctx)).status).toBe(200);
    });

    test('a monitor budget never refuses', async () => {
      const ctx = await spent('spendquota-chat-monitor');
      await createQuota(ctx, { scope: 'project', mode: 'monitor' });

      expect((await complete(ctx)).status).toBe(200);
    });

    test('an agent budget does not gate a completion no agent runs', async () => {
      const ctx = await spent('spendquota-chat-agent');
      await createQuota(ctx, {
        scope: 'agent',
        scope_ref: ctx.agentPublicId,
      });

      expect((await complete(ctx)).status).toBe(200);
    });
  });

  describe('eval judge', () => {
    test('a spent project budget refuses the judge completion', async () => {
      const ctx = await spent('spendquota-judge');
      const quotaId = await createQuota(ctx, { scope: 'project' });
      const before = stub.completions();

      await expect(
        runJudgeCompletion({
          projectId: ctx.projectInternalId,
          scorer: {
            prompt: '{{output}}',
            ai_provider_id: ctx.aiProviderPublicId,
          },
          input: 'q',
          output: 'a',
          expected: null,
        })
      ).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
        meta: { quota_id: quotaId },
      });
      expect(stub.completions()).toBe(before);
    });
  });

  describe('memory extraction', () => {
    test('a spent agent budget refuses the extraction completion', async () => {
      const ctx = await spent('spendquota-extract');
      const quotaId = await createQuota(ctx, {
        scope: 'agent',
        scope_ref: ctx.agentPublicId,
      });
      const before = stub.completions();

      await expect(
        runExtractionCompletion({
          agentId: ctx.agentPublicId,
          prompt: 'Extract.',
        })
      ).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
        meta: { quota_id: quotaId },
      });
      expect(stub.completions()).toBe(before);
    });
  });
});
