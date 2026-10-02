import * as fs from 'node:fs';
import * as path from 'node:path';

import { App, bodyParser } from '@ttoss/http-server';
import {
  createMcpRouter,
  McpServer,
  registerTools,
} from '@ttoss/http-server-mcp';
import { load } from 'js-yaml';
import { mcpOperationTools } from 'src/mcp/server';
import request from 'supertest';

/**
 * Validation must never refuse what the API takes. The MCP surface checks every
 * argument against its operation's full schema before the call, so a schema no
 * value can satisfy — overlapping `oneOf` alternatives, a required field a
 * caller cannot send — would refuse every call to its tool. These run each
 * tool, its handler stubbed, through the same validator production uses.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

type Schema = {
  const?: unknown;
  enum?: unknown[];
  default?: unknown;
  oneOf?: Schema[];
  anyOf?: Schema[];
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minItems?: number;
  minimum?: number;
  minLength?: number;
  pattern?: string;
  format?: string;
};

type CallResult = {
  isError?: boolean;
  content?: Array<{ text?: string }>;
};

const app = (() => {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools({
    server,
    tools: mcpOperationTools.map((tool) => {
      return {
        ...tool,
        handler: async () => {
          return { content: [{ type: 'text' as const, text: 'reached' }] };
        },
      };
    }),
  });
  const koa = new App();
  koa.use(bodyParser());
  koa.use(createMcpRouter(server).routes());
  return koa.callback();
})();

const call = async (args: {
  name: string;
  arguments: Record<string, unknown>;
}): Promise<CallResult> => {
  const response = await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: args,
    });
  return response.body.result;
};

const SAMPLE_STRINGS: Record<string, string> = {
  email: 'caller@example.com',
  'date-time': '2026-01-01T00:00:00Z',
  uri: 'https://example.com',
};

/** The most alternatives any `oneOf` / `anyOf` in the schema offers. */
const alternativesIn = (schema: Schema | undefined): number => {
  if (!schema) return 0;
  const own = (schema.oneOf ?? schema.anyOf ?? []).length;
  const children = [
    ...(schema.oneOf ?? []),
    ...(schema.anyOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
  ];
  return Math.max(own, ...children.map(alternativesIn));
};

/** The value a schema pins with `const`, `enum` or `default`, if any. */
const pinnedValue = (schema: Schema): { value: unknown } | undefined => {
  if ('const' in schema) return { value: schema.const };
  if (Array.isArray(schema.enum)) {
    return {
      value: schema.enum.find((value) => {
        return value !== null;
      }),
    };
  }
  return schema.default === undefined ? undefined : { value: schema.default };
};

/** A sample of a schema with no alternatives, properties or items. */
const scalarSample = (schema: Schema, type: string | undefined): unknown => {
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return true;
  if (schema.pattern) {
    throw new Error(`No sample for pattern ${schema.pattern}`);
  }
  return (
    (schema.format && SAMPLE_STRINGS[schema.format]) ??
    'x'.repeat(schema.minLength ?? 1)
  );
};

/**
 * The smallest arguments a schema accepts, taking alternative `choice` of
 * every `oneOf` / `anyOf`. Optional fields and array items are included only
 * where they hold alternatives, so every alternative is reached.
 */
const minimalArgs = (schema: Schema | undefined, choice: number): unknown => {
  if (!schema) return 'x';
  const pinned = pinnedValue(schema);
  if (pinned) return pinned.value;
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    return minimalArgs(
      alternatives[Math.min(choice, alternatives.length - 1)],
      choice
    );
  }
  const type = [schema.type].flat().find((candidate) => {
    return candidate !== 'null';
  });
  if (type === 'object' || (type === undefined && schema.properties)) {
    const required = new Set(schema.required ?? []);
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key, property]) => {
          return required.has(key) || alternativesIn(property) > 0;
        })
        .map(([key, property]) => {
          return [key, minimalArgs(property, choice)];
        })
    );
  }
  if (type === 'array') {
    const length = Math.max(
      schema.minItems ?? 0,
      alternativesIn(schema.items) > 0 ? 1 : 0
    );
    return Array.from({ length }, () => {
      return minimalArgs(schema.items, choice);
    });
  }
  return scalarSample(schema, type);
};

type Operation = {
  operationId?: string;
  requestBody?: {
    content?: Record<
      string,
      { example?: unknown; examples?: Record<string, { value?: unknown }> }
    >;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** Each request body a spec documents as an example, by operationId. */
const documentedBodies = (): Array<{ operationId: string; body: unknown }> => {
  return fs
    .readdirSync(SPEC_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .flatMap((file) => {
      const spec = load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8'));
      const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
      return Object.values(paths)
        .filter(isRecord)
        .flatMap((item) => {
          return Object.values(item).filter(isRecord) as Operation[];
        });
    })
    .flatMap((operation) => {
      const json = operation.requestBody?.content?.['application/json'];
      if (!operation.operationId || !json) return [];
      return [
        ...(json.example ? [json.example] : []),
        ...Object.values(json.examples ?? {}).map((example) => {
          return example.value;
        }),
      ].map((body) => {
        return { operationId: operation.operationId as string, body };
      });
    });
};

const toolFor = (operationId: string) => {
  const kebab = operationId.replace(/([A-Z])/g, '-$1').toLowerCase();
  return mcpOperationTools.find((tool) => {
    return tool.name === kebab;
  });
};

describe('MCP tool arguments', () => {
  test('are refused before the API when the schema refuses them', async () => {
    for (const limit of [101, 1.5]) {
      const result = await call({ name: 'list-tools', arguments: { limit } });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain('limit');
    }

    const missing = await call({ name: 'get-agent', arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content?.[0]?.text).toContain('agent_id');
  });

  test('accept the minimal arguments of every tool, each alternative once', async () => {
    const refused: string[] = [];
    for (const tool of mcpOperationTools) {
      const schema = tool.inputSchema as Schema;
      const choices = Math.max(1, alternativesIn(schema));
      for (let choice = 0; choice < choices; choice += 1) {
        const result = await call({
          name: tool.name,
          arguments: minimalArgs(schema, choice) as Record<string, unknown>,
        });
        if (result.isError) {
          refused.push(`${tool.name}: ${result.content?.[0]?.text}`);
          break;
        }
      }
    }
    expect(mcpOperationTools.length).toBeGreaterThan(300);
    expect(refused).toEqual([]);
  }, 60_000);

  test('accept every request body the specs document as an example', async () => {
    const refused: string[] = [];
    let checked = 0;
    for (const { operationId, body } of documentedBodies()) {
      const tool = toolFor(operationId);
      if (!tool || !isRecord(body)) continue;
      const pathArgs = Object.fromEntries(
        (
          (tool.inputSchema as Schema).required?.filter((key) => {
            return !(key in body);
          }) ?? []
        ).map((key) => {
          return [key, 'id_x'];
        })
      );
      checked += 1;
      const result = await call({
        name: tool.name,
        arguments: { ...pathArgs, ...body },
      });
      if (result.isError) {
        refused.push(`${tool.name}: ${result.content?.[0]?.text}`);
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(refused).toEqual([]);
  });
});
