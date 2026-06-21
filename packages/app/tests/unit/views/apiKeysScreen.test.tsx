import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { ApiKeysScreen } from '@/views/apiKeysScreen';
import { parseModules } from '@/engine/specUtils';
import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { renderWithAuth } from '../testUtils';

const apiKeysModule = parseModules(testSpec).find((m) => m.tag === 'Api Keys')!;

const PATH_PARAMS = { project_id: 'prj_1' };

const TWO_KEYS = [
  {
    id: 'key_1',
    name: 'Production Key',
    key: 'sk_live_abcdefgh1234',
    status: 'active',
    scopes: ['read', 'write'],
    expires_at: null,
  },
  {
    id: 'key_2',
    name: 'Read Only Key',
    key: 'sk_live_xyz9876',
    status: 'revoked',
    scopes: 'read',
    expires_at: '2025-01-01T00:00:00Z',
  },
];

const renderApiKeysScreen = () => {
  return renderWithAuth(
    <ApiKeysScreen
      module={apiKeysModule}
      spec={testSpec}
      pathParams={PATH_PARAMS}
    />
  );
};

test('shows loading state initially', () => {
  server.use(
    http.get('*/api/v1/projects/:project_id/api-keys', async () => {
      await new Promise(() => {});
      return HttpResponse.json([]);
    })
  );
  renderApiKeysScreen();
  expect(screen.getByText('Loading keys…')).toBeInTheDocument();
});

test('renders a row per key with name', async () => {
  server.use(
    http.get('*/api/v1/projects/:project_id/api-keys', () =>
      HttpResponse.json(TWO_KEYS)
    )
  );
  renderApiKeysScreen();

  expect(await screen.findByText('Production Key')).toBeInTheDocument();
  expect(screen.getByText('Read Only Key')).toBeInTheDocument();
});

test('shows empty state when no keys exist', async () => {
  renderApiKeysScreen();
  expect(await screen.findByText('No API keys yet.')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /create your first key/i })
  ).toBeInTheDocument();
});

test('shows error message on fetch failure', async () => {
  server.use(
    http.get('*/api/v1/projects/:project_id/api-keys', () =>
      HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  );
  renderApiKeysScreen();
  expect(await screen.findByText(/unauthorized/i)).toBeInTheDocument();
});

test('opens create panel when "Create Key" is clicked', async () => {
  renderApiKeysScreen();
  await screen.findByText('No API keys yet.');
  await userEvent.click(screen.getByRole('button', { name: /create key/i }));
  expect(screen.getByText('New API Key')).toBeInTheDocument();
});

test('submits create form and shows new key banner', async () => {
  let requestBody: unknown;
  server.use(
    http.post('*/api/v1/projects/:project_id/api-keys', async ({ request }) => {
      requestBody = await request.json();
      return HttpResponse.json(
        { id: 'key_new', name: 'My Key', key: 'sk_live_newkey999' },
        { status: 201 }
      );
    })
  );
  renderApiKeysScreen();
  await screen.findByText('No API keys yet.');

  await userEvent.click(screen.getAllByRole('button', { name: /create key/i })[0]);
  await userEvent.type(screen.getByLabelText(/name/i), 'My Key');
  // click the submit button inside the panel (last "Create Key" button)
  const createButtons = screen.getAllByRole('button', { name: /^create key$/i });
  await userEvent.click(createButtons[createButtons.length - 1]);

  expect(await screen.findByText(/copy your api key/i)).toBeInTheDocument();
  expect(screen.getByText('sk_live_newkey999')).toBeInTheDocument();
  expect(requestBody).toEqual({ name: 'My Key' });
});

test('dismisses new key banner when X is clicked', async () => {
  server.use(
    http.post('*/api/v1/projects/:project_id/api-keys', () =>
      HttpResponse.json({ id: 'key_new', key: 'sk_live_xyz' }, { status: 201 })
    )
  );
  renderApiKeysScreen();
  await screen.findByText('No API keys yet.');

  await userEvent.click(screen.getAllByRole('button', { name: /create key/i })[0]);
  await userEvent.type(screen.getByLabelText(/name/i), 'Temp');
  const createButtons = screen.getAllByRole('button', { name: /^create key$/i });
  await userEvent.click(createButtons[createButtons.length - 1]);

  await screen.findByText(/copy your api key/i);
  await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(screen.queryByText(/copy your api key/i)).not.toBeInTheDocument();
});
