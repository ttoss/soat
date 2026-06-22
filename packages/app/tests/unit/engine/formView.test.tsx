import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { FormView } from '@/engine/formView';
import { parseModules } from '@/engine/specUtils';
import type { JsonObject, ModuleInfo } from '@/engine/types';

import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { NavProbe, renderWithAuth } from '../testUtils';

const agentsModule = (): ModuleInfo => {
  const m = parseModules(testSpec).find((x) => x.tag === 'Agents');
  if (!m) throw new Error('Agents module missing');
  return m;
};

describe('FormView (create)', () => {
  test('renders fields derived from the request schema', () => {
    renderWithAuth(
      <FormView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );
    expect(screen.getByText('Create Agents')).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    // enum field renders a select
    expect(screen.getByRole('option', { name: 'gpt-4o' })).toBeInTheDocument();
  });

  test('submits the built body and navigates back on success', async () => {
    let received: JsonObject | undefined;
    server.use(
      http.post('*/api/v1/agents', async ({ request }) => {
        received = (await request.json()) as JsonObject;
        return HttpResponse.json({ id: 'agt_9', ...received }, { status: 201 });
      })
    );

    renderWithAuth(
      <>
        <FormView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{}}
          mode="create"
        />
        <NavProbe />
      </>
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Gamma');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByTestId('nav-probe')).toHaveTextContent(
      '"view":null'
    );
    // empty optional fields are omitted; only `name` is sent
    expect(received).toEqual({ name: 'Gamma' });
  });

  test('reveals a one-time secret from the create response instead of navigating away', async () => {
    server.use(
      http.post('*/api/v1/agents', () =>
        HttpResponse.json(
          { id: 'agt_9', name: 'Gamma', api_key: 'sk_live_secret123' },
          { status: 201 }
        )
      )
    );

    renderWithAuth(
      <>
        <FormView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{}}
          mode="create"
        />
        <NavProbe />
      </>
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Gamma');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The secret is revealed; the form is replaced by the reveal panel rather
    // than silently navigating away and discarding the one-time value.
    expect(await screen.findByText('sk_live_secret123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create' })
    ).not.toBeInTheDocument();
  });

  test('does not reveal anything when the create response carries no secret', async () => {
    server.use(
      http.post('*/api/v1/agents', () =>
        HttpResponse.json({ id: 'agt_9', name: 'Gamma' }, { status: 201 })
      )
    );

    renderWithAuth(
      <>
        <FormView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{}}
          mode="create"
        />
        <NavProbe />
      </>
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Gamma');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByTestId('nav-probe')).toHaveTextContent(
      '"view":null'
    );
    expect(
      screen.queryByRole('button', { name: /done/i })
    ).not.toBeInTheDocument();
  });

  test('shows the server error and stays on the form on failure', async () => {
    server.use(
      http.post('*/api/v1/agents', () =>
        HttpResponse.json({ error: 'name taken' }, { status: 409 })
      )
    );

    renderWithAuth(
      <FormView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Dup');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('name taken')).toBeInTheDocument();
  });

  test('renders a project selector populated from the API for x-soat-ref fields', async () => {
    server.use(
      http.get('*/api/v1/projects', () =>
        HttpResponse.json([
          { id: 'proj_1', name: 'Alpha Project' },
          { id: 'proj_2', name: 'Beta Project' },
        ])
      )
    );

    renderWithAuth(
      <FormView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );

    expect(
      await screen.findByRole('option', { name: 'Alpha Project' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Beta Project' })
    ).toBeInTheDocument();
  });

  test('shows the HTTP method badge and endpoint path', () => {
    renderWithAuth(
      <FormView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        mode="create"
      />
    );
    expect(screen.getByText('POST')).toBeInTheDocument();
    expect(screen.getByText(/\/api\/v1\/agents/)).toBeInTheDocument();
  });
});

describe('FormView (edit)', () => {
  test('prefills, sends a PUT, and navigates back', async () => {
    let method = '';
    server.use(
      http.put('*/api/v1/agents/:agent_id', async ({ request }) => {
        method = request.method;
        return HttpResponse.json({ id: 'agt_1', name: 'Edited' });
      })
    );

    renderWithAuth(
      <>
        <FormView
          module={agentsModule()}
          spec={testSpec}
          pathParams={{ agent_id: 'agt_1' }}
          mode="edit"
          prefill={{ name: 'Old' }}
        />
        <NavProbe />
      </>
    );

    const nameInput = screen.getByLabelText(/name/i);
    expect(nameInput).toHaveValue('Old');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('nav-probe')).toHaveTextContent(
      '"view":null'
    );
    expect(method).toBe('PUT');
  });
});
