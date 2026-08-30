import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { createGeneration } from 'src/lib/agentGeneration';
import type { GenerationResult } from 'src/lib/agentGenerationTypes';

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
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Chain Agent',
    });
    agentPublicId = agent.publicId;
  });

  afterEach(() => {
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
