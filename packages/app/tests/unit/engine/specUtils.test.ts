import { describe, expect, test } from 'vitest';

import {
  actionLabel,
  buildUrl,
  extractItems,
  extractPathParams,
  formatValue,
  getIdParamName,
  humanizeKey,
  isSensitiveKey,
  parseModules,
  resolveSchema,
} from '@/engine/specUtils';
import type { ModuleInfo, ModuleOp, OpenApiSpec } from '@/engine/types';

import { testSpec } from '../fixtures/spec';

const byTag = (modules: ModuleInfo[], tag: string): ModuleInfo => {
  const m = modules.find((x) => x.tag === tag);
  if (!m) throw new Error(`module ${tag} not found`);
  return m;
};

describe('buildUrl', () => {
  test('substitutes and encodes path params', () => {
    expect(
      buildUrl('/api/v1/agents/{agent_id}', { agent_id: 'a b/c' })
    ).toBe('/api/v1/agents/a%20b%2Fc');
  });

  test('leaves the template untouched when no params match', () => {
    expect(buildUrl('/api/v1/agents', {})).toBe('/api/v1/agents');
  });
});

describe('humanizeKey', () => {
  test('replaces underscores and title-cases', () => {
    expect(humanizeKey('created_at')).toBe('Created At');
    expect(humanizeKey('name')).toBe('Name');
  });
});

describe('extractPathParams', () => {
  test('returns every brace-delimited name in order', () => {
    expect(
      extractPathParams('/api/v1/projects/{project_id}/webhooks/{id}')
    ).toEqual(['project_id', 'id']);
  });

  test('returns empty array for a static path', () => {
    expect(extractPathParams('/api/v1/agents')).toEqual([]);
  });
});

describe('actionLabel', () => {
  test('humanizes the last path segment', () => {
    const op: ModuleOp = {
      method: 'post',
      pathTemplate: '/api/v1/agents/{agent_id}/generate',
      operation: { operationId: 'generateAgent' },
    };
    expect(actionLabel(op)).toBe('Generate');
  });
});

describe('parseModules', () => {
  const modules = parseModules(testSpec);

  test('classifies CRUD operations onto the Agents module', () => {
    const agents = byTag(modules, 'Agents');
    expect(agents.label).toBe('Agents');
    expect(agents.listOp?.operation.operationId).toBe('listAgents');
    expect(agents.getOp?.operation.operationId).toBe('getAgent');
    expect(agents.createOp?.operation.operationId).toBe('createAgent');
    expect(agents.updateOp?.operation.operationId).toBe('updateAgent');
    expect(agents.deleteOp?.operation.operationId).toBe('deleteAgent');
  });

  test('treats item-scoped POST as an action, not a create', () => {
    const agents = byTag(modules, 'Agents');
    expect(agents.actions).toHaveLength(1);
    expect(agents.actions?.[0].operation.operationId).toBe('generateAgent');
  });

  test('marks a module project-scoped when its paths include {project_id}', () => {
    expect(byTag(modules, 'Webhooks').isProjectScoped).toBe(true);
    expect(byTag(modules, 'Agents').isProjectScoped).toBe(false);
  });

  test('a nested collection POST is the create for its own module', () => {
    const webhooks = byTag(modules, 'Webhooks');
    expect(webhooks.createOp?.operation.operationId).toBe('createWebhook');
    expect(webhooks.actions).toBeUndefined();
  });

  test('skips operations without an operationId and skipped tags', () => {
    const spec: OpenApiSpec = {
      paths: {
        '/api/v1/sessions': {
          get: { operationId: 'listSessions', tags: ['Sessions'] },
        },
        '/api/v1/noid': {
          // @ts-expect-error intentionally missing operationId
          get: { tags: ['Other'] },
        },
      },
    };
    expect(parseModules(spec)).toHaveLength(0);
  });

  test('falls back to the "Other" tag when none is given', () => {
    const spec: OpenApiSpec = {
      paths: { '/api/v1/x': { get: { operationId: 'getX' } } },
    };
    expect(parseModules(spec)[0].tag).toBe('Other');
  });
});

describe('getIdParamName', () => {
  test('returns the extra brace param present on the get path', () => {
    expect(
      getIdParamName('/api/v1/agents/{agent_id}', '/api/v1/agents')
    ).toBe('agent_id');
  });

  test('defaults to "id" when no extra segment is found', () => {
    expect(getIdParamName('/api/v1/agents', '/api/v1/agents')).toBe('id');
  });
});

describe('resolveSchema', () => {
  test('dereferences a local $ref', () => {
    const resolved = resolveSchema(
      { $ref: '#/components/schemas/CreateAgent' },
      testSpec
    );
    expect(resolved?.required).toContain('name');
  });

  test('returns the schema unchanged when there is no $ref', () => {
    const schema = { type: 'string' };
    expect(resolveSchema(schema, testSpec)).toBe(schema);
  });

  test('returns undefined for a missing schema', () => {
    expect(resolveSchema(undefined, testSpec)).toBeUndefined();
  });

  test('returns undefined for an unresolvable $ref', () => {
    expect(
      resolveSchema({ $ref: '#/components/schemas/Nope' }, testSpec)
    ).toBeUndefined();
  });
});

describe('extractItems', () => {
  test('returns an array body directly, filtering non-objects', () => {
    expect(extractItems([{ id: '1' }, 'x', null])).toEqual([{ id: '1' }]);
  });

  test('finds the first array value in an object body', () => {
    expect(extractItems({ items: [{ id: '1' }], total: 1 })).toEqual([
      { id: '1' },
    ]);
  });

  test('returns empty array when no list is present', () => {
    expect(extractItems({ id: '1' })).toEqual([]);
    expect(extractItems('nope')).toEqual([]);
  });
});

describe('isSensitiveKey', () => {
  test.each(['secret', 'api_key', 'password', 'access_token'])(
    'flags %s as sensitive',
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    }
  );

  test('does not flag ordinary keys', () => {
    expect(isSensitiveKey('name')).toBe(false);
  });
});

describe('formatValue', () => {
  test('renders null/undefined as empty string', () => {
    expect(formatValue('x', null)).toBe('');
  });

  test('renders booleans as Yes/No', () => {
    expect(formatValue('enabled', true)).toBe('Yes');
    expect(formatValue('enabled', false)).toBe('No');
  });

  test('pretty-prints objects', () => {
    expect(formatValue('meta', { a: 1 })).toBe('{\n  "a": 1\n}');
  });

  test('formats date-like keys as locale strings', () => {
    const out = formatValue('created_at', '2024-01-01T00:00:00.000Z');
    expect(out).not.toBe('2024-01-01T00:00:00.000Z');
    expect(out.length).toBeGreaterThan(0);
  });

  test('stringifies plain values', () => {
    expect(formatValue('count', 42)).toBe('42');
  });
});
