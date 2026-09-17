import { db } from 'src/db';
import { createActor } from 'src/lib/actors';
import { createConversation } from 'src/lib/conversations';
import { createDecider } from 'src/lib/deciders';
import { writeMemory } from 'src/lib/memories';
import { createMemoryRule } from 'src/lib/memoryRules';
import { createMemoryStore } from 'src/lib/memoryStores';
import { resolveResourceScope } from 'src/lib/resourceScopes';

/**
 * The table that says what a public id authorizes against. It is the half of
 * the boundary check that is not visible from a refused call — a wrong SRN and
 * a missing resolver both read as "denied" — so each kind is asserted here
 * directly, against the pair its module's routes check.
 *
 * A `lib/` test because the mapping is the input space: one entry per kind,
 * two of them resolving to a resource other than the one named. The end-to-end
 * refusal is covered through the tool surface in
 * `rest/soatToolBoundaryScope.test.ts`.
 */
describe('resolveResourceScope', () => {
  let projectId: number;
  let projectPublicId: string;
  let storeId: string;
  let taggedStoreId: string;

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'ResourceScopes Test' });
    projectId = project.id as number;
    projectPublicId = project.publicId;

    storeId = (await createMemoryStore({ projectId, name: 'Scopes Store' })).id;
    taggedStoreId = (
      await createMemoryStore({
        projectId,
        name: 'Scopes Tagged Store',
        tags: { env: 'prod' },
      })
    ).id;
  });

  test('a memory store resolves to its own SRN parts and tags', async () => {
    const scope = await resolveResourceScope({
      kind: 'memory_store',
      publicId: taggedStoreId,
    });

    expect(scope).toEqual({
      resourceType: 'memory_store',
      resourceId: taggedStoreId,
      projectId,
      projectPublicId,
      tags: { env: 'prod' },
    });
  });

  test('a memory resolves to the store that holds it', async () => {
    const store = await db.MemoryStore.findOne({
      where: { publicId: taggedStoreId },
    });
    const written = await writeMemory({
      memoryStoreId: store!.id as number,
      content: 'A fact the scope test reads back.',
      assertion: {
        mechanism: 'api',
        principalType: 'user',
        principalId: 'user_scopes_test',
      },
    });

    const scope = await resolveResourceScope({
      kind: 'memory',
      publicId: written.entry.id,
    });

    expect(scope).toEqual({
      resourceType: 'memory_store',
      resourceId: taggedStoreId,
      projectId,
      projectPublicId,
      tags: { env: 'prod' },
    });
  });

  test('a memory rule resolves to the store it feeds', async () => {
    const store = await db.MemoryStore.findOne({
      where: { publicId: storeId },
    });
    const rule = await createMemoryRule({
      memoryStoreId: store!.id as number,
      on: 'agents.generation.completed',
    });

    const scope = await resolveResourceScope({
      kind: 'memory_rule',
      publicId: rule.id,
    });

    expect(scope).toEqual({
      resourceType: 'memory_store',
      resourceId: storeId,
      projectId,
      projectPublicId,
      tags: null,
    });
  });

  test('an agent resolves to its own SRN parts', async () => {
    const provider = await db.AiProvider.create({
      projectId,
      name: 'Scopes Agent Provider',
      provider: 'ollama',
      defaultModel: 'llama3.2',
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: provider.id,
      name: 'Scopes Standalone Agent',
    });

    const scope = await resolveResourceScope({
      kind: 'agent',
      publicId: agent.publicId,
    });

    expect(scope).toEqual({
      resourceType: 'agent',
      resourceId: agent.publicId,
      projectId,
      projectPublicId,
      // Agents carry no tags column, so a tag condition reads no pairs.
      tags: null,
    });
  });

  test('an actor resolves to its own SRN parts', async () => {
    const actor = await createActor({ projectId, name: 'Scopes Actor' });

    const scope = await resolveResourceScope({
      kind: 'actor',
      publicId: actor.id,
    });

    expect(scope).toEqual({
      resourceType: 'actor',
      resourceId: actor.id,
      projectId,
      projectPublicId,
      // The column defaults to an empty bag rather than null, so a condition
      // over resource tags reads no pairs — not a missing context.
      tags: {},
    });
  });

  test('a conversation resolves to its own SRN parts', async () => {
    const conversation = await createConversation({ projectId });

    const scope = await resolveResourceScope({
      kind: 'conversation',
      publicId: conversation.id,
    });

    expect(scope).toEqual({
      resourceType: 'conversation',
      resourceId: conversation.id,
      projectId,
      projectPublicId,
      tags: {},
    });
  });

  test('a session resolves to its own SRN parts', async () => {
    const provider = await db.AiProvider.create({
      projectId,
      name: 'Scopes Provider',
      provider: 'ollama',
      defaultModel: 'llama3.2',
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: provider.id,
      name: 'Scopes Agent',
    });
    const conversation = await createConversation({ projectId });
    const conversationRow = await db.Conversation.findOne({
      where: { publicId: conversation.id },
    });
    const session = await db.Session.create({
      projectId,
      agentId: agent.id,
      conversationId: conversationRow!.id,
      status: 'active',
      tags: { env: 'staging' },
    });

    const scope = await resolveResourceScope({
      kind: 'session',
      publicId: session.publicId,
    });

    expect(scope).toEqual({
      resourceType: 'session',
      resourceId: session.publicId,
      projectId,
      projectPublicId,
      tags: { env: 'staging' },
    });
  });

  /**
   * The kinds a route's own preamble resolves through the same accessor. Seeded
   * at the model rather than through REST: the assertion is the *mapping* — one
   * row, one SRN — not the routes, which their own `*ResourceScope` suites drive
   * end to end.
   */
  describe('the kinds moved off the project-level probe (#1339)', () => {
    let seeded: Record<string, string>;

    beforeAll(async () => {
      const aiProvider = await db.AiProvider.create({
        projectId,
        name: 'Scopes Kind Provider',
        provider: 'ollama',
        defaultModel: 'llama3.2',
      });
      const agent = await db.Agent.create({
        projectId,
        aiProviderId: aiProvider.id,
        name: 'Scopes Kind Agent',
      });
      const orchestration = await db.Orchestration.create({
        projectId,
        name: 'Scopes Kind Orchestration',
      });
      const dataset = await db.Dataset.create({
        projectId,
        name: 'Scopes Kind Dataset',
      });
      const trace = await db.Trace.create({
        projectId,
        agentId: agent.id,
        publicId: 'trace_scopes_kind',
      });

      const tool = await db.Tool.create({
        projectId,
        type: 'client',
        name: 'scopes-kind-tool',
      });

      const rows = {
        tool,
        guardrail: await db.Guardrail.create({
          projectId,
          name: 'scopes-kind-guardrail',
          document: { class: 'C' },
        }),
        orchestration,
        orchestration_run: await db.OrchestrationRun.create({
          projectId,
          orchestrationId: orchestration.id,
          status: 'queued',
        }),
        dataset,
        eval: await db.Eval.create({
          projectId,
          name: 'scopes-kind-eval',
          agentId: agent.id,
          datasetId: dataset.id,
          scorers: [{ type: 'exact_match' }],
        }),
        generation: await db.Generation.create({
          projectId,
          agentId: agent.id,
          traceId: trace.id,
          status: 'completed',
          startedAt: new Date(),
        }),
        trace,
        chain: await db.GenerationChain.create({
          projectId,
          rootGenerationId: 'gen_scopes_kind_root',
          status: 'active',
          generationCount: 1,
        }),
        quota: await db.Quota.create({
          projectId,
          scope: 'project',
          metric: 'requests',
          window: 'rolling_1h',
          limit: '100',
        }),
        model_route: await db.ModelRoute.create({
          projectId,
          name: 'scopes-kind-route',
          targets: [{ ai_provider_id: aiProvider.publicId, model: 'llama3.2' }],
          retryOn: ['timeout'],
          failureThreshold: 3,
          cooldownSeconds: 30,
        }),
        ingestionRule: await db.IngestionRule.create({
          projectId,
          contentTypeGlob: 'image/png',
          toolId: tool.id,
        }),
        audit: await db.AuditEntry.create({
          projectId,
          action: 'scopes:Kind',
          status: 200,
        }),
        usage: await db.UsageThreshold.create({
          projectId,
          metric: 'cost_usd',
          window: 'calendar_month',
          threshold: '100',
        }),
      };

      seeded = Object.fromEntries(
        Object.entries(rows).map(([kind, row]) => {
          return [kind, row.publicId as string];
        })
      );
    });

    // An orchestration run authorizes through the orchestration it runs, so its
    // SRN names that — the resource type its routes have always probed.
    test.each([
      ['tool', 'tool'],
      ['guardrail', 'guardrail'],
      ['orchestration', 'orchestration'],
      ['orchestration_run', 'orchestration'],
      ['dataset', 'dataset'],
      ['eval', 'eval'],
      ['generation', 'generation'],
      ['trace', 'trace'],
      ['chain', 'chain'],
      ['quota', 'quota'],
      ['model_route', 'model_route'],
      ['ingestionRule', 'ingestionRule'],
      ['audit', 'audit'],
      ['usage', 'usage'],
    ])(
      'a %s resolves to a %s SRN in its project',
      async (kind, resourceType) => {
        const scope = await resolveResourceScope({
          kind,
          publicId: seeded[kind],
        });

        expect(scope).toEqual({
          resourceType,
          resourceId:
            kind === 'orchestration_run' ? seeded.orchestration : seeded[kind],
          projectId,
          projectPublicId,
          tags: null,
        });
      }
    );

    test.each([
      ['tool', 'tool_absent'],
      ['guardrail', 'guard_absent'],
      ['orchestration', 'orch_absent'],
      ['orchestration_run', 'orch_run_absent'],
      ['dataset', 'dset_absent'],
      ['eval', 'eval_absent'],
      ['generation', 'gen_absent'],
      ['trace', 'trace_absent'],
      ['chain', 'chain_absent'],
      ['quota', 'quota_absent'],
      ['model_route', 'route_absent'],
      ['ingestionRule', 'igr_absent'],
      ['audit', 'audit_absent'],
      ['usage', 'uthr_absent'],
    ])('an id that names no %s resolves to nothing', async (kind, publicId) => {
      await expect(
        resolveResourceScope({ kind, publicId })
      ).resolves.toBeNull();
    });
  });

  test('a decider resolves to its own SRN parts', async () => {
    const provider = await db.AiProvider.create({
      projectId,
      name: 'Scopes TypeSafe',
      provider: 'typesafe',
      defaultModel: 'jev-latest',
    });

    const decider = await createDecider({
      projectId,
      name: 'Scopes Decider',
      aiProviderId: provider.publicId,
      questions: { a: { type: 'noul', instructions: 'A?' } },
    });

    const scope = await resolveResourceScope({
      kind: 'decider',
      publicId: decider.id,
    });

    // Neither carries a `tags` column, so the scope has no bag to read.
    expect(scope).toEqual({
      resourceType: 'decider',
      resourceId: decider.id,
      projectId,
      projectPublicId,
      tags: null,
    });
  });

  // A decision is written by an evaluation, which calls the provider; the row
  // is created directly here because the scope table is what is under test,
  // not the call that fills it.
  test('a decision resolves to its own SRN parts', async () => {
    const decision = await db.Decision.create({
      projectId,
      deciderId: 'dcd_scopes',
      deciderVersion: 1,
      model: 'jev-latest',
      answers: { a: { type: 'noul', noul: 0.5 } },
      usage: {},
    });

    const scope = await resolveResourceScope({
      kind: 'decision',
      publicId: decision.publicId,
    });

    // Neither carries a `tags` column, so the scope has no bag to read.
    expect(scope).toEqual({
      resourceType: 'decision',
      resourceId: decision.publicId,
      projectId,
      projectPublicId,
      tags: null,
    });
  });

  // Both leave the caller with the resource-less `*`, which matches no scoped
  // statement — so an unknown kind and a dangling id refuse rather than admit.
  test('an unknown kind resolves to nothing', async () => {
    const scope = await resolveResourceScope({
      kind: 'workflow',
      publicId: 'wkf_whatever',
    });

    expect(scope).toBeNull();
  });

  // Some accessors answer null on a miss and others throw; every kind has to
  // read the same way here, because "no scope" is what leaves the check on the
  // resource-less `*`.
  test.each([
    ['agent', 'agent_absent'],
    ['memory_store', 'mstore_absent'],
    ['memory', 'mem_absent'],
    ['memory_rule', 'mrule_absent'],
    ['actor', 'actor_absent'],
    ['conversation', 'conv_absent'],
    ['session', 'sess_absent'],
    ['decider', 'dcd_absent'],
    ['decision', 'dec_absent'],
  ])('an id that names no %s resolves to nothing', async (kind, publicId) => {
    await expect(resolveResourceScope({ kind, publicId })).resolves.toBeNull();
  });
});
