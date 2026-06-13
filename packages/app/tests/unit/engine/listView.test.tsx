import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ListView } from '@/engine/listView';
import { parseModules } from '@/engine/specUtils';
import type { ModuleInfo } from '@/engine/types';

import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { NavProbe, renderWithAuth } from '../testUtils';

const agentsModule = (): ModuleInfo => {
  const m = parseModules(testSpec).find((x) => x.tag === 'Agents');
  if (!m) throw new Error('Agents module missing');
  return m;
};

const renderList = () =>
  renderWithAuth(
    <>
      <ListView module={agentsModule()} spec={testSpec} pathParams={{}} />
      <NavProbe />
    </>
  );

describe('ListView', () => {
  test('renders a row per item with derived, humanized columns', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([
          { id: 'agt_1', name: 'Alpha', model: 'gpt-4o' },
          { id: 'agt_2', name: 'Beta', model: 'gpt-4o-mini' },
        ])
      )
    );
    renderList();

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Name' })
    ).toBeInTheDocument();
    // id is hidden from the table
    expect(screen.queryByText('agt_1')).not.toBeInTheDocument();
  });

  test('shows an empty state when there are no items', async () => {
    server.use(http.get('*/api/v1/agents', () => HttpResponse.json([])));
    renderList();
    expect(await screen.findByText('No items found.')).toBeInTheDocument();
  });

  test('surfaces an error message when the request fails', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 })
      )
    );
    renderList();
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  test('clicking "View →" navigates to the detail view with the id param', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([{ id: 'agt_1', name: 'Alpha' }])
      )
    );
    renderList();

    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('button', { name: 'View →' }));

    const probe = screen.getByTestId('nav-probe');
    expect(probe).toHaveTextContent('"mode":"detail"');
    expect(probe).toHaveTextContent('"agent_id":"agt_1"');
  });

  test('clicking Create navigates to the create form', async () => {
    server.use(http.get('*/api/v1/agents', () => HttpResponse.json([])));
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: 'Create' }));
    expect(screen.getByTestId('nav-probe')).toHaveTextContent('"mode":"create"');
  });
});
