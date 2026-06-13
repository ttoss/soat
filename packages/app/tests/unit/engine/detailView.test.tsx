import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { DetailView } from '@/engine/detailView';
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

const renderDetail = () =>
  renderWithAuth(
    <>
      <DetailView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
      />
      <NavProbe />
    </>
  );

const itemHandler = () =>
  http.get('*/api/v1/agents/:agent_id', () =>
    HttpResponse.json({
      id: 'agt_1',
      name: 'Alpha',
      api_key: 'sk_secret',
      created_at: '2024-01-01T00:00:00.000Z',
    })
  );

describe('DetailView', () => {
  test('renders fields and hides sensitive values', async () => {
    server.use(itemHandler());
    renderDetail();

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('[hidden]')).toBeInTheDocument();
    expect(screen.queryByText('sk_secret')).not.toBeInTheDocument();
  });

  test('surfaces an error when the fetch fails', async () => {
    server.use(
      http.get('*/api/v1/agents/:agent_id', () =>
        HttpResponse.json({ error: { message: 'not found' } }, { status: 404 })
      )
    );
    renderDetail();
    expect(await screen.findByText('not found')).toBeInTheDocument();
  });

  test('Edit navigates to the edit form', async () => {
    server.use(itemHandler());
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('nav-probe')).toHaveTextContent('"mode":"edit"');
  });

  test('renders item-scoped action buttons', async () => {
    server.use(itemHandler());
    renderDetail();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Generate' })
    );
    expect(screen.getByTestId('nav-probe')).toHaveTextContent('"mode":"action"');
    expect(screen.getByTestId('nav-probe')).toHaveTextContent('generateAgent');
  });

  test('Delete asks for confirmation, then deletes and navigates back', async () => {
    let deleted = false;
    server.use(
      itemHandler(),
      http.delete('*/api/v1/agents/:agent_id', () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      })
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Confirm delete' })
    );

    expect(await screen.findByTestId('nav-probe')).toHaveTextContent(
      '"view":null'
    );
    expect(deleted).toBe(true);
  });
});
