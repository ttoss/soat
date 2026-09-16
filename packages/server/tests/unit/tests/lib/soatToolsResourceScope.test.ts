import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';
import { listResourceKinds } from 'src/lib/resourceScopes';
import { soatTools } from 'src/lib/soatTools';

/**
 * `x-soat-resource` is what lets an agent's `boundary_policy` be evaluated
 * against the resource a builtin call names rather than against `*` (#1323).
 * An operation that grows a path parameter and no annotation is not an
 * oversight anyone would notice at runtime — the check simply keeps answering
 * about `*` — so the annotation is enforced here per spec file.
 *
 * A spec file is either annotated (every operation that names a resource
 * declares one) or listed below with the reason it is not. Adding a module to
 * the list is a decision a reviewer sees; forgetting one is a failing test.
 */
const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

/**
 * Modules whose operations are still evaluated against `*`. The list only
 * shrinks: each entry is a module whose route authorization has to be read
 * before its operations can be annotated, because the annotation must mirror
 * the `isAllowed` call the route already makes.
 *
 * `agents.yaml` is here for a different reason and does not shrink the same
 * way: `GET /agents/{agent_id}` narrows by `resolveProjectIds` and checks no
 * SRN, so scoping the boundary there would promise a granularity the caller
 * path does not enforce. That is a route change first.
 */
const UNSCOPED_SPECS = [
  'activity.yaml',
  'agents.yaml',
  'ai-providers.yaml',
  'api-keys.yaml',
  'approvals.yaml',
  'audit-log.yaml',
  'chains.yaml',
  'chats.yaml',
  'documents.yaml',
  'embeddings.yaml',
  'evaluations.yaml',
  'exceptions.yaml',
  'files.yaml',
  'formations.yaml',
  'generations.yaml',
  'guardrails.yaml',
  'ingestion-rules.yaml',
  'knowledge.yaml',
  'memory-assertions.yaml',
  'model-routes.yaml',
  'oauth.yaml',
  'orchestrations.yaml',
  'policies.yaml',
  'projects.yaml',
  'quotas.yaml',
  'secrets.yaml',
  'tags.yaml',
  'tasks.yaml',
  'tools.yaml',
  'traces.yaml',
  'triggers.yaml',
  'usage-totals.yaml',
  'usage.yaml',
  'users.yaml',
  'webhooks.yaml',
  'workflows.yaml',
];

type Operation = {
  operationId?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  'x-soat-resource'?: { kind?: string; from?: string };
};

const readSpec = (file: string): Record<string, unknown> => {
  return load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf-8')) as Record<
    string,
    unknown
  >;
};

const specFiles = (): string[] => {
  return fs
    .readdirSync(SPEC_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();
};

/** Resolves a `$ref` parameter against the spec's own components. */
const resolveParameter = (
  param: unknown,
  spec: Record<string, unknown>
): Record<string, unknown> => {
  if (!param || typeof param !== 'object') return {};
  const ref = (param as { $ref?: string }).$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/components/parameters/')) {
    return param as Record<string, unknown>;
  }
  const name = ref.replace('#/components/parameters/', '');
  const components = (spec.components ?? {}) as {
    parameters?: Record<string, unknown>;
  };
  return (components.parameters?.[name] ?? {}) as Record<string, unknown>;
};

const pathParamNames = (args: {
  operation: Operation;
  pathItem: Record<string, unknown>;
  spec: Record<string, unknown>;
}): string[] => {
  const declared = [
    ...((args.pathItem.parameters as unknown[]) ?? []),
    ...(args.operation.parameters ?? []),
  ];
  return declared
    .map((p) => {
      return resolveParameter(p, args.spec);
    })
    .filter((p) => {
      return p.in === 'path' && typeof p.name === 'string';
    })
    .map((p) => {
      return p.name as string;
    });
};

const bodyPropertyNames = (operation: Operation): string[] => {
  const requestBody = (operation.requestBody ?? {}) as {
    content?: { 'application/json'?: { schema?: { properties?: object } } };
  };
  const properties =
    requestBody.content?.['application/json']?.schema?.properties;
  return properties ? Object.keys(properties) : [];
};

type SpecOperation = {
  file: string;
  operationId: string;
  operation: Operation;
  pathParams: string[];
  bodyProps: string[];
};

const allOperations = (): SpecOperation[] => {
  const operations: SpecOperation[] = [];
  for (const file of specFiles()) {
    const spec = readSpec(file);
    const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
    for (const pathItem of Object.values(paths)) {
      for (const [method, value] of Object.entries(pathItem)) {
        if (method === 'parameters') continue;
        const operation = value as Operation;
        if (!operation?.operationId) continue;
        operations.push({
          file,
          operationId: operation.operationId,
          operation,
          pathParams: pathParamNames({ operation, pathItem, spec }),
          bodyProps: bodyPropertyNames(operation),
        });
      }
    }
  }
  return operations;
};

/**
 * An operation "names a resource" when a path parameter carries a public id.
 * A listing or a create takes none, and is `*` by the same rule that makes it
 * project-scoped.
 */
const namesAResource = (operation: SpecOperation): boolean => {
  return operation.pathParams.some((name) => {
    return name.endsWith('_id');
  });
};

describe('x-soat-resource covers the operations that name a resource', () => {
  const operations = allOperations();

  test('the exemption list names only real, still-unannotated specs', () => {
    const files = new Set(specFiles());
    for (const file of UNSCOPED_SPECS) {
      expect(files.has(file)).toBe(true);
    }
    const annotated = new Set(
      operations
        .filter((operation) => {
          return operation.operation['x-soat-resource'];
        })
        .map((operation) => {
          return operation.file;
        })
    );
    for (const file of UNSCOPED_SPECS) {
      expect(annotated.has(file)).toBe(false);
    }
  });

  test('every resource-naming operation in an annotated spec declares one', () => {
    const missing = operations
      .filter((operation) => {
        return (
          !UNSCOPED_SPECS.includes(operation.file) &&
          namesAResource(operation) &&
          !operation.operation['x-soat-resource']
        );
      })
      .map((operation) => {
        return `${operation.file}:${operation.operationId}`;
      });

    expect(missing).toEqual([]);
  });

  test('every declared ref names an argument the operation accepts', () => {
    for (const operation of operations) {
      const ref = operation.operation['x-soat-resource'];
      if (!ref) continue;
      const accepted = [...operation.pathParams, ...operation.bodyProps];
      expect({
        operationId: operation.operationId,
        from: ref.from,
        accepted: accepted.includes(ref.from as string),
      }).toEqual({
        operationId: operation.operationId,
        from: ref.from,
        accepted: true,
      });
    }
  });

  test('every declared kind has a scope resolver', () => {
    const kinds = new Set(listResourceKinds());
    for (const operation of operations) {
      const ref = operation.operation['x-soat-resource'];
      if (!ref) continue;
      expect({ operationId: operation.operationId, kind: ref.kind }).toEqual({
        operationId: operation.operationId,
        kind: expect.stringMatching(new RegExp(`^(${[...kinds].join('|')})$`)),
      });
    }
  });

  test('the derived catalog carries the annotation through', () => {
    const getMemoryStore = soatTools.find((tool) => {
      return tool.name === 'get-memory-store';
    });
    expect(getMemoryStore?.resource).toEqual({
      kind: 'memory_store',
      from: 'memory_store_id',
    });

    // A listing names no resource, so it carries none rather than an empty ref.
    const listMemoryStores = soatTools.find((tool) => {
      return tool.name === 'list-memory-stores';
    });
    expect(listMemoryStores?.resource).toBeUndefined();
  });
});
