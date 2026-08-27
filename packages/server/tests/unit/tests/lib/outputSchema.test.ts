import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Tool } from 'ai';
import { jsonSchema, tool } from 'ai';
import { db } from 'src/db';
import { buildModel } from 'src/lib/agentModel';
import { runNonStreamGeneration } from 'src/lib/agentNonStreamGeneration';
import {
  buildStructuredOutput,
  validateStructuredOutput,
} from 'src/lib/outputSchema';

// A pure algorithm over every JSON Schema keyword an author may write. Reaching
// one keyword through a generation would need a full fixture chain per case, and
// the bare 502 would hide which keyword fired.
describe('validateStructuredOutput', () => {
  const themeSchema = {
    type: 'object',
    required: ['approved', 'reason', 'title', 'text'],
    properties: {
      text: { type: 'string', minLength: 200 },
      title: { type: 'string', minLength: 3 },
      reason: { type: 'string', minLength: 10 },
      approved: { type: 'boolean' },
    },
  };

  test('accepts an object that satisfies the schema', () => {
    const value = {
      text: 'a'.repeat(200),
      title: 'A casa arrumada para a visita',
      approved: true,
      reason: 'Apenas expõe o mecanismo, sem instalar outra ilusão.',
    };
    const result = validateStructuredOutput(themeSchema)(value);
    expect(result.success).toBe(true);
    expect(result.success && result.value).toEqual(value);
  });

  // The regression this module exists for: a model returned every required key
  // with every type correct, filled with the name of the agent's own tool. A
  // required+type-only check passes that; `minLength` is what rejects it.
  test('rejects a degenerate object whose keys and types are all correct', () => {
    const result = validateStructuredOutput(themeSchema)({
      text: 'get-fundamental-truth',
      title: 'get-fundamental-truth',
      reason: 'get-fundamental-truth',
      approved: true,
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toMatch(/text/);
  });

  test('rejects a missing required field', () => {
    const result = validateStructuredOutput(themeSchema)({
      text: 'a'.repeat(200),
      title: 'Título',
      approved: true,
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toMatch(/reason/);
  });

  test('rejects a wrong primitive type', () => {
    const result = validateStructuredOutput(themeSchema)({
      text: 'a'.repeat(200),
      title: 'Título',
      reason: 'porque sim, e mais um pouco',
      approved: 'true',
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.message).toMatch(
      /approved/
    );
  });

  test('honors nested object and array constraints', () => {
    const nested = {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'integer', minimum: 1 } },
          },
        },
      },
    };
    expect(
      validateStructuredOutput(nested)({ items: [{ id: 1 }] }).success
    ).toBe(false);
    expect(
      validateStructuredOutput(nested)({ items: [{ id: 1 }, { id: 0 }] })
        .success
    ).toBe(false);
    expect(
      validateStructuredOutput(nested)({ items: [{ id: 1 }, { id: 2 }] })
        .success
    ).toBe(true);
  });

  test('an unknown keyword does not reject an otherwise valid object', () => {
    // Author-written schemas carry vendor keywords the provider understands and
    // ajv does not; those must not fail a value that satisfies the rest.
    const result = validateStructuredOutput({
      type: 'object',
      'x-vendor-hint': 'whatever',
      properties: { a: { type: 'string' } },
    })({ a: 'ok' });
    expect(result.success).toBe(true);
  });

  test('an uncompilable schema accepts everything rather than failing closed', () => {
    // A schema ajv cannot compile is an authoring bug, not a bad generation.
    // Failing every generation on it would turn one bad agent config into an
    // outage; the generation proceeds unvalidated (and logs).
    const result = validateStructuredOutput({
      type: 'object',
      properties: { a: { type: 'not-a-json-schema-type' } },
    })({ anything: true });
    expect(result.success).toBe(true);
  });

  test('buildStructuredOutput returns undefined when no schema is configured', () => {
    expect(buildStructuredOutput(null)).toBeUndefined();
    expect(buildStructuredOutput(undefined)).toBeUndefined();
    expect(buildStructuredOutput('nope')).toBeUndefined();
  });
});

// Proves a generation actually reaches the validator: before the fix, the stub's
// degenerate object completed with `output.object` set and no error anywhere.
describe('output_schema enforcement (stub server)', () => {
  let stubServer: Server;
  let stubBaseUrl: string;
  let requestCount = 0;
  let lastToolCount = 0;
  let projectDbId: number;
  let projectPublicId: string;
  let agentPublicId: string;
  let stubContent = '';

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { tools?: unknown[] };
        requestCount += 1;
        lastToolCount = Array.isArray(body.tools) ? body.tools.length : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-schema',
            object: 'chat.completion',
            created: 0,
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: stubContent },
                finish_reason: 'stop',
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

  const typedAgent = () => {
    return {
      instructions: null,
      model: 'mock-model',
      toolIds: null,
      maxSteps: 3,
      toolChoice: 'auto',
      stopConditions: null,
      activeToolIds: null,
      stepRules: null,
      boundaryPolicy: null,
      temperature: null,
      outputSchema: {
        type: 'object',
        required: ['text', 'approved'],
        properties: {
          text: { type: 'string', minLength: 200 },
          approved: { type: 'boolean' },
        },
      },
      project: { id: projectDbId, publicId: projectPublicId },
      aiProvider: { publicId: 'aip_schema' },
    } as never;
  };

  const run = (generationId: string) => {
    return runNonStreamGeneration({
      model: buildModel({
        provider: 'ollama',
        secretValue: null,
        model: 'mock-model',
        baseUrl: stubBaseUrl,
      }),
      allMessages: [{ role: 'user', content: 'review this' }],
      resolvedTools: {},
      typedAgent: typedAgent(),
      generationId,
      traceId: `trc_${generationId}`,
      agentId: agentPublicId,
    });
  };

  beforeAll(async () => {
    stubBaseUrl = await startStubServer();

    const project = await db.Project.create({ name: 'OutputSchema Project' });
    projectDbId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId: project.id,
      name: 'OutputSchema Provider',
      provider: 'ollama',
      defaultModel: 'mock-model',
      baseUrl: stubBaseUrl,
    });

    const agent = await db.Agent.create({
      projectId: project.id,
      aiProviderId: aiProvider.id,
      name: 'OutputSchema Agent',
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
    lastToolCount = 0;
  });

  test('a degenerate object that violates the schema fails the generation', async () => {
    stubContent = JSON.stringify({
      text: 'get-fundamental-truth',
      approved: true,
    });

    await expect(run('gen_schema_degenerate')).rejects.toMatchObject({
      code: 'OUTPUT_SCHEMA_VALIDATION_FAILED',
    });
  });

  test('an object satisfying the schema completes and is returned', async () => {
    const object = { text: 'a'.repeat(200), approved: true };
    stubContent = JSON.stringify(object);

    const result = await run('gen_schema_ok');

    expect(result.status).toBe('completed');
    expect(result.output?.object).toEqual(object);
  });

  test('a schema violation is not retried without tools', async () => {
    // The no-tools fallback exists for a provider that rejects our tool
    // definitions. A schema violation is the model's output, not the tool
    // surface: retrying without tools would burn a second call and — worse —
    // could complete an answer the agent was required to use a tool to reach.
    stubContent = JSON.stringify({ text: 'too short', approved: true });

    await expect(
      runNonStreamGeneration({
        model: buildModel({
          provider: 'ollama',
          secretValue: null,
          model: 'mock-model',
          baseUrl: stubBaseUrl,
        }),
        allMessages: [{ role: 'user', content: 'review this' }],
        resolvedTools: {
          lookup: tool({
            description: 'a tool the agent is meant to call',
            inputSchema: jsonSchema({ type: 'object', properties: {} }),
          }) as Tool,
        },
        typedAgent: typedAgent(),
        generationId: 'gen_schema_no_retry',
        traceId: 'trc_gen_schema_no_retry',
        agentId: agentPublicId,
      })
    ).rejects.toMatchObject({ code: 'OUTPUT_SCHEMA_VALIDATION_FAILED' });

    expect(requestCount).toBe(1);
    expect(lastToolCount).toBeGreaterThan(0);
  });
});
