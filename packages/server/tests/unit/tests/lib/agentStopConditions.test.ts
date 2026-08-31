import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import { db } from 'src/db';
import { buildModel } from 'src/lib/agentModel';
import {
  runNonStreamGeneration,
  runToolOutputsGeneration,
} from 'src/lib/agentNonStreamGeneration';

/**
 * `stop_conditions` is a documented agent field: the loop stops when any
 * condition is met, and the one condition the docs define is
 * `{ type: "hasToolCall", tool_name: "<resolved name>" }` — the terminator for
 * the "done tool" idiom.
 *
 * It was stored, wire-mapped, versioned and snapshotted, and reached nothing:
 * every `stopWhen` was `isStepCount(maxSteps)` alone, so an author who set it
 * got silence. Same shape as #811 (`active_tool_ids` silently ignored).
 *
 * A `lib/` test (tests.md keep-list rule 2): what is under test is how many
 * times the *provider* is called, which no REST assertion can see. Real DB,
 * real `generateText`, real tool execution; only the provider is a local stub.
 */
describe('stop_conditions', () => {
  let stubServer: Server;
  let stubBaseUrl: string;
  let projectDbId: number;
  let projectPublicId: string;
  let agentPublicId: string;
  let requestCount = 0;

  const MAX_STEPS = 4;

  // Always answers with a call to `done`, so nothing but a stop condition can
  // end the loop before the step budget runs out.
  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        requestCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stop',
            object: 'chat.completion',
            created: 0,
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `call_done_${requestCount}`,
                      type: 'function',
                      function: { name: 'done', arguments: '{}' },
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
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const resolvedTools = (): Record<string, Tool> => {
    return {
      done: tool({
        description: 'Signals the task is finished',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => {
          return { acknowledged: true };
        },
      }) as Tool,
    };
  };

  const typedAgent = (stopConditions: object[] | null) => {
    return {
      instructions: null,
      model: 'mock-model',
      toolIds: null,
      maxSteps: MAX_STEPS,
      toolChoice: 'auto',
      stopConditions,
      activeToolIds: null,
      stepRules: null,
      boundaryPolicy: null,
      temperature: null,
      outputSchema: null,
      project: { id: projectDbId, publicId: projectPublicId },
      aiProvider: { publicId: 'aip_stopcond' },
    } as never;
  };

  const run = (args: {
    generationId: string;
    stopConditions: object[] | null;
  }) => {
    return runNonStreamGeneration({
      toolChoice: undefined,
      model: buildModel({
        provider: 'ollama',
        secretValue: null,
        model: 'mock-model',
        baseUrl: stubBaseUrl,
      }),
      allMessages: [{ role: 'user', content: 'do the thing' }],
      resolvedTools: resolvedTools(),
      typedAgent: typedAgent(args.stopConditions),
      generationId: args.generationId,
      traceId: `trc_${args.generationId}`,
      agentId: agentPublicId,
    });
  };

  beforeAll(async () => {
    stubBaseUrl = await startStubServer();

    const project = await db.Project.create({ name: 'StopConditions Project' });
    projectDbId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId: project.id,
      name: 'StopConditions Provider',
      provider: 'ollama',
      defaultModel: 'mock-model',
      baseUrl: stubBaseUrl,
    });

    const agent = await db.Agent.create({
      projectId: project.id,
      aiProviderId: aiProvider.id,
      name: 'StopConditions Agent',
    });
    agentPublicId = agent.publicId;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  beforeEach(() => {
    requestCount = 0;
  });

  test('without conditions the loop runs until the step budget is spent', async () => {
    // The baseline that makes the next test meaningful: this stub never stops
    // on its own, so `max_steps` is the only thing ending the turn.
    const result = await run({
      generationId: 'gen_stopcond_baseline',
      stopConditions: null,
    });

    expect(result.status).toBe('completed');
    expect(requestCount).toBe(MAX_STEPS);
  });

  test('hasToolCall ends the loop at the step that calls the tool', async () => {
    const result = await run({
      generationId: 'gen_stopcond_hastoolcall',
      stopConditions: [{ type: 'hasToolCall', tool_name: 'done' }],
    });

    expect(result.status).toBe('completed');
    // Step 1 called `done`, so the turn is over: three provider calls the
    // agent's author declared unnecessary are never made.
    expect(requestCount).toBe(1);
  });

  test('a condition naming another tool does not end the loop', async () => {
    // Guards against a stop condition that fires on any tool call at all.
    const result = await run({
      generationId: 'gen_stopcond_othertool',
      stopConditions: [{ type: 'hasToolCall', tool_name: 'not_called' }],
    });

    expect(result.status).toBe('completed');
    expect(requestCount).toBe(MAX_STEPS);
  });

  test('the resume after submit-tool-outputs honors them too', async () => {
    // The third `stopWhen` call site. It reads the config frozen onto the
    // paused generation, which already carried `stopConditions` — so the field
    // was available here all along and still went unused. Two sites deriving
    // the same thing independently is how the previous bug in this area
    // survived in both at once, which is why one resolver now feeds all three.
    const result = await runToolOutputsGeneration({
      generationId: 'gen_stopcond_resume',
      system: undefined,
      nonSystemMessages: [{ role: 'user', content: 'resume the thing' }],
      pending: {
        agentId: agentPublicId,
        projectId: projectDbId,
        projectPublicId,
        traceId: 'trc_stopcond_resume',
        parentTraceId: null,
        rootTraceId: null,
        generationId: 'gen_stopcond_resume',
        initiatorGenerationId: null,
        pendingToolCalls: [],
        messages: [],
        steps: [],
        resolvedModel: buildModel({
          provider: 'ollama',
          secretValue: null,
          model: 'mock-model',
          baseUrl: stubBaseUrl,
        }),
        resolvedTools: resolvedTools(),
        agentConfig: {
          instructions: null,
          maxSteps: MAX_STEPS,
          toolChoice: 'auto',
          stopConditions: [{ type: 'hasToolCall', tool_name: 'done' }],
          activeToolIds: null,
          stepRules: null,
          temperature: null,
          outputSchema: null,
        },
      },
    });

    expect(result.steps).toHaveLength(1);
    expect(requestCount).toBe(1);
  });

  test('an unknown condition type is ignored rather than failing the turn', async () => {
    // Rows written before the vocabulary was validated may carry anything; a
    // stored value must not break a generation that used to run.
    const result = await run({
      generationId: 'gen_stopcond_unknown',
      stopConditions: [{ type: 'someFutureCondition', value: 3 }],
    });

    expect(result.status).toBe('completed');
    expect(requestCount).toBe(MAX_STEPS);
  });
});
