import { db } from 'src/db';
import { createGenerationRecord } from 'src/lib/generations';
import { saveTrace } from 'src/lib/traces';

import {
  type ChatRequest,
  startChatCompletionStub,
} from '../../fixtures/chatCompletionStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Every resource kind a builtin action can name, resolved to the SRN an
 * agent's `boundary_policy` is checked against — through a real turn.
 *
 * One builtin tool carries one `get-*` action per kind. The model (a local
 * chat-completions stub) calls each action twice in a single step: once with
 * a real id, and once with an id that names nothing. The boundary allows
 * exactly the SRNs the real ids resolve to, so a kind whose resolver maps to
 * the wrong SRN — or to none — is refused on its real id, and a resolver that
 * admitted what it could not resolve would let the absent id through.
 *
 * Three kinds authorize through a parent: a memory and a memory rule through
 * their store, an orchestration run through its orchestration. The boundary
 * names the parent, never the child.
 */
type KindCall = {
  kind: string;
  action: string;
  from: string;
  /** The SRN the boundary must name for the real id to be admitted. */
  srn: string;
  realId: string;
  absentId: string;
};

let plannedCalls: Array<{ name: string; arguments: Record<string, unknown> }> =
  [];

const stubPromise = startChatCompletionStub({
  reply: (request) => {
    const answered = request.messages.some((message) => {
      return message.role === 'tool';
    });
    return answered ? { content: 'Done.' } : { toolCalls: plannedCalls };
  },
});

const BOUNDARY_DENIAL = /^Forbidden: boundary policy denies /;

/** Every kind `resourceScopes.ts` resolves, in the order `kinds` lists them. */
const KINDS = [
  'actor',
  'agent',
  'audit',
  'chain',
  'conversation',
  'dataset',
  'decider',
  'decision',
  'eval',
  'generation',
  'guardrail',
  'ingestionRule',
  'memory',
  'memory_rule',
  'memory_store',
  'metadata_schema',
  'model_route',
  'orchestration',
  'orchestration_run',
  'quota',
  'session',
  'tool',
  'trace',
  'usage',
];

describe('POST /api/v1/agents/:agent_id/generate — builtin resource kinds', () => {
  let adminToken: string;
  let projectId: string;
  let internalProjectId: number;
  let kinds: KindCall[];
  let results: Map<string, { id?: string; error?: string } | null>;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const srn = (type: string, id: string) => {
    return `srn:${projectId}:${type}:${id}`;
  };

  beforeAll(async () => {
    const stub = await stubPromise;
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'kindsadmin', password: 'supersecret' });
    adminToken = await loginAs('kindsadmin', 'supersecret');

    projectId = await create('/api/v1/projects', {
      name: 'Builtin resource kinds',
    });
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    internalProjectId = project!.id as number;

    const providerId = await create('/api/v1/ai-providers', {
      project_id: projectId,
      name: 'Kinds provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    const agentId = await create('/api/v1/agents', {
      project_id: projectId,
      ai_provider_id: providerId,
      name: 'kinds-target-agent',
    });
    const toolId = await create('/api/v1/tools', {
      project_id: projectId,
      name: 'kinds-http-tool',
      type: 'http',
      execute: { url: 'https://example.test/convert', method: 'POST' },
    });
    const storeId = await create('/api/v1/memory-stores', {
      project_id: projectId,
      name: 'Kinds store',
    });
    const orchestrationId = await create('/api/v1/orchestrations', {
      project_id: projectId,
      name: 'kinds-orchestration',
      nodes: [{ id: 'start', type: 'transform', expression: 'done' }],
      edges: [],
    });
    const datasetId = await create('/api/v1/datasets', {
      project_id: projectId,
      name: 'kinds-dataset',
    });
    const deciderId = await create('/api/v1/deciders', {
      project_id: projectId,
      name: 'kinds-decider',
      agent_id: agentId,
      questions: { escalate: { type: 'boolean', instructions: 'Escalate?' } },
    });

    // Rows no single request creates on its own: a run, a recorded turn and
    // its trace, a chain, an audit entry and a decision are each the residue
    // of a longer flow, so they are written the way that flow writes them.
    const orchestration = await db.Orchestration.findOne({
      where: { publicId: orchestrationId },
    });
    const run = await db.OrchestrationRun.create({
      projectId: internalProjectId,
      orchestrationId: orchestration!.id,
      status: 'queued',
    });
    await saveTrace({
      traceId: 'trc_kinds',
      projectId: internalProjectId,
      projectPublicId: projectId,
      agentId,
      generationId: 'gen_kinds',
      steps: [{ type: 'text-delta', text: 'hello' }],
    });
    await createGenerationRecord({
      publicId: 'gen_kinds',
      projectId: internalProjectId,
      agentId,
      traceId: 'trc_kinds',
    });
    const chain = await db.GenerationChain.create({
      projectId: internalProjectId,
      agentId: null,
      rootGenerationId: 'gen_kinds',
      status: 'active',
      generationCount: 1,
      lastGenerationAt: new Date(),
    });
    const audit = await db.AuditEntry.create({
      projectId: internalProjectId,
      action: 'kinds:Seed',
      status: 200,
    });
    const decision = await db.Decision.create({
      projectId: internalProjectId,
      deciderId,
      deciderVersion: 1,
      status: 'completed',
    });

    const memoryId = await create('/api/v1/memories', {
      memory_store_id: storeId,
      content: 'A fact the kinds test reads back.',
    });
    const ruleId = await create('/api/v1/memory-rules', {
      memory_store_id: storeId,
      on: 'agents.generation.completed',
    });
    const actorId = await create('/api/v1/actors', {
      project_id: projectId,
      name: 'Kinds actor',
    });
    const conversationId = await create('/api/v1/conversations', {
      project_id: projectId,
    });
    const sessionId = await create('/api/v1/sessions', { agent_id: agentId });

    const own = (args: {
      kind: string;
      action: string;
      from: string;
      type?: string;
      realId: string;
      absentId: string;
    }): KindCall => {
      return { ...args, srn: srn(args.type ?? args.kind, args.realId) };
    };

    kinds = [
      own({
        kind: 'actor',
        action: 'get-actor',
        from: 'actor_id',
        realId: actorId,
        absentId: 'actor_absent',
      }),
      own({
        kind: 'agent',
        action: 'get-agent',
        from: 'agent_id',
        realId: agentId,
        absentId: 'agt_absent',
      }),
      own({
        kind: 'audit',
        action: 'get-audit-entry',
        from: 'entry_id',
        realId: audit.publicId,
        absentId: 'audit_absent',
      }),
      own({
        kind: 'chain',
        action: 'get-chain',
        from: 'chain_id',
        realId: chain.publicId,
        absentId: 'chain_absent',
      }),
      own({
        kind: 'conversation',
        action: 'get-conversation',
        from: 'conversation_id',
        realId: conversationId,
        absentId: 'conv_absent',
      }),
      own({
        kind: 'dataset',
        action: 'get-dataset',
        from: 'dataset_id',
        realId: datasetId,
        absentId: 'dset_absent',
      }),
      own({
        kind: 'decider',
        action: 'get-decider',
        from: 'decider_id',
        realId: deciderId,
        absentId: 'dcd_absent',
      }),
      own({
        kind: 'decision',
        action: 'get-decision',
        from: 'decision_id',
        realId: decision.publicId,
        absentId: 'dec_absent',
      }),
      own({
        kind: 'eval',
        action: 'get-eval',
        from: 'eval_id',
        realId: await create('/api/v1/evals', {
          project_id: projectId,
          name: 'kinds-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        }),
        absentId: 'eval_absent',
      }),
      own({
        kind: 'generation',
        action: 'get-generation',
        from: 'generation_id',
        realId: 'gen_kinds',
        absentId: 'gen_absent',
      }),
      own({
        kind: 'guardrail',
        action: 'get-guardrail',
        from: 'guardrail_id',
        realId: await create('/api/v1/guardrails', {
          project_id: projectId,
          name: 'kinds-guardrail',
          document: { default_class: 'C', class: 'C' },
        }),
        absentId: 'guard_absent',
      }),
      own({
        kind: 'ingestionRule',
        action: 'get-ingestion-rule',
        from: 'ingestion_rule_id',
        realId: await create('/api/v1/ingestion-rules', {
          project_id: projectId,
          content_type_glob: 'image/png',
          tool_id: toolId,
        }),
        absentId: 'igr_absent',
      }),
      {
        kind: 'memory',
        action: 'get-memory',
        from: 'memory_id',
        srn: srn('memory_store', storeId),
        realId: memoryId,
        absentId: 'mem_absent',
      },
      {
        kind: 'memory_rule',
        action: 'get-memory-rule',
        from: 'memory_rule_id',
        srn: srn('memory_store', storeId),
        realId: ruleId,
        absentId: 'mrule_absent',
      },
      own({
        kind: 'memory_store',
        action: 'get-memory-store',
        from: 'memory_store_id',
        realId: storeId,
        absentId: 'mstore_absent',
      }),
      own({
        kind: 'metadata_schema',
        action: 'get-metadata-schema',
        from: 'metadata_schema_id',
        realId: await create('/api/v1/metadata-schemas', {
          project_id: projectId,
          resource_type: 'document',
          path_prefix: '/kinds',
          schema: { type: 'object' },
        }),
        absentId: 'mdschema_absent',
      }),
      own({
        kind: 'model_route',
        action: 'get-model-route',
        from: 'route_id',
        realId: await create('/api/v1/model-routes', {
          project_id: projectId,
          name: 'kinds-route',
          targets: [{ ai_provider_id: providerId, model: 'stub-model' }],
        }),
        absentId: 'route_absent',
      }),
      own({
        kind: 'orchestration',
        action: 'get-orchestration',
        from: 'orchestration_id',
        realId: orchestrationId,
        absentId: 'orch_absent',
      }),
      {
        kind: 'orchestration_run',
        action: 'get-orchestration-run',
        from: 'orchestration_run_id',
        srn: srn('orchestration', orchestrationId),
        realId: run.publicId,
        absentId: 'orch_run_absent',
      },
      own({
        kind: 'quota',
        action: 'get-quota',
        from: 'quota_id',
        realId: await create('/api/v1/quotas', {
          project_id: projectId,
          scope: 'project',
          metric: 'requests',
          window: 'rolling_1h',
          limit: 100,
        }),
        absentId: 'quota_absent',
      }),
      own({
        kind: 'session',
        action: 'get-session',
        from: 'session_id',
        realId: sessionId,
        absentId: 'sess_absent',
      }),
      own({
        kind: 'tool',
        action: 'get-tool',
        from: 'tool_id',
        realId: toolId,
        absentId: 'tool_absent',
      }),
      own({
        kind: 'trace',
        action: 'get-trace',
        from: 'trace_id',
        realId: 'trc_kinds',
        absentId: 'trace_absent',
      }),
      own({
        kind: 'usage',
        action: 'delete-usage-threshold',
        from: 'threshold_id',
        realId: await create('/api/v1/usage/thresholds', {
          project_id: projectId,
          metric: 'cost_usd',
          window: 'calendar_month',
          threshold: 100,
        }),
        absentId: 'uthr_absent',
      }),
    ];

    const builtinToolId = await create('/api/v1/tools', {
      project_id: projectId,
      name: 'platform',
      type: 'builtin',
      actions: kinds.map((entry) => {
        return entry.action;
      }),
    });
    const boundAgentId = await create('/api/v1/agents', {
      project_id: projectId,
      ai_provider_id: providerId,
      name: 'kinds-caller-agent',
      max_steps: 2,
      tool_bindings: [{ tool_id: builtinToolId }],
      boundary_policy: {
        statement: [
          {
            effect: 'Allow',
            action: ['*'],
            resource: [
              ...new Set(
                kinds.map((entry) => {
                  return entry.srn;
                })
              ),
            ],
          },
        ],
      },
    });

    plannedCalls = kinds.flatMap((entry) => {
      return [entry.realId, entry.absentId].map((id) => {
        return {
          name: `platform_${entry.action}`,
          arguments: { [entry.from]: id },
        };
      });
    });

    const before = stub.requests.length;
    const res = await asAdmin()
      .post(`/api/v1/agents/${boundAgentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'Read everything.' }] });
    expect(res.status).toBe(200);

    // The request answering the step carries one tool result per call, keyed
    // by the call id the stub assigned in plan order.
    const answer: ChatRequest = stub.requests.slice(before)[1];
    results = new Map();
    for (const message of answer.messages) {
      if (message.role !== 'tool' || !message.tool_call_id) continue;
      const index = Number(message.tool_call_id.split('_').pop());
      const call = plannedCalls[index];
      results.set(
        `${call.name}:${Object.values(call.arguments)[0] as string}`,
        JSON.parse(String(message.content))
      );
    }
  });

  afterAll(async () => {
    await (await stubPromise).close();
  });

  const resultOf = (entry: KindCall, id: string) => {
    return results.get(`platform_${entry.action}:${id}`);
  };

  test('every kind a builtin action names is checked', () => {
    expect(results.size).toBe(kinds.length * 2);
    expect(
      kinds.map((entry) => {
        return entry.kind;
      })
    ).toEqual(KINDS);
  });

  test.each(KINDS)('a %s is admitted on the SRN its route checks', (kind) => {
    const entry = kinds.find((candidate) => {
      return candidate.kind === kind;
    })!;

    // Admitted, the call runs: a read answers the resource, and the one
    // write (`delete-usage-threshold`) answers nothing.
    expect(resultOf(entry, entry.realId)).toEqual(
      entry.kind === 'usage'
        ? null
        : expect.objectContaining({ id: entry.realId })
    );
  });

  // "No scope" leaves the check on the resource-less `*`, which matches no
  // statement naming an SRN: an id that resolves to nothing is refused rather
  // than admitted unchecked — whether its accessor answers null or throws.
  test.each(KINDS)('a %s id that names nothing is refused', (kind) => {
    const entry = kinds.find((candidate) => {
      return candidate.kind === kind;
    })!;

    expect(resultOf(entry, entry.absentId)?.error).toMatch(BOUNDARY_DENIAL);
  });
});
