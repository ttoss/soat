import { describe, expect, test } from 'vitest';

import { getOpRequestSchema } from '@/engine/formHelpers';
import {
  actionLabel,
  buildListRequestUrl,
  buildRefDescriptor,
  buildUrl,
  extractItems,
  extractPathParams,
  extractRefFields,
  findModuleByResource,
  formatValue,
  getIdParamName,
  getListItemSchema,
  getResponseItemSchema,
  humanizeKey,
  isSensitiveKey,
  opAcceptsProjectIdQuery,
  parseModules,
  resolvableRefFields,
  resolveSchema,
} from '@/engine/specUtils';
import type { ModuleInfo, ModuleOp, OpenApiSpec } from '@/engine/types';

import { testSpec } from '../fixtures/spec';

const byTag = (modules: ModuleInfo[], tag: string): ModuleInfo => {
  const m = modules.find((x) => {
    return x.tag === tag;
  });
  if (!m) throw new Error(`module ${tag} not found`);
  return m;
};

describe('buildUrl', () => {
  test('substitutes and encodes path params', () => {
    expect(buildUrl('/api/v1/agents/{agent_id}', { agent_id: 'a b/c' })).toBe(
      '/api/v1/agents/a%20b%2Fc'
    );
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

  test('a sub-resource PUT becomes an action, not the module updateOp', () => {
    const users = byTag(modules, 'Users');
    // The detail-path PUT is still the edit form…
    expect(users.updateOp?.operation.operationId).toBe('updateUser');
    // …but PUT on a deeper sub-resource path is a standalone action.
    const actionIds = (users.actions ?? []).map((a) => {
      return a.operation.operationId;
    });
    expect(actionIds).toContain('attachUserPolicies');
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

  test('prefers a multipart upload sibling over a plain collection POST as the create op', () => {
    // Mirrors the Files module: POST /files creates a metadata-only record
    // (JSON body, no bytes), while POST /files/upload actually carries file
    // content via a `format: binary` field. The generic form only ever
    // renders a file picker for the operation wired to createOp, so that one
    // must win — otherwise "Create" produces a form with no way to attach a
    // file at all.
    const spec: OpenApiSpec = {
      paths: {
        '/api/v1/files': {
          get: { operationId: 'listFiles', tags: ['Files'] },
          post: {
            operationId: 'createFile',
            tags: ['Files'],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { filename: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
        '/api/v1/files/upload': {
          post: {
            operationId: 'uploadFile',
            tags: ['Files'],
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    required: ['file'],
                    properties: {
                      file: { type: 'string', format: 'binary' },
                      filename: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        '/api/v1/files/upload/base64': {
          post: {
            operationId: 'uploadFileBase64',
            tags: ['Files'],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { content: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const files = byTag(parseModules(spec), 'Files');
    expect(files.createOp?.operation.operationId).toBe('uploadFile');
    const actionIds = (files.actions ?? []).map((a) => {
      return a.operation.operationId;
    });
    expect(actionIds).toContain('createFile');
    expect(actionIds).toContain('uploadFileBase64');
  });

  test('skips operations without an operationId and skipped tags', () => {
    const spec: OpenApiSpec = {
      paths: {
        '/api/v1/generations': {
          get: { operationId: 'listGenerations', tags: ['Generations'] },
        },
        '/api/v1/noid': {
          // @ts-expect-error intentionally missing operationId
          get: { tags: ['Other'] },
        },
      },
    };
    expect(parseModules(spec)).toHaveLength(0);
  });

  test('accepts snake_case operation_id from the server caseTransform middleware', () => {
    const spec = {
      paths: {
        '/api/v1/agents': {
          // @ts-expect-error intentionally using server snake_case shape
          get: { operation_id: 'listAgents', tags: ['Agents'] },
        },
      },
    } as OpenApiSpec;
    const modules = parseModules(spec);
    expect(modules).toHaveLength(1);
    expect(modules[0].listOp?.operation.operationId).toBe('listAgents');
  });

  test('produces correct labels for already-spaced and CamelCase tags', () => {
    const spec = {
      paths: {
        '/api/v1/ai-providers': {
          get: { operationId: 'listAiProviders', tags: ['AI Providers'] },
        },
        '/api/v1/api-keys': {
          get: { operationId: 'listApiKeys', tags: ['API Keys'] },
        },
        '/api/v1/memory-entries': {
          get: { operationId: 'listMemoryEntries', tags: ['MemoryEntries'] },
        },
      },
    } as OpenApiSpec;
    const modules = parseModules(spec);
    const label = (tag: string) => {
      return byTag(modules, tag).label;
    };
    expect(label('AI Providers')).toBe('AI Providers');
    expect(label('API Keys')).toBe('API Keys');
    expect(label('MemoryEntries')).toBe('Memory Entries');
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
    expect(getIdParamName('/api/v1/agents/{agent_id}', '/api/v1/agents')).toBe(
      'agent_id'
    );
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

describe('x-soat-ref cross-references', () => {
  const agents = (): ModuleInfo => {
    return byTag(parseModules(testSpec), 'Agents');
  };
  const projects = (): ModuleInfo => {
    return byTag(parseModules(testSpec), 'Projects');
  };
  const sessions = (): ModuleInfo => {
    return byTag(parseModules(testSpec), 'Sessions');
  };

  test('getResponseItemSchema unwraps an array response to its item schema', () => {
    const schema = getResponseItemSchema(agents().listOp, testSpec);
    expect(schema?.properties?.project_id).toBeDefined();
  });

  test('getResponseItemSchema resolves a single-object response', () => {
    const schema = getResponseItemSchema(agents().getOp, testSpec);
    expect(schema?.properties?.project_id?.['x-soat-ref']).toBe('projects');
  });

  test('extractRefFields maps annotated properties to their resource', () => {
    const schema = getResponseItemSchema(agents().listOp, testSpec);
    expect(extractRefFields(schema, testSpec)).toEqual({
      project_id: 'projects',
      tool_ids: 'tools',
      session_id: 'sessions',
    });
  });

  test('findModuleByResource locates the owning module by resource segment', () => {
    const modules = parseModules(testSpec);
    expect(findModuleByResource(modules, 'projects')?.tag).toBe('Projects');
    expect(findModuleByResource(modules, 'nope')).toBeUndefined();
  });

  test('buildRefDescriptor targets the resource detail view', () => {
    expect(buildRefDescriptor(projects(), 'proj_1')).toEqual({
      tag: 'Projects',
      operationId: 'getProject',
      pathParams: { project_id: 'proj_1' },
      mode: 'detail',
    });
  });

  test('buildRefDescriptor returns null without an id or a detail op', () => {
    expect(buildRefDescriptor(projects(), '')).toBeNull();
    expect(
      buildRefDescriptor({ ...projects(), getOp: undefined }, 'x')
    ).toBeNull();
  });

  test('buildRefDescriptor fills parent params for a nested target from context', () => {
    expect(
      buildRefDescriptor(sessions(), 'ses_1', { agent_id: 'agt_1' })
    ).toEqual({
      tag: 'Sessions',
      operationId: 'getAgentSession',
      pathParams: { agent_id: 'agt_1', session_id: 'ses_1' },
      mode: 'detail',
    });
  });

  test('buildRefDescriptor returns null when a nested parent param is missing', () => {
    expect(buildRefDescriptor(sessions(), 'ses_1')).toBeNull();
    expect(buildRefDescriptor(sessions(), 'ses_1', { other: 'x' })).toBeNull();
  });

  test('resolvableRefFields keeps refs with a detail route and drops the rest', () => {
    const modules = parseModules(testSpec);
    const refs = {
      project_id: 'projects',
      tool_ids: 'tools',
      session_id: 'sessions', // nested, but has a detail route → kept as a candidate
      widget_id: 'widgets', // unknown resource → dropped
    };
    expect(resolvableRefFields(refs, modules)).toEqual({
      project_id: 'projects',
      tool_ids: 'tools',
      session_id: 'sessions',
    });
  });
});

describe('parseModules — snake_cased served spec', () => {
  // The server's caseTransform middleware snake_cases the entire served
  // openapi.json, so structural OpenAPI keys arrive as operation_id and
  // request_body. parseModules must normalise these back to camelCase, or
  // form views report "No form schema available for this operation."
  // Built through JSON.parse to mirror how the spec actually arrives (parsed
  // from the wire) and to carry the off-spec snake_case keys without a cast.
  const snakeSpec: OpenApiSpec = JSON.parse(
    JSON.stringify({
      paths: {
        '/api/v1/projects': {
          get: { operation_id: 'listProjects', tags: ['Projects'] },
          post: {
            operation_id: 'createProject',
            tags: ['Projects'],
            request_body: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: { name: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    })
  );

  test('normalises operation_id and request_body so the create schema resolves', () => {
    const projects = parseModules(snakeSpec).find((m) => {
      return m.tag === 'Projects';
    })!;

    expect(projects.createOp?.operation.operationId).toBe('createProject');
    const schema = getOpRequestSchema(projects.createOp, snakeSpec);
    expect(schema?.properties && Object.keys(schema.properties)).toEqual([
      'name',
    ]);
  });
});

describe('project scoping via query param', () => {
  const agents = (): ModuleInfo => {
    return byTag(parseModules(testSpec), 'Agents');
  };
  const tools = (): ModuleInfo => {
    return byTag(parseModules(testSpec), 'Tools');
  };

  test('opAcceptsProjectIdQuery detects the project_id query parameter', () => {
    expect(opAcceptsProjectIdQuery(agents().listOp)).toBe(true);
    // Tools' list op declares no project_id query param.
    expect(opAcceptsProjectIdQuery(tools().listOp)).toBe(false);
  });

  test('buildListRequestUrl scopes to the project when the op supports it', () => {
    expect(buildListRequestUrl(agents().listOp!, {}, 'prj_1')).toBe(
      '/api/v1/agents?project_id=prj_1'
    );
  });

  test('buildListRequestUrl omits project_id when none is active', () => {
    expect(buildListRequestUrl(agents().listOp!, {}, null)).toBe(
      '/api/v1/agents'
    );
  });

  test('buildListRequestUrl never scopes an op that lacks the query param', () => {
    expect(buildListRequestUrl(tools().listOp!, {}, 'prj_1')).toBe(
      '/api/v1/tools'
    );
  });
});

describe('getListItemSchema — record from list responses', () => {
  test('unwraps a paginated wrapper object to the record (so refs link)', () => {
    const spec: OpenApiSpec = JSON.parse(
      JSON.stringify({
        paths: {
          '/api/v1/actors': {
            get: {
              operationId: 'listActors',
              tags: ['Actors'],
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          actors: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/ActorRecord' },
                          },
                          total: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            ActorRecord: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                project_id: { type: 'string', 'x-soat-ref': 'projects' },
              },
            },
          },
        },
      })
    );
    const actors = parseModules(spec).find((m) => {
      return m.tag === 'Actors';
    })!;
    const item = getListItemSchema(actors.listOp, spec);

    expect(item?.properties && Object.keys(item.properties)).toEqual([
      'id',
      'project_id',
    ]);
    // The x-soat-ref is now reachable, so the field becomes linkable.
    expect(extractRefFields(item, spec)).toEqual({ project_id: 'projects' });
  });

  test('a bare-array list returns the record, not an inner array field', () => {
    // testSpec Agents is a bare array of Agent; the record must be returned as
    // a whole (its own array fields must not be mistaken for the list).
    const agents = byTag(parseModules(testSpec), 'Agents');
    const item = getListItemSchema(agents.listOp, testSpec);
    expect(item?.properties?.name).toBeDefined();
  });
});

describe('resolveSchema — snake_cased component keys (served spec)', () => {
  test('resolves a $ref whose component key was snake_cased by the server', () => {
    // The caseTransform middleware snake_cases component KEYS (ActorRecord ->
    // _actor_record) but leaves $ref strings CamelCase. Resolution must still
    // find the record so its x-soat-ref fields become links.
    const spec: OpenApiSpec = JSON.parse(
      JSON.stringify({
        paths: {
          '/api/v1/actors': {
            get: {
              operationId: 'listActors',
              tags: ['Actors'],
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/ActorRecord' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            _actor_record: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                project_id: { type: 'string', 'x-soat-ref': 'projects' },
              },
            },
          },
        },
      })
    );
    const actors = parseModules(spec).find((m) => {
      return m.tag === 'Actors';
    })!;
    const item = getListItemSchema(actors.listOp, spec);
    expect(extractRefFields(item, spec)).toEqual({ project_id: 'projects' });
  });
});
