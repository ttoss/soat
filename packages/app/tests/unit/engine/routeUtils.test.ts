import { describe, expect, test } from 'vitest';

import {
  extractProjectId,
  matchTemplate,
  pathToView,
  viewToPath,
} from '@/engine/routeUtils';
import type { ViewDescriptor } from '@/engine/types';

import { testSpec } from '../fixtures/spec';
import { parseModules } from '@/engine/specUtils';

const modules = parseModules(testSpec);

describe('matchTemplate', () => {
  test('matches a concrete path against a template with one param', () => {
    expect(matchTemplate('/api/v1/agents/agt_1', '/api/v1/agents/{agent_id}')).toEqual({
      agent_id: 'agt_1',
    });
  });

  test('returns null when segment counts differ', () => {
    expect(matchTemplate('/api/v1/agents', '/api/v1/agents/{agent_id}')).toBeNull();
  });

  test('returns null on a literal mismatch', () => {
    expect(matchTemplate('/api/v1/projects', '/api/v1/agents')).toBeNull();
  });

  test('decodes encoded path params', () => {
    expect(
      matchTemplate('/api/v1/agents/hello%20world', '/api/v1/agents/{agent_id}')
    ).toEqual({ agent_id: 'hello world' });
  });
});

describe('viewToPath', () => {
  test('list view → collection URL', () => {
    const d: ViewDescriptor = {
      tag: 'Agents',
      operationId: 'listAgents',
      pathParams: {},
      mode: 'list',
    };
    expect(viewToPath(d, testSpec)).toBe('/app/v1/agents');
  });

  test('detail view → item URL', () => {
    const d: ViewDescriptor = {
      tag: 'Agents',
      operationId: 'getAgent',
      pathParams: { agent_id: 'agt_1' },
      mode: 'detail',
    };
    expect(viewToPath(d, testSpec)).toBe('/app/v1/agents/agt_1');
  });

  test('create view → collection URL + /new', () => {
    const d: ViewDescriptor = {
      tag: 'Agents',
      operationId: 'createAgent',
      pathParams: {},
      mode: 'create',
    };
    expect(viewToPath(d, testSpec)).toBe('/app/v1/agents/new');
  });

  test('edit view → item URL + /edit', () => {
    const d: ViewDescriptor = {
      tag: 'Agents',
      operationId: 'updateAgent',
      pathParams: { agent_id: 'agt_1' },
      mode: 'edit',
    };
    expect(viewToPath(d, testSpec)).toBe('/app/v1/agents/agt_1/edit');
  });

  test('action view → action URL', () => {
    const d: ViewDescriptor = {
      tag: 'Agents',
      operationId: 'generateAgent',
      pathParams: { agent_id: 'agt_1' },
      mode: 'action',
    };
    expect(viewToPath(d, testSpec)).toBe('/app/v1/agents/agt_1/generate');
  });

  test('returns null for an unknown operationId', () => {
    const d: ViewDescriptor = {
      tag: 'X',
      operationId: 'noop',
      pathParams: {},
      mode: 'list',
    };
    expect(viewToPath(d, testSpec)).toBeNull();
  });
});

describe('pathToView', () => {
  test('collection URL → list view', () => {
    const view = pathToView('/app/v1/agents', testSpec, modules);
    expect(view?.mode).toBe('list');
    expect(view?.operationId).toBe('listAgents');
    expect(view?.pathParams).toEqual({});
  });

  test('item URL → detail view with extracted path param', () => {
    const view = pathToView('/app/v1/agents/agt_1', testSpec, modules);
    expect(view?.mode).toBe('detail');
    expect(view?.operationId).toBe('getAgent');
    expect(view?.pathParams).toEqual({ agent_id: 'agt_1' });
  });

  test('/new suffix → create view', () => {
    const view = pathToView('/app/v1/agents/new', testSpec, modules);
    expect(view?.mode).toBe('create');
    expect(view?.operationId).toBe('createAgent');
  });

  test('/edit suffix → edit view', () => {
    const view = pathToView('/app/v1/agents/agt_1/edit', testSpec, modules);
    expect(view?.mode).toBe('edit');
    expect(view?.operationId).toBe('updateAgent');
    expect(view?.pathParams).toEqual({ agent_id: 'agt_1' });
  });

  test('action URL → action view', () => {
    const view = pathToView('/app/v1/agents/agt_1/generate', testSpec, modules);
    expect(view?.mode).toBe('action');
    expect(view?.operationId).toBe('generateAgent');
    expect(view?.pathParams).toEqual({ agent_id: 'agt_1' });
  });

  test('project-scoped URL extracts project_id', () => {
    const view = pathToView('/app/v1/projects/prj_1/webhooks', testSpec, modules);
    expect(view?.mode).toBe('list');
    expect(view?.pathParams).toEqual({ project_id: 'prj_1' });
  });

  test('returns null for an unrecognised path', () => {
    expect(pathToView('/app/v1/unknown', testSpec, modules)).toBeNull();
  });
});

describe('extractProjectId', () => {
  test('returns project_id when present in pathParams', () => {
    const view: ViewDescriptor = {
      tag: 'Webhooks',
      operationId: 'listWebhooks',
      pathParams: { project_id: 'prj_1' },
      mode: 'list',
    };
    expect(extractProjectId(view)).toBe('prj_1');
  });

  test('returns null when no project_id param', () => {
    const view: ViewDescriptor = {
      tag: 'Agents',
      operationId: 'listAgents',
      pathParams: {},
      mode: 'list',
    };
    expect(extractProjectId(view)).toBeNull();
  });

  test('returns null for null view', () => {
    expect(extractProjectId(null)).toBeNull();
  });
});
