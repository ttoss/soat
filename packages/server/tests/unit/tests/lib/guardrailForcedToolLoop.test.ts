import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { db } from 'src/db';
import { createGeneration } from 'src/lib/agentGeneration';
import type { GenerationResult } from 'src/lib/agentGenerationTypes';
import { DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS } from 'src/lib/agentToolApproval';
// Also registers the tool_call resume handler the expiry sweeper fires.
import { expireDueApprovals } from 'src/lib/approvalScheduler';
import { createGuardrail } from 'src/lib/guardrails';

/**
 * Reproduces the runaway reported for a guardrail-gated tool on an agent with
 * `tool_choice: "required"`: a generation that can neither finish nor stay
 * stopped.
 *
 * - `tool_choice: "required"` forbids a final assistant message, so every step
 *   is a tool call (the stub provider below only ever answers with one, which
 *   is what that setting forces a real model to do).
 * - A class-C guardrail routes each of those calls to an approval instead of
 *   executing it, so the turn ends on `tool-calls` — never on `stop`.
 * - Nobody approves; ~24h later the expiry sweeper resumes each held call, and
 *   the tool_call continuation seeds a **new generation linked back to the
 *   original**, which re-enters the same forced-tool loop and files the next,
 *   larger round of approvals.
 *
 * The chain is invisible to the recursion budget: every link is a fresh
 * `createGeneration` with its own trace and no parent/root lineage, so the
 * depth guard sees depth 1 forever while the `initiator_generation_id` chain
 * grows a level per round and the population compounds.
 *
 * A `lib/` test (tests.md keep-list rule 2): the loop closes through the expiry
 * sweeper and its fire-and-forget resume handler, which no entry point reaches.
 * Real DB, real guardrail gate, real sweeper; only the provider is a local fake.
 */

// One step per gated call; two per turn keeps the round-over-round doubling
// visible without running 20 provider calls per generation.
const MAX_STEPS = 2;
const ROUNDS = 3;
const WAIT_TIMEOUT_MS = 20_000;

describe('guardrail-held tool calls under tool_choice: "required"', () => {
  let modelServer: Server;
  let modelBaseUrl: string;
  let modelRequests: Array<Record<string, unknown>> = [];
  let toolServer: Server;
  let toolBaseUrl: string;
  let toolRequests: Array<Record<string, unknown>> = [];
  let proposalCount = 0;

  // Answers every completion with a tool call and never with text — the
  // observable behaviour `tool_choice: "required"` imposes. Each proposal
  // carries distinct arguments, so no two approvals share a dedup key.
  const startModelServer = async (): Promise<string> => {
    modelServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        modelRequests.push(raw ? JSON.parse(raw) : {});
        proposalCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-forced',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `call_forced_${proposalCount}`,
                      type: 'function',
                      function: {
                        name: 'refund',
                        arguments: JSON.stringify({ amount: proposalCount }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
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

  const startToolServer = async (): Promise<string> => {
    toolServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        toolRequests.push(raw ? JSON.parse(raw) : {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      toolServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = toolServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  beforeAll(async () => {
    modelBaseUrl = await startModelServer();
    toolBaseUrl = await startToolServer();
  });

  afterEach(async () => {
    modelRequests = [];
    toolRequests = [];
    // Nothing may survive into the next test's sweep: `expireDueApprovals` is
    // process-wide, and a leftover item would seed a generation there.
    await db.ApprovalItem.destroy({ where: { status: 'pending' } });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      modelServer.close(() => {
        return resolve();
      });
    });
    await new Promise<void>((resolve) => {
      toolServer.close(() => {
        return resolve();
      });
    });
  });

  type Fixture = { projectId: number; agentPublicId: string };

  // The abandoned QA fixture from the report: forced tool choice, one bound
  // tool, that tool gated by a guardrail that routes every call to approval.
  const createFixture = async (name: string): Promise<Fixture> => {
    const project = await db.Project.create({ name: `${name} Project` });
    const projectId = project.id;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: `${name} Provider`,
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: modelBaseUrl,
    });

    const guardrail = await createGuardrail({
      projectId,
      name: `${name}-route-to-approval`,
      document: { class: 'C' },
    });

    const tool = await db.Tool.create({
      projectId,
      type: 'http',
      name: 'refund',
      description: 'Issue a refund',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
      },
      execute: { url: `${toolBaseUrl}/refund`, method: 'POST' },
      guardrailIds: [guardrail.id],
    });

    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: `${name} Agent`,
      instructions: 'You must call the available tool to answer.',
      toolBindings: [{ toolId: tool.publicId }],
      toolChoice: 'required',
      maxSteps: MAX_STEPS,
    });

    return { projectId, agentPublicId: agent.publicId };
  };

  const runGeneration = async (fixture: Fixture): Promise<GenerationResult> => {
    const result = await createGeneration({
      agentId: fixture.agentPublicId,
      projectIds: [fixture.projectId],
      messages: [{ role: 'user', content: 'issue the refund' }],
    });
    if (!('status' in result)) {
      throw new Error('expected a non-streaming generation result');
    }
    return result;
  };

  const pendingApprovals = async (projectId: number) => {
    return db.ApprovalItem.findAll({
      where: { projectId, status: 'pending' },
      order: [['id', 'ASC']],
    });
  };

  const generationsOf = async (projectId: number) => {
    return db.Generation.findAll({
      where: { projectId },
      order: [['id', 'ASC']],
    });
  };

  const countCompleted = async (projectId: number): Promise<number> => {
    return db.Generation.count({ where: { projectId, status: 'completed' } });
  };

  const waitFor = async (args: {
    until: () => Promise<boolean>;
    describe: string;
  }): Promise<void> => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await args.until()) return;
      await delay(25);
    }
    throw new Error(`timed out waiting for ${args.describe}`);
  };

  /**
   * One turn of the ~24h cycle: every held call expires un-approved, the
   * sweeper resumes it, and the continuation generations settle.
   */
  const expireHeldCallsAndSettle = async (args: {
    projectId: number;
    expectedCompleted: number;
  }): Promise<void> => {
    await db.ApprovalItem.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { projectId: args.projectId, status: 'pending' } }
    );

    // The sweeper claims in batches, so drain until nothing is left due.
    let claimed = 0;
    do {
      claimed = await expireDueApprovals();
    } while (claimed > 0);

    await waitFor({
      until: async () => {
        return (await countCompleted(args.projectId)) >= args.expectedCompleted;
      },
      describe: `${args.expectedCompleted} completed generations`,
    });
  };

  test('a forced-tool turn whose only tool is gated ends on tool-calls, never on stop', async () => {
    const fixture = await createFixture('Forced Loop Seed');

    const result = await runGeneration(fixture);

    expect(result.status).toBe('completed');
    expect(result.output?.finishReason).toBe('tool-calls');
    expect(result.output?.finishReason).not.toBe('stop');

    // Every provider request forbade a final assistant message, so no step
    // could have terminated the turn: it ran to `max_steps`.
    expect(modelRequests).toHaveLength(MAX_STEPS);
    for (const body of modelRequests) {
      expect(body.tool_choice).toBe('required');
    }

    // The gate held each call: nothing reached the tool, and each proposal is
    // parked on its own approval instead.
    expect(toolRequests).toHaveLength(0);
    const pending = await pendingApprovals(fixture.projectId);
    expect(pending).toHaveLength(MAX_STEPS);

    // The ~24h cadence the bursts ran on is the platform default TTL.
    expect(DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS).toBe(24 * 60 * 60);
    const ttlSeconds =
      (pending[0].expiresAt.getTime() - pending[0].createdAt.getTime()) / 1000;
    expect(Math.round(ttlSeconds)).toBe(
      DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS
    );
  });

  test('expiry — not an external caller — restarts the loop on a linked generation', async () => {
    const fixture = await createFixture('Forced Loop Expiry');

    const seed = await runGeneration(fixture);
    const seedRow = await db.Generation.findOne({
      where: { publicId: seed.id },
    });
    expect(seedRow).not.toBeNull();

    // Nobody approves. The expiry sweeper is the only thing that runs.
    await expireHeldCallsAndSettle({
      projectId: fixture.projectId,
      expectedCompleted: 1 + MAX_STEPS,
    });

    // Each expired call seeded a generation linked back to the original.
    const continuations = await db.Generation.findAll({
      where: { initiatorGenerationId: seedRow!.id },
    });
    expect(continuations).toHaveLength(MAX_STEPS);

    // And each of those re-entered the forced-tool loop, so the next round of
    // held calls is already filed: the state is self-perpetuating.
    const pending = await pendingApprovals(fixture.projectId);
    expect(pending).toHaveLength(MAX_STEPS * MAX_STEPS);
    expect(toolRequests).toHaveLength(0);
  });

  test('the chain compounds every round while the depth guard stays blind to it', async () => {
    const fixture = await createFixture('Forced Loop Chain');

    await runGeneration(fixture);

    let expectedGenerations = 1;
    const populationPerRound: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      // Each held call of each generation seeds one more generation.
      expectedGenerations += MAX_STEPS ** (round + 1);
      await expireHeldCallsAndSettle({
        projectId: fixture.projectId,
        expectedCompleted: expectedGenerations,
      });
      populationPerRound.push((await generationsOf(fixture.projectId)).length);
    }

    // 1 → 3 → 7 → 15 with MAX_STEPS = 2: the daily population grows by a
    // constant factor, exactly as the incident's 6 → 29 → 401 → 1,416 did.
    expect(populationPerRound).toEqual([3, 7, 15]);

    const generations = await generationsOf(fixture.projectId);

    // Not one generation ever finished: every turn stopped on tool calls.
    const stopReasons = new Set(
      generations.map((generation) => {
        return generation.stopReason;
      })
    );
    expect([...stopReasons]).toEqual(['tool-calls']);

    // The chain is deep. Walking `initiator_generation_id` from a leaf reaches
    // the root in exactly one hop per round.
    const byId = new Map(
      generations.map((generation) => {
        return [generation.id as number, generation];
      })
    );
    const leaf = generations[generations.length - 1];
    let chainDepth = 0;
    let cursor = leaf;
    while (cursor.initiatorGenerationId !== null) {
      cursor = byId.get(cursor.initiatorGenerationId as number)!;
      chainDepth += 1;
    }
    expect(chainDepth).toBe(ROUNDS);
    expect(cursor.initiatorGenerationId).toBeNull();

    // The depth guard, however, keys on trace lineage — and every link starts
    // a brand-new trace with no parent and no root, so the lineage it counts
    // is 1 deep forever and `remainingDepth` resets to the default each round.
    const traces = await db.Trace.findAll({
      where: { projectId: fixture.projectId },
    });
    expect(traces).toHaveLength(generations.length);
    for (const trace of traces) {
      expect(trace.parentTraceId).toBeNull();
      expect(trace.rootTraceId).toBeNull();
    }
    const traceIds = new Set(
      generations.map((generation) => {
        return generation.traceId;
      })
    );
    expect(traceIds.size).toBe(generations.length);

    // Nothing ever short-circuited: no depth guard, and the tool the whole
    // chain is about was never actually called.
    expect(stopReasons.has('depth_guard')).toBe(false);
    expect(toolRequests).toHaveLength(0);
  });
});
