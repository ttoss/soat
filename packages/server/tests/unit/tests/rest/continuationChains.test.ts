import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { emitApproval } from 'src/lib/approvals';
import { expireDueApprovals } from 'src/lib/approvalScheduler';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The continuation chain: a generation spawned by resolving one of its
 * predecessor's held tool calls, declared through `initiator_generation_id`.
 * That declaration is what the chain is observed and bounded by — the trace
 * lineage is derived from it, the chain row counts its members, and the budget
 * refuses the hop that would exceed the smallest of the deployment's, the
 * project's and the agent's ceilings.
 *
 * Each hop is driven the way production drives one: a `tool_call` approval held
 * on the previous generation is rejected through REST, which resumes the agent
 * fire-and-forget. Approvals have no public create endpoint, so items are seeded
 * through `emitApproval`.
 */
describe('Continuation chains', () => {
  let adminToken: string;
  let modelServer: http.Server;
  let modelBaseUrl: string;
  const originalBudget = process.env.MAX_CONTINUATION_CHAIN_GENERATIONS;
  let fixtureCount = 0;
  /**
   * A hop resumed with this rejection reason is answered only once the test
   * releases it, so the test can act on the chain while that member runs.
   */
  const HOLD_REASON = 'hold this turn';
  let heldResponses: Array<() => void> = [];

  type Fixture = {
    projectId: string;
    projectInternalId: number;
    aiProviderId: string;
    agentId: string;
  };

  const waitFor = async <T>(args: {
    probe: () => Promise<T | undefined>;
    describe: string;
  }): Promise<T> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = await args.probe();
      if (value !== undefined) return value;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`timed out waiting for ${args.describe}`);
  };

  /** A fresh project and agent, so a stored ceiling never leaks across tests. */
  const createFixture = async (args: {
    projectBudget?: number;
    agentBudget?: number;
    onApprovalExpiry?: string;
  }): Promise<Fixture> => {
    fixtureCount += 1;
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: `chains project ${fixtureCount}` });
    expect(projectRes.status).toBe(201);
    const projectId = projectRes.body.id as string;

    if (args.projectBudget !== undefined) {
      const patched = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_chain_generations: args.projectBudget });
      expect(patched.status).toBe(200);
    }

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `chains provider ${fixtureCount}`,
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: modelBaseUrl,
      });
    expect(providerRes.status).toBe(201);

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: `chains agent ${fixtureCount}`,
        // The turn-scoped condition sits beside the chain-scoped one, so the
        // ceiling has to be read from its own entry, not the first in the list.
        ...(args.agentBudget === undefined
          ? {}
          : {
              stop_conditions: [
                { type: 'has_tool_call', tool_name: 'done' },
                {
                  type: 'max_chain_generations',
                  max_generations: args.agentBudget,
                },
              ],
            }),
        ...(args.onApprovalExpiry
          ? { on_approval_expiry: args.onApprovalExpiry }
          : {}),
      });
    expect(agentRes.status).toBe(201);

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    return {
      projectId,
      projectInternalId: project!.id as number,
      aiProviderId: providerRes.body.id as string,
      agentId: agentRes.body.id as string,
    };
  };

  type ListedGeneration = {
    id: string;
    status: string;
    chain_id: string | null;
    trace_id: string;
    initiator_generation_id: string | null;
  };

  const getGeneration = async (id: string): Promise<ListedGeneration> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/generations/${id}`
    );
    expect(res.status).toBe(200);
    return res.body as ListedGeneration;
  };

  const continuationsOf = async (
    generationId: string
  ): Promise<ListedGeneration[]> => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/generations')
      .query({ initiator_generation_id: generationId });
    expect(res.status).toBe(200);
    return res.body.data as ListedGeneration[];
  };

  const generateRoot = async (fixture: Fixture): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${fixture.agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'start' }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    return res.body.id as string;
  };

  /** Holds a tool call on `generationId`, the way a guardrail gate does. */
  const holdCallOn = (args: {
    fixture: Fixture;
    generationId: string;
    expiresInSeconds?: number;
  }) => {
    return emitApproval({
      projectId: args.fixture.projectInternalId,
      origin: 'tool_call',
      proposedAction: {
        toolId: 'tool_chainsheld0000000',
        arguments: { nonce: Math.random() },
      },
      expiresInSeconds: args.expiresInSeconds ?? 3600,
      generationId: args.generationId,
      agentId: args.fixture.agentId,
    });
  };

  /** Rejects a held call on `generationId`, which resumes the agent. */
  const resumeFrom = async (args: {
    fixture: Fixture;
    generationId: string;
    reason?: string;
  }): Promise<void> => {
    const item = await holdCallOn(args);
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/approvals/${item.id}/reject`)
      .send({ reason: args.reason ?? 'continue' });
    expect(res.status).toBe(200);
  };

  /** One hop: resumes from `generationId` and answers the continuation's id. */
  const hop = async (args: {
    fixture: Fixture;
    generationId: string;
  }): Promise<string> => {
    await resumeFrom(args);
    const continuation = await waitFor({
      probe: async () => {
        return (await continuationsOf(args.generationId))[0];
      },
      describe: `a continuation of ${args.generationId}`,
    });
    return continuation.id;
  };

  type Chain = {
    id: string;
    status: string;
    generation_count: number;
    agent_id: string | null;
    project_id: string;
  };

  const getChain = async (chainId: string): Promise<Chain> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/chains/${chainId}`
    );
    expect(res.status).toBe(200);
    return res.body as Chain;
  };

  const chainReaches = (args: {
    chainId: string;
    status: string;
  }): Promise<Chain> => {
    return waitFor({
      probe: async () => {
        const chain = await getChain(args.chainId);
        return chain.status === args.status ? chain : undefined;
      },
      describe: `chain ${args.chainId} to reach ${args.status}`,
    });
  };

  type Exception = {
    kind: string;
    severity: string;
    agent_id: string | null;
    occurrence_count: number;
    detail: Record<string, unknown>;
  };

  const chainLimitExceptions = async (args: {
    fixture: Fixture;
    rootGenerationId: string;
  }): Promise<Exception[]> => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/exceptions')
      .query({ project_id: args.fixture.projectId, kind: 'chain_limit' });
    expect(res.status).toBe(200);
    return (res.body.data as Exception[]).filter((item) => {
      return item.detail.root_generation_id === args.rootGenerationId;
    });
  };

  const chainLimitException = (args: {
    fixture: Fixture;
    rootGenerationId: string;
    occurrences?: number;
  }): Promise<Exception> => {
    return waitFor({
      probe: async () => {
        const [match] = await chainLimitExceptions(args);
        return match && match.occurrence_count >= (args.occurrences ?? 1)
          ? match
          : undefined;
      },
      describe: `a chain_limit exception for ${args.rootGenerationId}`,
    });
  };

  /** Resumes from `generationId` and waits for the budget to refuse the hop. */
  const refusedHop = async (args: {
    fixture: Fixture;
    generationId: string;
    chainId: string;
  }): Promise<Chain> => {
    await resumeFrom(args);
    const chain = await chainReaches({
      chainId: args.chainId,
      status: 'budget_exhausted',
    });
    // Refusing costs no generation record.
    expect(await continuationsOf(args.generationId)).toHaveLength(0);
    return chain;
  };

  /** Root plus `hops` continuations; answers every member, root first. */
  const growChain = async (args: {
    fixture: Fixture;
    hops: number;
  }): Promise<string[]> => {
    const members = [await generateRoot(args.fixture)];
    for (let index = 0; index < args.hops; index += 1) {
      members.push(
        await hop({ fixture: args.fixture, generationId: members[index] })
      );
    }
    return members;
  };

  const chainIdOf = async (generationId: string): Promise<string> => {
    const { chain_id: chainId } = await getGeneration(generationId);
    if (!chainId) throw new Error(`${generationId} names no chain`);
    return chainId;
  };

  beforeAll(async () => {
    modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const respond = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-chains',
              object: 'chat.completion',
              created: 0,
              model: 'stub-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'done' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            })
          );
        };
        if (raw.includes(`Reason: ${HOLD_REASON}`)) {
          heldResponses.push(respond);
          return;
        }
        respond();
      });
    });
    await new Promise<void>((resolve) => {
      modelServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = modelServer.address() as AddressInfo;
    modelBaseUrl = `http://127.0.0.1:${port}`;

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'chainsadmin', password: 'supersecret' });
    adminToken = await loginAs('chainsadmin', 'supersecret');
  });

  afterEach(() => {
    for (const respond of heldResponses) respond();
    heldResponses = [];
    if (originalBudget === undefined) {
      delete process.env.MAX_CONTINUATION_CHAIN_GENERATIONS;
      return;
    }
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = originalBudget;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      modelServer.close(() => {
        return resolve();
      });
    });
  });

  describe('lineage', () => {
    type Trace = {
      parent_trace_id: string | null;
      root_trace_id: string | null;
    };

    const traceOf = async (generationId: string): Promise<Trace> => {
      const { trace_id: traceId } = await getGeneration(generationId);
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/traces/${traceId}`
      );
      expect(res.status).toBe(200);
      return res.body as Trace;
    };

    test('a root generation keeps a clean lineage and names no chain', async () => {
      const fixture = await createFixture({});
      const root = await generateRoot(fixture);

      expect(await traceOf(root)).toMatchObject({
        parent_trace_id: null,
        root_trace_id: null,
      });
      expect((await getGeneration(root)).chain_id).toBeNull();
    });

    test('every hop joins the trace tree rooted at the first generation', async () => {
      const fixture = await createFixture({});
      const [root, first, second] = await growChain({ fixture, hops: 2 });
      const rootTraceId = (await getGeneration(root)).trace_id;
      const firstTraceId = (await getGeneration(first)).trace_id;

      expect(await traceOf(first)).toMatchObject({
        parent_trace_id: rootTraceId,
        root_trace_id: rootTraceId,
      });
      expect(await traceOf(second)).toMatchObject({
        parent_trace_id: firstTraceId,
        root_trace_id: rootTraceId,
      });
    });
  });

  describe('GET /api/v1/chains/{chain_id}', () => {
    test('the first continuation creates the chain and every member names it', async () => {
      const fixture = await createFixture({});
      const [root, first] = await growChain({ fixture, hops: 1 });
      const chainId = await chainIdOf(first);

      expect(chainId).toMatch(/^chain_/);
      expect((await getGeneration(root)).chain_id).toBe(chainId);
      const chain = await getChain(chainId);
      expect(chain).toMatchObject({
        id: chainId,
        project_id: fixture.projectId,
        agent_id: fixture.agentId,
        generation_count: 2,
      });

      const listed = await authenticatedTestClient(adminToken)
        .get('/api/v1/generations')
        .query({ chain_id: chainId });
      expect(listed.status).toBe(200);
      expect(listed.body.total).toBe(2);
      expect(
        (listed.body.data as ListedGeneration[]).map((generation) => {
          return generation.id;
        })
      ).toEqual(expect.arrayContaining([root, first]));
    });

    test('a later hop joins the existing chain and recounts its members', async () => {
      const fixture = await createFixture({});
      const [, first, second] = await growChain({ fixture, hops: 2 });

      const chainId = await chainIdOf(first);
      expect(await chainIdOf(second)).toBe(chainId);
      expect((await getChain(chainId)).generation_count).toBe(3);
    });
  });

  describe('budget', () => {
    test('the hop past the platform budget is refused and the chain says so', async () => {
      process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '2';
      const fixture = await createFixture({});
      const [root, first, second] = await growChain({ fixture, hops: 2 });
      const chainId = await chainIdOf(first);
      await chainReaches({ chainId, status: 'concluded' });

      const chain = await refusedHop({
        fixture,
        generationId: second,
        chainId,
      });

      expect(chain.generation_count).toBe(3);
      expect(
        await chainLimitException({ fixture, rootGenerationId: root })
      ).toMatchObject({
        detail: { limit: 2, limit_source: 'platform' },
      });
    });

    test.each([
      {
        name: 'an agent may cap its chain below the platform budget',
        agentBudget: 2,
        hops: 2,
        limit: 2,
        source: 'agent',
      },
      {
        name: 'the platform budget wins when it is the lower ceiling',
        platformBudget: 1,
        agentBudget: 50,
        hops: 1,
        limit: 1,
        source: 'platform',
      },
      {
        name: 'a project may cap its chains below the platform budget',
        projectBudget: 2,
        hops: 2,
        limit: 2,
        source: 'project',
      },
      {
        name: 'an agent may cap its chain below its project budget',
        projectBudget: 5,
        agentBudget: 2,
        hops: 2,
        limit: 2,
        source: 'agent',
      },
      {
        name: 'an agent cannot raise its chain above its project budget',
        projectBudget: 1,
        agentBudget: 50,
        hops: 1,
        limit: 1,
        source: 'project',
      },
      {
        name: 'a project ceiling above the platform budget does not raise it',
        platformBudget: 1,
        projectBudget: 5,
        hops: 1,
        limit: 1,
        source: 'platform',
      },
    ])('$name', async (row) => {
      if (row.platformBudget !== undefined) {
        process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = String(
          row.platformBudget
        );
      }
      const fixture = await createFixture({
        projectBudget: row.projectBudget,
        agentBudget: row.agentBudget,
      });
      const members = await growChain({ fixture, hops: row.hops });

      await refusedHop({
        fixture,
        generationId: members[members.length - 1],
        chainId: await chainIdOf(members[1]),
      });

      expect(
        await chainLimitException({ fixture, rootGenerationId: members[0] })
      ).toMatchObject({
        detail: { limit: row.limit, limit_source: row.source },
      });
    });

    test('a member that settles after the chain was refused leaves it refused', async () => {
      process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '2';
      const fixture = await createFixture({});
      const [, first] = await growChain({ fixture, hops: 1 });
      const chainId = await chainIdOf(first);
      await resumeFrom({ fixture, generationId: first, reason: HOLD_REASON });
      await waitFor({
        probe: async () => {
          return heldResponses.length > 0 ? true : undefined;
        },
        describe: 'the held member to reach the provider',
      });
      const [running] = await continuationsOf(first);

      await refusedHop({ fixture, generationId: running.id, chainId });
      for (const respond of heldResponses) respond();
      heldResponses = [];

      await waitFor({
        probe: async () => {
          const member = await getGeneration(running.id);
          return member.status === 'completed' ? member : undefined;
        },
        describe: `${running.id} to complete`,
      });
      // A settled member concludes only an `active` chain; the write is
      // fire-and-forget, so the assertion is that the refusal holds throughout.
      for (let tick = 0; tick < 20; tick += 1) {
        expect((await getChain(chainId)).status).toBe('budget_exhausted');
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
      }
    });

    test('repeated refusals of one chain fold into one chain_limit exception', async () => {
      process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '1';
      const fixture = await createFixture({});
      const [root, first] = await growChain({ fixture, hops: 1 });
      const chainId = await chainIdOf(first);

      await refusedHop({ fixture, generationId: first, chainId });
      await resumeFrom({ fixture, generationId: first });

      const filed = await chainLimitException({
        fixture,
        rootGenerationId: root,
        occurrences: 2,
      });
      expect(filed.severity).toBe('warning');
      expect(filed.agent_id).toBe(fixture.agentId);
      expect(filed.detail).toMatchObject({
        root_generation_id: root,
        initiator_generation_id: first,
        chain_size: 1,
        limit: 1,
      });
      expect(
        await chainLimitExceptions({ fixture, rootGenerationId: root })
      ).toHaveLength(1);
    });
  });

  describe('chain identity', () => {
    /** A turn recorded under another trace tree, as an agent-to-agent call is. */
    const generateNested = async (args: {
      fixture: Fixture;
      underGenerationId: string;
    }): Promise<string> => {
      const { trace_id: traceId } = await getGeneration(args.underGenerationId);
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${args.fixture.agentId}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'nested' }],
          parent_trace_id: traceId,
          root_trace_id: traceId,
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      return res.body.id as string;
    };

    test('a nested call under a root is not a hop of its chain', async () => {
      process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '1';
      const fixture = await createFixture({});
      const root = await generateRoot(fixture);
      await generateNested({ fixture, underGenerationId: root });

      const continuation = await hop({ fixture, generationId: root });

      expect((await getGeneration(continuation)).initiator_generation_id).toBe(
        root
      );
    });

    test('deleting an ancestor agent does not reset a chain budget', async () => {
      process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '2';
      const fixture = await createFixture({});
      const ancestorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: fixture.projectId,
          ai_provider_id: fixture.aiProviderId,
          name: 'chains ancestor agent',
        });
      expect(ancestorRes.status).toBe(201);
      const ancestor = { ...fixture, agentId: ancestorRes.body.id as string };
      const ancestorRoot = await generateRoot(ancestor);
      const nested = await generateNested({
        fixture,
        underGenerationId: ancestorRoot,
      });
      const first = await hop({ fixture, generationId: nested });
      const second = await hop({ fixture, generationId: first });

      const deleted = await authenticatedTestClient(adminToken).delete(
        `/api/v1/agents/${ancestor.agentId}?force=true`
      );
      expect(deleted.status).toBe(204);

      await refusedHop({
        fixture,
        generationId: second,
        chainId: await chainIdOf(first),
      });
    });
  });

  describe('expiry sweep', () => {
    test('a terminal expiry inside a chain records the chain as expired', async () => {
      const fixture = await createFixture({});
      const [, first] = await growChain({ fixture, hops: 1 });
      const chainId = await chainIdOf(first);
      await chainReaches({ chainId, status: 'concluded' });
      await holdCallOn({ fixture, generationId: first, expiresInSeconds: -10 });

      await expireDueApprovals();

      const chain = await chainReaches({ chainId, status: 'expired' });
      // Nothing resumed the lapsed call, so the population is unchanged.
      expect(chain.generation_count).toBe(2);
    });

    test('an expiry does not relabel a chain the budget already refused', async () => {
      process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '1';
      const fixture = await createFixture({});
      const [, first] = await growChain({ fixture, hops: 1 });
      const chainId = await chainIdOf(first);
      await refusedHop({ fixture, generationId: first, chainId });
      const held = await holdCallOn({
        fixture,
        generationId: first,
        expiresInSeconds: -10,
      });

      await expireDueApprovals();

      const approval = await authenticatedTestClient(adminToken).get(
        `/api/v1/approvals/${held.id}`
      );
      expect(approval.body.status).toBe('expired');
      // The resume is fire-and-forget and writes nothing on this path, so the
      // assertion is that the status holds for the whole window.
      for (let tick = 0; tick < 20; tick += 1) {
        expect((await getChain(chainId)).status).toBe('budget_exhausted');
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
      }
    });
  });
});
