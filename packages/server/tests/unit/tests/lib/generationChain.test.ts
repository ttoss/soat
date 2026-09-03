import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { deleteAgent } from 'src/lib/agentDelete';
import { createGeneration } from 'src/lib/agentGeneration';
import type { GenerationResult } from 'src/lib/agentGenerationTypes';
import { runToolCallContinuation } from 'src/lib/agentToolApprovalContinuation';
import { getApproval } from 'src/lib/approvals';
import { listExceptions, type MappedException } from 'src/lib/exceptions';
import { getGeneration, listGenerations } from 'src/lib/generations';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

/**
 * The continuation chain: a generation that spawns another generation, days
 * later, through an approval resolution or any other resumption.
 *
 * Every such spawn declares its parent with `initiator_generation_id`, and that
 * declaration is what the chain is bounded and observed by — the trace lineage
 * is derived from it rather than passed in, so a caller cannot half-declare a
 * continuation. Without it a chain minted a fresh, unlinked root every hop and
 * nothing counted the hops (#1161).
 *
 * A `lib/` test (tests.md keep-list rule 2): a continuation is spawned by an
 * internal resumption path, never by a request, so there is no entry point that
 * reaches this. Real DB; only the provider is a local fake.
 */

describe('continuation chain lineage and budget', () => {
  let modelServer: Server;
  let modelBaseUrl: string;
  let projectId: number;
  let agentPublicId: string;
  let aiProviderDbId: number;
  const originalBudget = process.env.MAX_CONTINUATION_CHAIN_GENERATIONS;

  const startModelServer = async (): Promise<string> => {
    modelServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-chain',
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
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      modelServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = modelServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  beforeAll(async () => {
    modelBaseUrl = await startModelServer();

    const project = await db.Project.create({ name: 'Chain Project' });
    projectId = project.id;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Chain Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: modelBaseUrl,
    });
    aiProviderDbId = aiProvider.id;
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Chain Agent',
    });
    agentPublicId = agent.publicId;
  });

  // The project's own ceiling is stored, not an env var, so it has to be
  // cleared as deliberately as the deployment's — the fixture project is
  // shared by every test in this block.
  const setProjectChainBudget = async (
    maxChainGenerations: number | null
  ): Promise<void> => {
    await db.Project.update(
      { maxChainGenerations },
      { where: { id: projectId } }
    );
  };

  afterEach(async () => {
    await setProjectChainBudget(null);
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

  const generate = async (
    initiatorGenerationId?: string
  ): Promise<GenerationResult> => {
    const result = await createGeneration({
      agentId: agentPublicId,
      projectIds: [projectId],
      messages: [{ role: 'user', content: 'continue' }],
      initiatorGenerationId,
    });
    if (!('status' in result)) {
      throw new Error('expected a non-streaming generation result');
    }
    return result;
  };

  // A member's completion updates the chain fire-and-forget off
  // `updateGenerationRecord`, so the quiescent status lands shortly after the
  // generation returns rather than with it.
  const waitForChainStatus = async (args: {
    rootGenerationId: string;
    status: string;
  }): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const chain = await db.GenerationChain.findOne({
        where: { rootGenerationId: args.rootGenerationId },
      });
      if (chain?.status === args.status) return;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(
      `chain ${args.rootGenerationId} never reached status ${args.status}`
    );
  };

  const traceOf = async (generationId: string) => {
    const generation = await db.Generation.findOne({
      where: { publicId: generationId },
      include: [{ model: db.Trace, as: 'trace' }],
    });
    return generation?.trace ?? null;
  };

  test('a continuation is linked into its initiator trace lineage', async () => {
    const root = await generate();
    const rootTrace = await traceOf(root.id);

    const continuation = await generate(root.id);
    const continuationTrace = await traceOf(continuation.id);

    // Derived from the initiator, never passed in: the hop is now part of one
    // tree instead of minting an unrelated root.
    expect(continuationTrace?.parentTraceId).toBe(rootTrace?.id);
    expect(continuationTrace?.rootTraceId).toBe(rootTrace?.id);

    // And a second hop keeps the same root rather than re-rooting at its parent.
    const second = await generate(continuation.id);
    const secondTrace = await traceOf(second.id);
    expect(secondTrace?.parentTraceId).toBe(continuationTrace?.id);
    expect(secondTrace?.rootTraceId).toBe(rootTrace?.id);
  });

  test('a root generation keeps a clean lineage', async () => {
    const root = await generate();
    const trace = await traceOf(root.id);

    expect(trace?.parentTraceId).toBeNull();
    expect(trace?.rootTraceId).toBeNull();
  });

  test('the chain is refused once its generation budget is spent', async () => {
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '2';

    const root = await generate();
    const first = await generate(root.id);
    const second = await generate(first.id);

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');

    // The third hop would be the chain's third continuation, one past the
    // budget: it is refused before the provider is called.
    const refused = await generate(second.id);
    expect(refused.output?.content).toBe('Continuation chain limit reached');

    const row = await db.Generation.findOne({
      where: { publicId: refused.id },
    });
    // Refusing costs no generation record — the trace carries the evidence,
    // exactly as the depth guard's refusal does.
    expect(row).toBeNull();
  });

  const chainOf = async (rootGenerationId: string) => {
    return db.GenerationChain.findOne({ where: { rootGenerationId } });
  };

  test('the first continuation creates the chain and links every member', async () => {
    const root = await generate();

    // A root that never continues is not a chain, so it gets no row: the table
    // holds runaway candidates, not one row per generation.
    expect(await chainOf(root.id)).toBeNull();

    const first = await generate(root.id);
    const chain = await chainOf(root.id);

    expect(chain).not.toBeNull();
    expect(chain?.publicId).toMatch(/^chain_/);
    expect(chain?.projectId).toBe(projectId);
    expect(chain?.agentId).toBe(agentPublicId);
    // Root plus the one continuation — the same population
    // `list-generations?chain_id=` returns, which is why the root is backfilled
    // rather than left naming no chain.
    expect(chain?.generationCount).toBe(2);
    expect(chain?.lastGenerationAt).not.toBeNull();

    for (const publicId of [root.id, first.id]) {
      const row = await db.Generation.findOne({ where: { publicId } });
      expect(row?.chainId).toBe(chain?.publicId);
    }

    // A second hop re-derives the count from its members instead of
    // incrementing, so a lost write cannot leave the number permanently wrong.
    await generate(first.id);
    await chain?.reload();
    expect(chain?.generationCount).toBe(3);
  });

  test('a generation names its chain on the wire and can be listed by it', async () => {
    const root = await generate();
    const first = await generate(root.id);
    const chain = await chainOf(root.id);

    const mapped = await getGeneration({
      publicId: first.id,
      projectIds: [projectId],
    });
    expect(mapped?.chain_id).toBe(chain?.publicId);

    // The chain's own key stays internal; this filter is how a caller walks
    // from a chain to the generations in it.
    const page = await listGenerations({
      projectIds: [projectId],
      chainId: chain?.publicId,
    });
    expect(page.total).toBe(2);
    expect(
      page.data.map((generation) => {
        return generation.id;
      })
    ).toEqual(expect.arrayContaining([root.id, first.id]));
  });

  test('a refused hop marks the chain budget_exhausted', async () => {
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '2';

    const root = await generate();
    const first = await generate(root.id);
    const second = await generate(first.id);

    // Quiescent: nothing is running and no approval is holding a hop open, so
    // the chain reads as finished rather than as a live runaway.
    await waitForChainStatus({
      rootGenerationId: root.id,
      status: 'concluded',
    });

    const refused = await generate(second.id);
    expect(refused.output?.content).toBe('Continuation chain limit reached');

    // The refusal is the chain's own record now, not only a trace step and an
    // exception: the row a human lists says why this chain stopped.
    const chain = await chainOf(root.id);
    expect(chain?.status).toBe('budget_exhausted');
    expect(chain?.generationCount).toBe(3);
  });

  /**
   * A held tool call on one chain member, lapsing un-approved, resumed the way
   * the expiry sweeper resumes it. Driven directly because the sweeper's own
   * resume is fire-and-forget — awaiting the runner makes the outcome an
   * assertion rather than a race.
   */
  const expireHeldCallOn = async (generationId: string): Promise<void> => {
    const item = await db.ApprovalItem.create({
      projectId,
      origin: 'tool_call',
      status: 'expired',
      proposedAction: { toolId: 'tool_chainexpiry00000', arguments: {} },
      expiresAt: new Date(Date.now() - 1000),
      generationId,
      agentId: agentPublicId,
    });

    await runToolCallContinuation({
      item: await getApproval({ id: item.publicId }),
      decision: {
        decision: 'expired',
        approvalId: item.publicId,
        resolvedBy: null,
        editedArgs: null,
        reason: null,
        result: null,
      },
    });
  };

  test('a terminal expiry inside a chain records the chain as expired', async () => {
    const root = await generate();
    const first = await generate(root.id);
    await waitForChainStatus({
      rootGenerationId: root.id,
      status: 'concluded',
    });

    // A held call on a chain member, expiring un-approved. The agent does not
    // opt into reacting, so nothing resumes it — which is the chain's ending,
    // not just this hop's, and the row is where that is legible.
    await expireHeldCallOn(first.id);

    const chain = await chainOf(root.id);
    expect(chain?.status).toBe('expired');
    // No continuation was spawned, so the population is unchanged.
    expect(chain?.generationCount).toBe(2);
  });

  test('an expiry does not relabel a chain the budget already refused', async () => {
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '2';

    const root = await generate();
    const first = await generate(root.id);
    const second = await generate(first.id);
    await generate(second.id);
    expect((await chainOf(root.id))?.status).toBe('budget_exhausted');

    // An over-budget chain's last held calls lapse as a matter of course, so
    // letting the expiry win would retire the one status that says a number
    // still needs fixing.
    await expireHeldCallOn(second.id);

    expect((await chainOf(root.id))?.status).toBe('budget_exhausted');
  });

  const createAgentWithChainBudget = async (args: {
    name: string;
    maxGenerations?: number;
  }): Promise<string> => {
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProviderDbId,
      name: args.name,
      // A realistic mix: the turn-scoped condition sits alongside the
      // chain-scoped one, so the ceiling resolver has to skip an entry that is
      // not its own rather than read the first thing in the list.
      stopConditions:
        args.maxGenerations === undefined
          ? null
          : [
              { type: 'has_tool_call', tool_name: 'done' },
              {
                type: 'max_chain_generations',
                max_generations: args.maxGenerations,
              },
            ],
    });
    return agent.publicId;
  };

  const generateAs = async (args: {
    agentId: string;
    initiatorGenerationId?: string;
  }): Promise<GenerationResult> => {
    const result = await createGeneration({
      agentId: args.agentId,
      projectIds: [projectId],
      messages: [{ role: 'user', content: 'continue' }],
      initiatorGenerationId: args.initiatorGenerationId,
    });
    if (!('status' in result)) {
      throw new Error('expected a non-streaming generation result');
    }
    return result;
  };

  const chainLimitDetail = async (
    rootGenerationId: string
  ): Promise<Record<string, unknown> | null> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const page = await listExceptions({ projectIds: [projectId] });
      const match = page.data.find((item) => {
        return (
          item.kind === 'chain_limit' &&
          isRecord(item.detail) &&
          item.detail.root_generation_id === rootGenerationId
        );
      });
      if (match && isRecord(match.detail)) return match.detail;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    return null;
  };

  test('an agent may cap its chain below the platform budget', async () => {
    // The platform default (100) is untouched here: the agent's own ceiling is
    // what stops the chain, which is the point — a runaway is a property of one
    // agent's wiring, and waiting for a deployment-wide backstop to notice it
    // is what made #1161 take 17 days.
    const agentId = await createAgentWithChainBudget({
      name: 'Agent Budget',
      maxGenerations: 2,
    });

    const root = await generateAs({ agentId });
    const first = await generateAs({
      agentId,
      initiatorGenerationId: root.id,
    });
    const second = await generateAs({
      agentId,
      initiatorGenerationId: first.id,
    });
    expect(second.output?.content).not.toBe('Continuation chain limit reached');

    const refused = await generateAs({
      agentId,
      initiatorGenerationId: second.id,
    });
    expect(refused.output?.content).toBe('Continuation chain limit reached');

    const chain = await chainOf(root.id);
    expect(chain?.status).toBe('budget_exhausted');

    // Which ceiling refused it, so the fix is obvious from the exception: raise
    // the agent's number, or raise the deployment's.
    expect(await chainLimitDetail(root.id)).toMatchObject({
      limit: 2,
      limit_source: 'agent',
    });
  });

  test('the platform budget still wins when it is the lower ceiling', async () => {
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '1';

    const agentId = await createAgentWithChainBudget({
      name: 'Agent Budget Above Platform',
      maxGenerations: 50,
    });

    const root = await generateAs({ agentId });
    const first = await generateAs({
      agentId,
      initiatorGenerationId: root.id,
    });

    // An agent cannot raise its own ceiling past the deployment's: the
    // effective budget is the smaller of the two.
    const refused = await generateAs({
      agentId,
      initiatorGenerationId: first.id,
    });
    expect(refused.output?.content).toBe('Continuation chain limit reached');

    expect(await chainLimitDetail(root.id)).toMatchObject({
      limit: 1,
      limit_source: 'platform',
    });
  });

  test('a project may cap its chains below the platform budget', async () => {
    // The operator's ceiling, which is the one an agent author cannot opt out
    // of and the deployment-wide default is too coarse to express: a project
    // owner bounds every chain in their project without touching either.
    await setProjectChainBudget(2);
    const agentId = await createAgentWithChainBudget({
      name: 'Agent Under Project Budget',
    });

    const root = await generateAs({ agentId });
    const first = await generateAs({
      agentId,
      initiatorGenerationId: root.id,
    });
    const second = await generateAs({
      agentId,
      initiatorGenerationId: first.id,
    });
    expect(second.output?.content).not.toBe('Continuation chain limit reached');

    const refused = await generateAs({
      agentId,
      initiatorGenerationId: second.id,
    });
    expect(refused.output?.content).toBe('Continuation chain limit reached');

    expect((await chainOf(root.id))?.status).toBe('budget_exhausted');
    expect(await chainLimitDetail(root.id)).toMatchObject({
      limit: 2,
      limit_source: 'project',
    });
  });

  test('an agent may cap its chain below its project budget', async () => {
    await setProjectChainBudget(5);
    const agentId = await createAgentWithChainBudget({
      name: 'Agent Stricter Than Project',
      maxGenerations: 2,
    });

    const root = await generateAs({ agentId });
    const first = await generateAs({
      agentId,
      initiatorGenerationId: root.id,
    });
    const second = await generateAs({
      agentId,
      initiatorGenerationId: first.id,
    });

    const refused = await generateAs({
      agentId,
      initiatorGenerationId: second.id,
    });
    expect(refused.output?.content).toBe('Continuation chain limit reached');

    expect(await chainLimitDetail(root.id)).toMatchObject({
      limit: 2,
      limit_source: 'agent',
    });
  });

  test('an agent cannot raise its chain above its project budget', async () => {
    // Same rule the platform ceiling already enforces, one level down: every
    // ceiling can only make the budget smaller, so no author can opt their
    // agent out of the number its project owner set.
    await setProjectChainBudget(1);
    const agentId = await createAgentWithChainBudget({
      name: 'Agent Above Project Budget',
      maxGenerations: 50,
    });

    const root = await generateAs({ agentId });
    const first = await generateAs({
      agentId,
      initiatorGenerationId: root.id,
    });

    const refused = await generateAs({
      agentId,
      initiatorGenerationId: first.id,
    });
    expect(refused.output?.content).toBe('Continuation chain limit reached');

    expect(await chainLimitDetail(root.id)).toMatchObject({
      limit: 1,
      limit_source: 'project',
    });
  });

  test('the budget counts continuations, not a turn own nested calls', async () => {
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '2';

    // Two generations sharing a root trace *without* declaring an initiator —
    // the shape an agent-to-agent tool call produces — are not chain hops, so
    // they must not consume the continuation budget.
    const root = await generate();
    const rootTrace = await traceOf(root.id);

    const nested = await createGeneration({
      agentId: agentPublicId,
      projectIds: [projectId],
      messages: [{ role: 'user', content: 'nested' }],
      parentTraceId: rootTrace?.publicId,
      rootTraceId: rootTrace?.publicId,
    });
    expect('status' in nested).toBe(true);

    const continuation = await generate(root.id);
    expect(continuation.status).toBe('completed');
    expect(continuation.output?.content).not.toBe(
      'Continuation chain limit reached'
    );
  });
});

/**
 * The chain's identity is its own column, not borrowed from trace lineage.
 *
 * Traces exist to be read, and their lineage is legitimately rewritten by
 * operations that know nothing about chains — `deleteAgent` nulls
 * `parentTraceId`/`rootTraceId` on every surviving trace that pointed at the
 * agent it removes. A budget keyed on that lineage therefore reset itself
 * whenever an unrelated ancestor agent was deleted, which is a runaway escaping
 * through a cleanup path (#1161).
 */
describe('chain identity survives trace lineage rewrites', () => {
  let modelServer: Server;
  let projectId: number;
  let agentPublicId: string;
  let ancestorAgentPublicId: string;
  let aiProviderDbId: number;
  const originalBudget = process.env.MAX_CONTINUATION_CHAIN_GENERATIONS;

  beforeAll(async () => {
    modelServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-lineage',
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
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      modelServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = modelServer.address() as AddressInfo;

    const project = await db.Project.create({ name: 'Lineage Project' });
    projectId = project.id;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Lineage Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: `http://127.0.0.1:${String(port)}`,
    });
    aiProviderDbId = aiProvider.id;

    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProviderDbId,
      name: 'Lineage Agent',
    });
    agentPublicId = agent.publicId;
  });

  beforeEach(async () => {
    const ancestor = await db.Agent.create({
      projectId,
      aiProviderId: aiProviderDbId,
      name: 'Ancestor Agent',
    });
    ancestorAgentPublicId = ancestor.publicId;
  });

  // The project's own ceiling is stored, not an env var, so it has to be
  // cleared as deliberately as the deployment's — the fixture project is
  // shared by every test in this block.
  const setProjectChainBudget = async (
    maxChainGenerations: number | null
  ): Promise<void> => {
    await db.Project.update(
      { maxChainGenerations },
      { where: { id: projectId } }
    );
  };

  afterEach(async () => {
    await setProjectChainBudget(null);
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

  const generate = async (args: {
    agentId: string;
    initiatorGenerationId?: string;
    parentTraceId?: string;
    rootTraceId?: string;
  }): Promise<GenerationResult> => {
    const result = await createGeneration({
      agentId: args.agentId,
      projectIds: [projectId],
      messages: [{ role: 'user', content: 'continue' }],
      initiatorGenerationId: args.initiatorGenerationId,
      parentTraceId: args.parentTraceId,
      rootTraceId: args.rootTraceId,
    });
    if (!('status' in result)) {
      throw new Error('expected a non-streaming generation result');
    }
    return result;
  };

  const chainLimitExceptions = async (): Promise<MappedException[]> => {
    const page = await listExceptions({ projectIds: [projectId] });
    return page.data.filter((item) => {
      return item.kind === 'chain_limit';
    });
  };

  // Filing rides the event bus fire-and-forget, so the row appears shortly
  // after the refusal returns rather than with it — and the second refusal's
  // fold lands later still.
  const waitForOccurrences = async (args: {
    rootGenerationId: string;
    occurrences: number;
  }): Promise<MappedException | null> => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const match = (await chainLimitExceptions()).find((item) => {
        return (
          isRecord(item.detail) &&
          item.detail.root_generation_id === args.rootGenerationId
        );
      });
      if (match && match.occurrence_count >= args.occurrences) return match;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    return null;
  };

  const publicTraceIdOf = async (generationId: string): Promise<string> => {
    const generation = await db.Generation.findOne({
      where: { publicId: generationId },
      include: [{ model: db.Trace, as: 'trace' }],
    });
    const traceId = generation?.trace?.publicId as string | undefined;
    if (!traceId) throw new Error(`no trace for ${generationId}`);
    return traceId;
  };

  test('deleting an ancestor agent does not reset a chain budget', async () => {
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '2';

    // The ancestor's turn calls into another agent, which is the shape that
    // puts a second agent's generations under the first agent's root trace.
    const ancestorRoot = await generate({ agentId: ancestorAgentPublicId });
    const ancestorTraceId = await publicTraceIdOf(ancestorRoot.id);

    const nested = await generate({
      agentId: agentPublicId,
      parentTraceId: ancestorTraceId,
      rootTraceId: ancestorTraceId,
    });

    const first = await generate({
      agentId: agentPublicId,
      initiatorGenerationId: nested.id,
    });
    const second = await generate({
      agentId: agentPublicId,
      initiatorGenerationId: first.id,
    });
    expect(second.output?.content).not.toBe('Continuation chain limit reached');

    // Removes the ancestor and, with it, the root trace every hop above points
    // at — the surviving traces are re-parented to null on the way out.
    await deleteAgent({
      id: ancestorAgentPublicId,
      projectIds: [projectId],
      force: true,
    });

    const afterDelete = await generate({
      agentId: agentPublicId,
      initiatorGenerationId: second.id,
    });
    expect(afterDelete.output?.content).toBe(
      'Continuation chain limit reached'
    );
  });

  test('a refused chain files one chain_limit exception per chain', async () => {
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = '1';

    const root = await generate({ agentId: agentPublicId });
    const first = await generate({
      agentId: agentPublicId,
      initiatorGenerationId: root.id,
    });

    // Two refusals on the same chain: an over-budget chain keeps being resumed
    // by whatever background sweep owns it, so the exception has to fold them.
    await generate({ agentId: agentPublicId, initiatorGenerationId: first.id });
    await generate({ agentId: agentPublicId, initiatorGenerationId: first.id });

    // Both refusals fold into the one item, so the chain is a single triage
    // entry whose occurrence count reads as how often it was refused.
    const filed = await waitForOccurrences({
      rootGenerationId: root.id,
      occurrences: 2,
    });
    expect(filed).not.toBeNull();
    expect(filed?.severity).toBe('warning');
    expect(filed?.agent_id).toBe(agentPublicId);
    expect(filed?.detail).toMatchObject({
      root_generation_id: root.id,
      initiator_generation_id: first.id,
      chain_size: 1,
      limit: 1,
    });

    const forThisChain = (await chainLimitExceptions()).filter((item) => {
      return (
        isRecord(item.detail) && item.detail.root_generation_id === root.id
      );
    });
    expect(forThisChain).toHaveLength(1);
  });

  test('a continuation naming an unknown initiator is refused', async () => {
    // Silently re-rooting here is the same unbounded chain by another route:
    // the budget counts from zero, and the generation runs with no record at
    // all, because `createGenerationRecord`'s own refusal is swallowed.
    await expect(
      generate({
        agentId: agentPublicId,
        initiatorGenerationId: 'gen_missinginitiator000',
      })
    ).rejects.toThrow(/not found/i);
  });
});
