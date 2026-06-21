import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { IamScreen } from '@/views/iamScreen';
import { parseModules } from '@/engine/specUtils';
import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { renderWithAuth } from '../testUtils';

const allModules = parseModules(testSpec);

const renderIamScreen = (initialTag?: string) => {
  return renderWithAuth(
    <IamScreen modules={allModules} spec={testSpec} initialTag={initialTag} />
  );
};

test('renders Administration heading', async () => {
  renderIamScreen();
  expect(screen.getByText('Administration')).toBeInTheDocument();
});

test('shows three tabs: Users, Policies, AI Providers', () => {
  renderIamScreen();
  expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Policies' })).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'AI Providers' })
  ).toBeInTheDocument();
});

test('defaults to Users tab', async () => {
  server.use(
    http.get('*/api/v1/users', () => HttpResponse.json([{ id: 'usr_1', name: 'Alice' }]))
  );
  renderIamScreen();
  expect(await screen.findByText('Alice')).toBeInTheDocument();
});

test('initialTag="Policies" activates the Policies tab', async () => {
  server.use(
    http.get('*/api/v1/policies', () =>
      HttpResponse.json([{ id: 'pol_1', name: 'Read Only' }])
    )
  );
  renderIamScreen('Policies');
  expect(await screen.findByText('Read Only')).toBeInTheDocument();
});

test('clicking Policies tab switches to policies list', async () => {
  server.use(
    http.get('*/api/v1/policies', () =>
      HttpResponse.json([{ id: 'pol_2', name: 'Admin Policy' }])
    )
  );
  renderIamScreen();
  await userEvent.click(screen.getByRole('button', { name: 'Policies' }));
  expect(await screen.findByText('Admin Policy')).toBeInTheDocument();
});

test('clicking AI Providers tab switches to ai-providers list', async () => {
  server.use(
    http.get('*/api/v1/ai-providers', () =>
      HttpResponse.json([{ id: 'aip_1', name: 'OpenAI' }])
    )
  );
  renderIamScreen();
  await userEvent.click(screen.getByRole('button', { name: 'AI Providers' }));
  expect(await screen.findByText('OpenAI')).toBeInTheDocument();
});
