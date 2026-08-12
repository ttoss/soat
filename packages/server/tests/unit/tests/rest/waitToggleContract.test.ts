import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';

/**
 * The sync/async toggle is `wait`, it defaults to background, and `wait: true`
 * blocks — everywhere (`.claude/rules/sync-async.md`, and the reference page at
 * `docs/advanced/sync-and-async.md`).
 *
 * This is a static check on the specs rather than a per-route integration test
 * because the failure it guards is a *convention* drift, not a broken route: a
 * new endpoint that spells the toggle `async`, defaults to blocking, or omits
 * the `202` its callers poll on would pass its own tests perfectly while
 * splitting the contract again. #965 unified four surfaces that had drifted
 * exactly that way, each of them individually green.
 *
 * The specs are the single source of truth for REST, the SDK, the CLI and the
 * MCP tool surface, so checking them covers every generated client at once.
 */

const SPEC_DIR = join(__dirname, '../../../../src/rest/openapi/v1');

type ParameterSpec = {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: { type?: string; default?: unknown };
};

type OperationSpec = {
  operationId?: string;
  parameters?: ParameterSpec[];
  requestBody?: {
    content?: {
      'application/json'?: {
        schema?: {
          required?: string[];
          properties?: Record<string, { type?: string; default?: unknown }>;
        };
      };
    };
  };
  responses?: Record<string, unknown>;
};

type SpecDocument = {
  paths?: Record<string, Record<string, OperationSpec>>;
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

type WaitOperation = {
  label: string;
  location: 'query' | 'body';
  required: boolean;
  defaultValue: unknown;
  responses: string[];
};

/** Every operation across the v1 specs, flattened to (label, operation). */
const allOperations = (): Array<{
  label: string;
  operation: OperationSpec;
}> => {
  const operations: Array<{ label: string; operation: OperationSpec }> = [];

  for (const file of readdirSync(SPEC_DIR).filter((name) => {
    return name.endsWith('.yaml');
  })) {
    const doc = parseYaml(
      readFileSync(join(SPEC_DIR, file), 'utf-8')
    ) as SpecDocument;

    for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        operations.push({
          label: `${method.toUpperCase()} ${path} (${file})`,
          operation,
        });
      }
    }
  }

  return operations;
};

/** The operations that expose the toggle, with where and how they declare it. */
const waitOperations = (): WaitOperation[] => {
  const found: WaitOperation[] = [];

  for (const { label, operation } of allOperations()) {
    const responses = Object.keys(operation.responses ?? {});

    const queryParam = (operation.parameters ?? []).find((param) => {
      return param.name === 'wait' && param.in === 'query';
    });
    if (queryParam) {
      found.push({
        label,
        location: 'query',
        required: queryParam.required === true,
        defaultValue: queryParam.schema?.default,
        responses,
      });
      continue;
    }

    const bodySchema =
      operation.requestBody?.content?.['application/json']?.schema;
    const bodyProperty = bodySchema?.properties?.wait;
    if (bodyProperty) {
      found.push({
        label,
        location: 'body',
        required: (bodySchema?.required ?? []).includes('wait'),
        defaultValue: bodyProperty.default,
        responses,
      });
    }
  }

  return found;
};

describe('wait toggle contract', () => {
  test('no operation declares the retired `async` toggle', () => {
    const offenders = allOperations()
      .filter(({ operation }) => {
        const asQuery = (operation.parameters ?? []).some((param) => {
          return param.name === 'async';
        });
        const asBody = Boolean(
          operation.requestBody?.content?.['application/json']?.schema
            ?.properties?.async
        );
        return asQuery || asBody;
      })
      .map(({ label }) => {
        return label;
      });

    expect(offenders).toEqual([]);
  });

  test('the toggle is exposed by the endpoints that have long-running work', () => {
    // A guard on the guard: if this drops to zero the checks below would pass
    // vacuously, which is exactly how a convention test rots into a no-op.
    expect(waitOperations().length).toBeGreaterThanOrEqual(6);
  });

  test('every `wait` defaults to background and is never required', () => {
    for (const operation of waitOperations()) {
      // `required: true` would force callers to state a mode, which is what
      // Phase 1 evaluations did before it could adopt the platform default.
      expect({
        label: operation.label,
        required: operation.required,
        default: operation.defaultValue,
      }).toEqual({
        label: operation.label,
        required: false,
        default: false,
      });
    }
  });

  test('a query-param `wait` endpoint declares the 202 its callers poll on', () => {
    // The two families differ deliberately, and the difference is documented in
    // `docs/advanced/sync-and-async.md#status-codes`: an endpoint doing work on
    // an existing resource answers `202 Accepted`, while a run-creating
    // endpoint answers `201 Created` in both modes and reports the mode in the
    // run's own `status`. Query-param vs body-field is what separates them.
    for (const operation of waitOperations()) {
      const expectation =
        operation.location === 'query'
          ? { label: operation.label, declares202: true }
          : { label: operation.label, declares202: false };

      expect({
        label: operation.label,
        declares202: operation.responses.includes('202'),
      }).toEqual(expectation);
    }
  });
});
