import { executeRenderPage, toViewDescriptor } from '@/chat/renderPage';
import { parseModules } from '@/engine/specUtils';
import type { ViewDescriptor } from '@/engine/types';

import { testSpec } from '../fixtures/spec';

const modules = parseModules(testSpec);

describe('toViewDescriptor', () => {
  test('builds a descriptor for a known operation', () => {
    const descriptor = toViewDescriptor({
      toolArgs: { operationId: 'listAgents', mode: 'list' },
      modules,
      activeProjectId: null,
    });
    expect(descriptor).toEqual({
      tag: 'Agents',
      operationId: 'listAgents',
      pathParams: {},
      mode: 'list',
    });
  });

  test('injects the active project for project-scoped views only', () => {
    const scoped = toViewDescriptor({
      toolArgs: { operationId: 'listWebhooks', mode: 'list' },
      modules,
      activeProjectId: 'prj_1',
    });
    expect(scoped?.pathParams).toEqual({ project_id: 'prj_1' });

    const unscoped = toViewDescriptor({
      toolArgs: { operationId: 'listAgents', mode: 'list' },
      modules,
      activeProjectId: 'prj_1',
    });
    expect(unscoped?.pathParams).toEqual({});
  });

  test('coerces provided path params to strings', () => {
    const descriptor = toViewDescriptor({
      toolArgs: {
        operationId: 'getAgent',
        mode: 'detail',
        pathParams: { agent_id: 'agt_9' },
      },
      modules,
      activeProjectId: null,
    });
    expect(descriptor?.pathParams).toEqual({ agent_id: 'agt_9' });
  });

  test('returns null for an unknown operationId', () => {
    expect(
      toViewDescriptor({
        toolArgs: { operationId: 'nope', mode: 'list' },
        modules,
        activeProjectId: null,
      })
    ).toBeNull();
  });

  test('returns null for an invalid mode', () => {
    expect(
      toViewDescriptor({
        toolArgs: { operationId: 'listAgents', mode: 'explode' },
        modules,
        activeProjectId: null,
      })
    ).toBeNull();
  });
});

describe('executeRenderPage', () => {
  test('navigates and returns an ok summary on success', () => {
    const navigated: ViewDescriptor[] = [];
    const result = executeRenderPage({
      toolArgs: { operationId: 'listAgents', mode: 'list' },
      spec: testSpec,
      modules,
      activeProjectId: null,
      navigate: (d) => navigated.push(d),
    });
    expect(result.output).toEqual({
      ok: true,
      operationId: 'listAgents',
      mode: 'list',
    });
    expect(result.view?.operationId).toBe('listAgents');
    expect(navigated).toHaveLength(1);
  });

  test('returns an error summary without navigating on a bad call', () => {
    const navigated: ViewDescriptor[] = [];
    const result = executeRenderPage({
      toolArgs: { operationId: 'unknownOp', mode: 'list' },
      spec: testSpec,
      modules,
      activeProjectId: null,
      navigate: (d) => navigated.push(d),
    });
    expect(result.output).toMatchObject({ ok: false });
    expect(result.view).toBeUndefined();
    expect(navigated).toHaveLength(0);
  });
});
