import {
  buildGuideInstructions,
  buildModuleIndex,
  GUIDE_AGENT_NAME,
  renderPageParameters,
  RENDER_PAGE_TOOL_NAME,
} from '@/chat/guideConfig';
import { parseModules } from '@/engine/specUtils';

import { testSpec } from '../fixtures/spec';

const modules = parseModules(testSpec);

describe('buildModuleIndex', () => {
  test('lists each operation with its mode', () => {
    const index = buildModuleIndex(modules);
    expect(index).toContain('listAgents (list)');
    expect(index).toContain('getAgent (detail)');
    expect(index).toContain('createAgent (create)');
    expect(index).toContain('updateAgent (edit)');
    expect(index).toContain('generateAgent (action)');
  });

  test('marks project-scoped modules', () => {
    const index = buildModuleIndex(modules);
    expect(index).toMatch(/Webhooks \(project-scoped\)/);
  });
});

describe('buildGuideInstructions', () => {
  test('embeds the project id, tool name, and module index', () => {
    const instructions = buildGuideInstructions({
      modules,
      projectId: 'prj_42',
    });
    expect(instructions).toContain('prj_42');
    expect(instructions).toContain(RENDER_PAGE_TOOL_NAME);
    expect(instructions).toContain('listAgents (list)');
  });
});

describe('render_page tool definition', () => {
  test('requires operationId and mode and is camelCase', () => {
    expect(renderPageParameters.required).toEqual(['operationId', 'mode']);
    expect(renderPageParameters.properties.operationId.type).toBe('string');
    expect(renderPageParameters.properties.mode.enum).toContain('list');
  });

  test('exposes a stable guide agent name', () => {
    expect(GUIDE_AGENT_NAME).toBe('soat-app-guide');
  });
});
