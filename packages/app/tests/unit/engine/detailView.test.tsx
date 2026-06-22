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

const renderDetail = (modules?: ModuleInfo[]) =>
  renderWithAuth(
    <>
      <DetailView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
        modules={modules}
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

  test('renders an x-soat-ref field as a link to the referenced resource', async () => {
    server.use(
      http.get('*/api/v1/agents/:agent_id', () =>
        HttpResponse.json({ id: 'agt_1', name: 'Alpha', project_id: 'proj_42' })
      )
    );
    renderDetail(parseModules(testSpec));

    const link = await screen.findByRole('button', { name: 'proj_42' });
    await userEvent.click(link);

    const probe = screen.getByTestId('nav-probe');
    expect(probe).toHaveTextContent('"tag":"Projects"');
    expect(probe).toHaveTextContent('"mode":"detail"');
    expect(probe).toHaveTextContent('"project_id":"proj_42"');
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

  test('shows the item name as the primary heading', async () => {
    server.use(itemHandler());
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
  });

  test('shows the status as a badge next to the title', async () => {
    server.use(
      http.get('*/api/v1/agents/:agent_id', () =>
        HttpResponse.json({ id: 'agt_1', name: 'Alpha', status: 'active' })
      )
    );
    renderDetail();

    const badge = await screen.findByText('Active');
    expect(badge).toHaveClass('rounded-full');
  });

  test('groups fields into labeled section cards', async () => {
    server.use(
      http.get('*/api/v1/agents/:agent_id', () =>
        HttpResponse.json({
          id: 'agt_1',
          name: 'Alpha',
          status: 'active',
          model: 'gpt-4o',
        })
      )
    );
    renderDetail();

    expect(await screen.findByText('Overview')).toBeInTheDocument();
  });

  test('renders long/multiline fields in their own mono block card', async () => {
    const instructions = 'You are a helpful assistant.\n'.repeat(8);
    server.use(
      http.get('*/api/v1/agents/:agent_id', () =>
        HttpResponse.json({
          id: 'agt_1',
          name: 'Alpha',
          instructions,
        })
      )
    );
    renderDetail();

    expect(await screen.findByText('Instructions')).toBeInTheDocument();
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('You are a helpful assistant.');
  });

  test('shows sub-resource tabs and loads their items', async () => {
    server.use(
      itemHandler(),
      http.get('*/api/v1/agents/:agent_id/sessions', () =>
        HttpResponse.json([{ id: 'ses_1', name: 'Session One' }])
      )
    );
    renderWithAuth(
      <>
        <DetailView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{ agent_id: 'agt_1' }}
          modules={parseModules(testSpec)}
        />
        <NavProbe />
      </>
    );
    expect(await screen.findByRole('button', { name: /sessions/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /sessions/i }));
    expect(await screen.findByText('Session One')).toBeInTheDocument();
  });
});
