import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';

import { AuthProvider } from '@/auth/authContext';
import { NavigationProvider } from '@/engine/navigationContext';
import { SpecProvider } from '@/engine/specContext';
import { Workspace } from '@/views/workspace';

import { server } from '../msw/server';

const renderWorkspace = (initialPath = '/app/'): void => {
  localStorage.setItem('soat_token', 'test-token');
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <SpecProvider token="test-token">
          <NavigationProvider>
            <Workspace />
          </NavigationProvider>
        </SpecProvider>
      </AuthProvider>
    </MemoryRouter>
  );
};

describe('Workspace', () => {
  test('renders the navigation with projects and modules', async () => {
    server.use(
      http.get('*/api/v1/projects', () =>
        HttpResponse.json([{ id: 'prj_1', name: 'Proj One' }])
      )
    );
    renderWorkspace();

    expect(await screen.findByText('Proj One')).toBeInTheDocument();
    expect(screen.getByText('SOAT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByText('Welcome to SOAT')).toBeInTheDocument();
  });

  test('selecting a module renders its list in the main area', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([{ id: 'agt_1', name: 'Alpha' }])
      )
    );
    renderWorkspace();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Agents' })
    );
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });
});
