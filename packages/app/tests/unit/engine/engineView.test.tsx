import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { EngineView } from '@/engine/engineView';
import { parseModules } from '@/engine/specUtils';
import type { ViewDescriptor } from '@/engine/types';

import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { renderWithAuth } from '../testUtils';

const modules = parseModules(testSpec);

const renderEngine = (descriptor: ViewDescriptor) =>
  renderWithAuth(
    <EngineView descriptor={descriptor} modules={modules} spec={testSpec} />
  );

describe('EngineView routing', () => {
  test('shows a message for an unknown module tag', () => {
    renderEngine({
      tag: 'Nope',
      operationId: 'x',
      pathParams: {},
      mode: 'list',
    });
    expect(
      screen.getByText('Module "Nope" not found in spec.')
    ).toBeInTheDocument();
  });

  test('renders the list view for mode "list"', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([{ id: 'agt_1', name: 'Alpha' }])
      )
    );
    renderEngine({
      tag: 'Agents',
      operationId: 'listAgents',
      pathParams: {},
      mode: 'list',
    });
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  test('renders the create form for mode "create"', () => {
    renderEngine({
      tag: 'Agents',
      operationId: 'createAgent',
      pathParams: {},
      mode: 'create',
    });
    expect(screen.getByText('Create Agents')).toBeInTheDocument();
  });

  test('renders the action form for mode "action"', () => {
    renderEngine({
      tag: 'Agents',
      operationId: 'generateAgent',
      pathParams: { agent_id: 'agt_1' },
      mode: 'action',
    });
    expect(screen.getByText('Run a generation')).toBeInTheDocument();
  });
});
