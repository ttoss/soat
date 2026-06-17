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
  test('renders the navigation with modules and welcome state', async () => {
    renderWorkspace();

    // SOAT wordmark is always visible
    expect(await screen.findByText('SOAT')).toBeInTheDocument();

    // Agents module button appears inside the open Orchestration group
    expect(
      await screen.findByRole('button', { name: 'Agents' })
    ).toBeInTheDocument();

    // Welcome message shown when no project or view is active
    expect(screen.getByText('Welcome to SOAT')).toBeInTheDocument();
  });

  test('project picker opens and shows available projects', async () => {
    server.use(
      http.get('*/api/v1/projects', () =>
        HttpResponse.json([{ id: 'prj_1', name: 'Proj One' }])
      )
    );
    renderWorkspace();

    // Open the project picker
    const pickerBtn = await screen.findByRole('button', {
      name: /select project/i,
    });
    await userEvent.click(pickerBtn);

    // Project name appears in the dropdown
    expect(await screen.findByText('Proj One')).toBeInTheDocument();
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
