import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { createGenerationRecord } from 'src/lib/generations';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Reading a generation back as a transcript (#1021).
 *
 * The generations under test are **real**: the agent's AI provider points at a
 * local OpenAI-compatible stub, so the whole path runs and the steps object on
 * disk is written by `ai@7` itself. That is the point of testing here rather
 * than only against fixtures — the projection's job is to read what that
 * package actually serializes, and a hand-made fixture cannot prove it does.
 */
describe('GET /api/v1/generations/:generation_id/transcript', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let noTraceToken: string;
  let projectId: string;
  let agentId: string;
  let toolAgentId: string;
  let zeroRetentionAgentId: string;
  let stubServer: Server;

  /** Queued completions; the last one repeats once the queue drains. */
  let stubResponses: Record<string, unknown>[];

  const ASSISTANT_TEXT = "It's 18°C in Paris right now.";
  const USER_QUESTION = "What's the weather in Paris?";

  const textCompletion = (content: string) => {
    return {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 412, completion_tokens: 22, total_tokens: 434 },
    };
  };

  const toolCallCompletion = () => {
    return {
      id: 'chatcmpl-stub-tool',
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
                id: 'call_stub_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"cityName":"Paris"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 412, completion_tokens: 22, total_tokens: 434 },
    };
  };

  /**
   * Serves both roles the turn needs: the chat completions endpoint, and the
   * HTTP tool the agent calls. The tool answers a fixed payload so the
   * projected `result` is assertable.
   */
  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url?.includes('/weather')) {
          res.end(JSON.stringify({ tempC: 18 }));
          return;
        }
        const next =
          stubResponses.length > 1
            ? (stubResponses.shift() as Record<string, unknown>)
            : stubResponses[0];
        res.end(JSON.stringify(next));
      });
    });

    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const runGeneration = async (args: {
    agentId?: string;
    content?: string;
    traceId?: string;
  }): Promise<Record<string, string>> => {
    const res = await asUser()
      .post(`/api/v1/agents/${args.agentId ?? agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: args.content ?? USER_QUESTION }],
        ...(args.traceId ? { trace_id: args.traceId } : {}),
      });
    expect(res.status).toBe(200);
    return res.body;
  };

  const transcript = (generationId: string, token: string = userToken) => {
    return authenticatedTestClient(token).get(
      `/api/v1/generations/${generationId}/transcript`
    );
  };

  beforeAll(async () => {
    stubResponses = [textCompletion(ASSISTANT_TEXT)];
    const stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'transcript',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'generations:GetGeneration',
        'generations:PurgeGenerationContent',
        'traces:GetTrace',
        'tools:CreateTool',
      ],
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Transcript Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });

    const agentRes = await asUser().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: providerRes.body.id,
      name: 'Transcript Agent',
      instructions: 'Answer weather questions.',
    });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    const zeroRes = await asUser().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: providerRes.body.id,
      name: 'Transcript Zero Retention Agent',
      trace_content_mode: 'none',
    });
    expect(zeroRes.status).toBe(201);
    zeroRetentionAgentId = zeroRes.body.id;

    const toolRes = await asUser()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'get_weather',
        type: 'http',
        description: 'Returns the weather for a city.',
        parameters: {
          type: 'object',
          properties: { cityName: { type: 'string' } },
          required: ['cityName'],
        },
        execute: {
          url: `${stubBaseUrl}/weather`,
          method: 'POST',
        },
      });
    expect(toolRes.status).toBe(201);

    const toolAgentRes = await asUser()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'Transcript Tool Agent',
        tool_bindings: [{ tool_id: toolRes.body.id }],
        max_steps: 3,
      });
    expect(toolAgentRes.status).toBe(201);
    toolAgentId = toolAgentRes.body.id;

    // Can read the generation but not the trace — the pair the route checks
    // separately, and the reason a single action would silently widen.
    noTraceToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'transcriptnotrace',
      actions: ['generations:GetGeneration'],
    });
  });

  afterEach(() => {
    stubResponses = [textCompletion(ASSISTANT_TEXT)];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  test('returns the turn as input, ordered steps, and the final output', async () => {
    const generation = await runGeneration({});

    const res = await transcript(generation.id);

    expect(res.status).toBe(200);
    expect(res.body.generation_id).toBe(generation.id);
    expect(res.body.trace_id).toBe(generation.trace_id);
    expect(res.body.project_id).toBe(projectId);
    expect(res.body.agent_id).toBe(agentId);
    expect(res.body.status).toBe('completed');

    // The caller's messages, exactly as the turn received them.
    expect(res.body.input).toEqual([{ role: 'user', content: USER_QUESTION }]);

    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0]).toMatchObject({
      index: 0,
      text: ASSISTANT_TEXT,
      finish_reason: 'stop',
      tool_calls: [],
      tool_results: [],
    });
    expect(res.body.steps[0].usage).toEqual({
      input_tokens: 412,
      output_tokens: 22,
      total_tokens: 434,
    });

    expect(res.body.output).toEqual({
      content: ASSISTANT_TEXT,
      finish_reason: 'stop',
    });
    expect(res.body.error).toBeNull();
    expect(res.body.content_redacted_at).toBeNull();
  });

  test('projects real tool calls and their results out of the stored steps', async () => {
    // The whole reason this test runs a real turn: these shapes are written by
    // `ai@7`, not by a fixture. `toolCalls` / `toolResults` are prototype
    // getters there, so they never reach disk — a projection reading them would
    // return nothing here while passing against live SDK objects (#1012).
    stubResponses = [toolCallCompletion(), textCompletion(ASSISTANT_TEXT)];
    const generation = await runGeneration({ agentId: toolAgentId });

    const res = await transcript(generation.id);

    expect(res.status).toBe(200);

    const calls = res.body.steps.flatMap((step: { tool_calls: unknown[] }) => {
      return step.tool_calls;
    });
    expect(calls).toEqual([
      {
        id: 'call_stub_1',
        tool_name: 'get_weather',
        args: { cityName: 'Paris' },
      },
    ]);

    const results = res.body.steps.flatMap(
      (step: { tool_results: unknown[] }) => {
        return step.tool_results;
      }
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tool_call_id: 'call_stub_1',
      tool_name: 'get_weather',
      error: null,
    });
    // The tool's payload, verbatim — a tool-owned value, never rewritten.
    expect(results[0].result).toMatchObject({ tempC: 18 });

    // The turn still ends on the text step, not the tool step.
    expect(res.body.output.content).toBe(ASSISTANT_TEXT);
  });

  test('returns a 200 skeleton for a zero-retention generation', async () => {
    // Never a 404 and never invented content: the erasure must be provable,
    // which is what distinguishes it from a resource that never existed (#836).
    const generation = await runGeneration({ agentId: zeroRetentionAgentId });

    const res = await transcript(generation.id);

    expect(res.status).toBe(200);
    expect(res.body.generation_id).toBe(generation.id);
    expect(res.body.status).toBe('completed');
    expect(res.body.input).toBeNull();
    expect(res.body.steps).toEqual([]);
    expect(res.body.output).toBeNull();
    expect(res.body.content_redacted_at).not.toBeNull();
    expect(res.body.content_redacted_by_principal_type).toBe('system');
    // Distinguishes never-stored from erased-later.
    expect(res.body.content_redacted_by_principal_id).toBe('zero_retention');
  });

  test('returns a 200 skeleton carrying the purging principal', async () => {
    // A generation purge clears the generation's columns but leaves the trace's
    // steps file alone (that is `DELETE /traces/{id}/content`). The turn's
    // answer lives in both, so the transcript must not project the file back —
    // serving erased content in a response that reports it as erased is exactly
    // the gap #835/#836 closed.
    const generation = await runGeneration({});

    const purge = await asUser().delete(
      `/api/v1/generations/${generation.id}/content`
    );
    expect(purge.status).toBe(200);

    const res = await transcript(generation.id);

    expect(res.status).toBe(200);
    expect(res.body.input).toBeNull();
    expect(res.body.steps).toEqual([]);
    expect(res.body.output).toBeNull();
    expect(res.body.content_redacted_at).not.toBeNull();
    // A real principal, not the zero-retention sentinel.
    expect(res.body.content_redacted_by_principal_id).not.toBe(
      'zero_retention'
    );
  });

  test('returns empty steps for a generation still in progress', async () => {
    // The steps object is not written until the run finishes, so an unfinished
    // turn has nothing to project. `status` disambiguates it from erased
    // content, which is why `steps` stays a plain array.
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    const inProgressId = `gen_tsip_${Date.now()}`;
    await createGenerationRecord({
      publicId: inProgressId,
      projectId: project?.id as number,
      agentId,
      traceId: `trc_tsip_${Date.now()}`,
    });

    const res = await transcript(inProgressId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.steps).toEqual([]);
    expect(res.body.output).toBeNull();
    // Not erased — the run simply has not produced steps yet.
    expect(res.body.content_redacted_at).toBeNull();
  });

  test('unauthenticated request returns 401', async () => {
    const res = await testClient.get(
      '/api/v1/generations/gen_whatever/transcript'
    );
    expect(res.status).toBe(401);
  });

  test('a user without generations:GetGeneration gets 403', async () => {
    const generation = await runGeneration({});
    const res = await transcript(generation.id, noPermToken);
    expect(res.status).toBe(403);
  });

  test('a user who can read the generation but not the trace gets 403', async () => {
    // The dual check, and the reason it exists: the response merges trace
    // content into a generations read, so `generations:GetGeneration` alone must
    // not reach it.
    const generation = await runGeneration({});
    const res = await transcript(generation.id, noTraceToken);
    expect(res.status).toBe(403);
  });

  test('is scoped to its own generation when a trace_id is grouped', async () => {
    // Grouping appends (#1024), so one steps object holds both turns
    // concatenated. Each transcript must return only its own segment —
    // projecting the whole object would report the other turn's steps here, and
    // step_count, which counts every grouped turn, would agree with it.
    const first = await runGeneration({});
    const firstBefore = await transcript(first.id);
    expect(firstBefore.status).toBe(200);
    expect(firstBefore.body.steps).toHaveLength(1);
    expect(firstBefore.body.steps[0].text).toBe(ASSISTANT_TEXT);

    const SECOND_TEXT = 'Grouped onto the same trace.';
    stubResponses = [textCompletion(SECOND_TEXT)];
    const second = await asUser()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({
        trace_id: first.trace_id,
        messages: [{ role: 'user', content: 'And now?' }],
      });
    expect(second.status).toBe(200);
    expect(second.body.trace_id).toBe(first.trace_id);

    const firstAfter = await transcript(first.id);
    expect(firstAfter.status).toBe(200);
    expect(firstAfter.body.steps).toHaveLength(1);
    expect(firstAfter.body.steps[0].text).toBe(ASSISTANT_TEXT);
    expect(firstAfter.body.output.content).toBe(ASSISTANT_TEXT);

    const secondTranscript = await transcript(second.body.id);
    expect(secondTranscript.status).toBe(200);
    expect(secondTranscript.body.steps).toHaveLength(1);
    expect(secondTranscript.body.steps[0].text).toBe(SECOND_TEXT);

    // step_count is turn-scoped too: it agrees with this transcript's own step
    // list, while the trace's counter is what spans both turns.
    expect(firstAfter.body.step_count).toBe(1);
    expect(secondTranscript.body.step_count).toBe(1);
    expect(firstAfter.body.trace_id).toBe(secondTranscript.body.trace_id);

    const traceRes = await asUser().get(`/api/v1/traces/${first.trace_id}`);
    expect(traceRes.status).toBe(200);
    expect(traceRes.body.step_count).toBe(2);
  });

  test('an unknown generation returns 404', async () => {
    const res = await transcript('gen_does_not_exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('GENERATION_NOT_FOUND');
  });
});
