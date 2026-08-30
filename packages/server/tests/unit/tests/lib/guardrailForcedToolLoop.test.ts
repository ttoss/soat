import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { db } from 'src/db';
import { createGeneration } from 'src/lib/agentGeneration';
import type { GenerationResult } from 'src/lib/agentGenerationTypes';
import { DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS } from 'src/lib/agentToolApproval';
import { runToolCallContinuation } from 'src/lib/agentToolApprovalContinuation';
import { expireApprovalIfDue, getApproval } from 'src/lib/approvals';
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
const CHAIN_BUDGET = 4;
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
    delete process.env.MAX_CONTINUATION_CHAIN_GENERATIONS;
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

    // Exhaustion is distinguishable from a pause: the provider's own finish
    // reason still reads `tool-calls`, but the record says the step budget ran
    // out — which is what makes "this turn can never finish" observable.
    await waitFor({
      until: async () => {
        const row = await db.Generation.findOne({
          where: { publicId: result.id },
        });
        return row?.stopReason === 'max_steps';
      },
      describe: `generation ${result.id} to record stop_reason=max_steps`,
    });

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

  test('the chain is one linked tree, and it stops growing at its budget', async () => {
    // Small enough to be reached in two rounds; the platform default is 100.
    process.env.MAX_CONTINUATION_CHAIN_GENERATIONS = String(CHAIN_BUDGET);

    const fixture = await createFixture('Forced Loop Chain');
    const seed = await runGeneration(fixture);
    const seedRow = await db.Generation.findOne({
      where: { publicId: seed.id },
    });

    // Resumptions are driven sequentially here rather than through the sweeper,
    // so the budget is read and spent one continuation at a time: concurrent
    // resumptions each read the chain before any of them has written to it, and
    // the bound would only hold approximately.
    const populationPerRound: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const item of await pendingApprovals(fixture.projectId)) {
        await item.update({ expiresAt: new Date(Date.now() - 1000) });
        await expireApprovalIfDue({ id: item.publicId });
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
      }
      populationPerRound.push((await generationsOf(fixture.projectId)).length);
    }

    // Unbounded, this was 3 → 7 → 15 (and the incident's 6 → 29 → 401 → 1,416).
    // The chain now stops at its budget and the third round adds nothing.
    const generations = await generationsOf(fixture.projectId);
    expect(generations.length).toBeLessThanOrEqual(1 + CHAIN_BUDGET);
    expect(populationPerRound[ROUNDS - 1]).toBe(populationPerRound[ROUNDS - 2]);

    // Every turn still spends its whole step budget on held calls — the loop is
    // bounded, not fixed, and `max_steps` is what says so on the record.
    const stopReasons = new Set(
      generations.map((generation) => {
        return generation.stopReason;
      })
    );
    expect([...stopReasons]).toEqual(['max_steps']);
    expect(stopReasons.has('depth_guard')).toBe(false);
    expect(toolRequests).toHaveLength(0);

    // Every continuation declared its parent, and the lineage follows from it:
    // one tree rooted at the seed, not a fresh root per hop.
    const seedTrace = await db.Trace.findByPk(seedRow!.traceId as number);
    const continuations = generations.filter((generation) => {
      return generation.initiatorGenerationId !== null;
    });
    expect(continuations.length).toBe(generations.length - 1);
    for (const continuation of continuations) {
      const trace = await db.Trace.findByPk(continuation.traceId as number);
      expect(trace!.rootTraceId).toBe(seedTrace!.id);
      expect(trace!.parentTraceId).not.toBeNull();
    }
    expect(seedTrace!.parentTraceId).toBeNull();
    expect(seedTrace!.rootTraceId).toBeNull();
  });
});
