import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { ActionView } from '@/engine/actionView';
import { parseModules } from '@/engine/specUtils';
import type { JsonObject, ModuleInfo } from '@/engine/types';

import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { renderWithAuth } from '../testUtils';

const agentsModule = (): ModuleInfo => {
  const m = parseModules(testSpec).find((x) => x.tag === 'Agents');
  if (!m) throw new Error('Agents module missing');
  return m;
};

describe('ActionView', () => {
  test('renders a not-found message for an unknown operation', () => {
    renderWithAuth(
      <ActionView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
        operationId="doesNotExist"
      />
    );
    expect(screen.getByText('Action not found in spec.')).toBeInTheDocument();
  });

  test('renders the action form with its summary and schema fields', () => {
    renderWithAuth(
      <ActionView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
        operationId="generateAgent"
      />
    );
    expect(screen.getByText('Run a generation')).toBeInTheDocument();
    expect(screen.getByLabelText(/prompt/i)).toBeInTheDocument();
  });

  test('prompts for a missing path param', () => {
    renderWithAuth(
      <ActionView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{}}
        operationId="generateAgent"
      />
    );
    expect(screen.getByLabelText(/agent id/i)).toBeInTheDocument();
  });

  test('submits the action and shows the JSON result', async () => {
    let received: JsonObject | undefined;
    server.use(
      http.post('*/api/v1/agents/:agent_id/generate', async ({ request }) => {
        received = (await request.json()) as JsonObject;
        return HttpResponse.json({ id: 'gen_1', status: 'completed' });
      })
    );

    renderWithAuth(
      <ActionView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
        operationId="generateAgent"
      />
    );

    await userEvent.type(screen.getByLabelText(/prompt/i), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('Result')).toBeInTheDocument();
    expect(screen.getByText(/"status": "completed"/)).toBeInTheDocument();
    expect(received).toEqual({ prompt: 'Hello' });
  });

  test('shows an error when the action fails', async () => {
    server.use(
      http.post('*/api/v1/agents/:agent_id/generate', () =>
        HttpResponse.json({ error: 'model offline' }, { status: 503 })
      )
    );

    renderWithAuth(
      <ActionView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
        operationId="generateAgent"
      />
    );

    await userEvent.type(screen.getByLabelText(/prompt/i), 'Hi');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('model offline')).toBeInTheDocument();
  });

  test('renders the action form inside a centered modal dialog', () => {
    renderWithAuth(
      <ActionView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
        operationId="generateAgent"
      />
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('shows a completion status line with status and id when the result returns', async () => {
    server.use(
      http.post('*/api/v1/agents/:agent_id/generate', () =>
        HttpResponse.json({ id: 'gen_9', status: 'completed' })
      )
    );

    renderWithAuth(
      <ActionView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
        operationId="generateAgent"
      />
    );

    await userEvent.type(screen.getByLabelText(/prompt/i), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    // A tonal status badge plus the returned id appear as a completion line.
    expect(await screen.findByText('Completed')).toHaveClass('rounded-full');
    // id appears in the completion line (and again in the raw JSON dump).
    expect(screen.getAllByText(/gen_9/).length).toBeGreaterThanOrEqual(1);
  });

  test('shows the POST method badge and endpoint path', () => {
    renderWithAuth(
      <ActionView
        module={agentsModule()}
        spec={testSpec}
        pathParams={{ agent_id: 'agt_1' }}
        operationId="generateAgent"
      />
    );
    expect(screen.getByText('POST')).toBeInTheDocument();
    expect(screen.getByText(/\/api\/v1\/agents/)).toBeInTheDocument();
  });
});
