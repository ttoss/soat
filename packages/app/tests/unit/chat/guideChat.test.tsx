import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { GuideChat } from '@/chat/guideChat';

import { NavProbe, renderWithAuth } from '../testUtils';
import { server } from '../msw/server';

const PROJECT_PATH = '/app/v1/projects/prj_1';

const providerHandler = () =>
  http.get('*/api/v1/ai-providers', () =>
    HttpResponse.json([{ id: 'aip_1', name: 'OpenAI', provider: 'openai' }])
  );

// Handlers that let the guide provision successfully (no existing tool/agent).
const provisioningHandlers = () => [
  http.get('*/api/v1/tools', () => HttpResponse.json([])),
  http.post('*/api/v1/tools', () => HttpResponse.json({ id: 'tool_1' })),
  http.get('*/api/v1/agents', () => HttpResponse.json([])),
  http.post('*/api/v1/agents', () =>
    HttpResponse.json({ id: 'agt_guide', name: 'soat-app-guide' })
  ),
];

const renderGuide = () =>
  renderWithAuth(
    <>
      <GuideChat />
      <NavProbe />
    </>,
    { initialPath: PROJECT_PATH }
  );

describe('GuideChat', () => {
  test('prompts to select a project when none is active', async () => {
    renderWithAuth(<GuideChat />, { initialPath: '/app/' });
    expect(
      await screen.findByText(/select a project to use the ai guide/i)
    ).toBeInTheDocument();
  });

  test('renders the provider picker for the active project', async () => {
    server.use(providerHandler());
    renderGuide();
    const select = await screen.findByLabelText('AI provider');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'OpenAI' })).toBeInTheDocument();
    // The composer is disabled until a provider is chosen and provisioned.
    expect(screen.getByLabelText('Message the guide')).toBeDisabled();
  });

  test('shows an empty state when the project has no providers', async () => {
    server.use(
      http.get('*/api/v1/ai-providers', () => HttpResponse.json([]))
    );
    renderGuide();
    expect(
      await screen.findByText(/no ai providers in this project/i)
    ).toBeInTheDocument();
  });

  test('drives a turn that mounts a view and answers in the chat', async () => {
    server.use(providerHandler(), ...provisioningHandlers());
    server.use(
      http.post('*/api/v1/agents/agt_guide/generate', () =>
        HttpResponse.json({
          id: 'gen_1',
          status: 'requires_action',
          tool_calls: [
            {
              tool_call_id: 'c1',
              tool_name: 'render_page',
              args: { operationId: 'listAgents', mode: 'list' },
            },
          ],
        })
      ),
      http.post(
        '*/api/v1/agents/agt_guide/generate/gen_1/tool-outputs',
        () =>
          HttpResponse.json({
            id: 'gen_1',
            status: 'completed',
            text: 'Here are your agents.',
          })
      )
    );

    renderGuide();

    await userEvent.selectOptions(
      await screen.findByLabelText('AI provider'),
      'aip_1'
    );

    const input = await screen.findByLabelText('Message the guide');
    await waitFor(() => expect(input).toBeEnabled());

    await userEvent.type(input, 'show agents');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(
      await screen.findByText('Here are your agents.')
    ).toBeInTheDocument();
    // The view was actually mounted via real navigation.
    expect(screen.getByTestId('nav-probe')).toHaveTextContent('listAgents');
    // The transcript offers a re-mount affordance for the shown view.
    expect(
      screen.getByRole('button', { name: /Showing: Agents \(list\)/ })
    ).toBeInTheDocument();
  });

  test('surfaces a provisioning failure', async () => {
    server.use(providerHandler());
    server.use(
      http.get('*/api/v1/tools', () => HttpResponse.json([])),
      http.post('*/api/v1/tools', () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 })
      )
    );
    renderGuide();

    await userEvent.selectOptions(
      await screen.findByLabelText('AI provider'),
      'aip_1'
    );

    expect(await screen.findByText(/guide is unavailable/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Message the guide')).toBeDisabled();
  });

  test('collapses and re-opens the sidebar', async () => {
    server.use(providerHandler());
    renderGuide();
    await screen.findByLabelText('AI provider');

    await userEvent.click(screen.getByRole('button', { name: 'Collapse guide' }));
    expect(screen.queryByLabelText('AI provider')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Open guide' }));
    expect(await screen.findByLabelText('AI provider')).toBeInTheDocument();
  });
});
