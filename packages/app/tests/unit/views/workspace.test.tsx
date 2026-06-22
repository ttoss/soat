import { render, screen, waitFor, within } from '@testing-library/react';
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

// Handlers needed so a project can be selected and its detail view can load
// (the detail page fetches the project and its sub-resources).
const projectHandlers = [
  http.get('*/api/v1/projects', () => {
    return HttpResponse.json([{ id: 'prj_1', name: 'Proj One' }]);
  }),
  http.get('*/api/v1/projects/:project_id', () => {
    return HttpResponse.json({ id: 'prj_1', name: 'Proj One' });
  }),
  http.get('*/api/v1/projects/:project_id/:sub', () => {
    return HttpResponse.json([]);
  }),
];

// Selects "Proj One" via the inline prompt shown when no project is active.
const selectProjOne = async (): Promise<void> => {
  await userEvent.click(await screen.findByRole('button', { name: /Proj One/ }));
};

describe('Workspace', () => {
  test('shows the select-a-project prompt when none is active', async () => {
    renderWorkspace();

    // SOAT wordmark and module nav are always visible.
    expect(await screen.findByText('SOAT')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Agents' })
    ).toBeInTheDocument();

    // With no project selected, the main area prompts to pick one.
    expect(screen.getByText('Select a project first')).toBeInTheDocument();
  });

  test('lists modules as a flat list without collapsible groups', async () => {
    renderWorkspace();

    // Modules that previously lived in collapsed groups are visible
    // immediately, with no group header to expand first.
    expect(
      await screen.findByRole('button', { name: 'Webhooks' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Api Keys' })
    ).toBeInTheDocument();

    // Group header toggles no longer exist.
    expect(
      screen.queryByRole('button', { name: 'Orchestration' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'API' })
    ).not.toBeInTheDocument();
  });

  test('lists modules alphabetically by label', async () => {
    renderWorkspace();

    // Alphabetical: Agents < Tools < Webhooks. Note this reverses the
    // OpenAPI/parseModules order, where the Webhooks path precedes Tools.
    const agents = await screen.findByRole('button', { name: 'Agents' });
    const tools = await screen.findByRole('button', { name: 'Tools' });
    const webhooks = await screen.findByRole('button', { name: 'Webhooks' });

    expect(
      agents.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      tools.compareDocumentPosition(webhooks) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('project picker opens and shows available projects', async () => {
    server.use(
      http.get('*/api/v1/projects', () =>
        HttpResponse.json([{ id: 'prj_1', name: 'Proj One' }])
      )
    );
    renderWorkspace();

    // Scope to the sidebar nav so we assert on the picker dropdown, not the
    // project list rendered by the main-area prompt.
    const nav = await screen.findByRole('navigation');
    await userEvent.click(
      await within(nav).findByRole('button', { name: /select project/i })
    );
    expect(await within(nav).findByText('Proj One')).toBeInTheDocument();
  });

  test('project picker derives its label via the shared spec helper', async () => {
    // A project with no name falls back to its id — proving the picker uses
    // the engine's extractItems + itemLabel rather than a hardcoded `name`.
    server.use(
      http.get('*/api/v1/projects', () =>
        HttpResponse.json([{ id: 'prj_42' }])
      )
    );
    renderWorkspace();

    const nav = await screen.findByRole('navigation');
    await userEvent.click(
      await within(nav).findByRole('button', { name: /select project/i })
    );
    expect(await within(nav).findByText('prj_42')).toBeInTheDocument();
  });

  test('displays the app version in the sidebar footer', async () => {
    renderWorkspace();

    // The footer should show a semver version string (e.g. "v0.12.3")
    expect(
      await screen.findByText(/^v\d+\.\d+\.\d+$/)
    ).toBeInTheDocument();
  });

  test('Projects and API Keys live in the Admin block, below the flat modules', async () => {
    renderWorkspace();

    const adminHeader = await screen.findByText('Admin');
    const projects = await screen.findByRole('button', { name: 'Projects' });
    const apiKeys = screen.getByRole('button', { name: 'Api Keys' });

    // Both global/governance modules render after the "Admin" header — i.e.
    // inside the Admin block, not at the top of the sidebar.
    expect(
      adminHeader.compareDocumentPosition(projects) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      adminHeader.compareDocumentPosition(apiKeys) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // A project-scoped module (Agents) stays above the Admin block.
    const agents = screen.getByRole('button', { name: 'Agents' });
    expect(
      agents.compareDocumentPosition(adminHeader) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // The Admin block is itself alphabetical: Api Keys < Users.
    const users = screen.getByRole('button', { name: 'Users' });
    expect(
      apiKeys.compareDocumentPosition(users) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // AI Providers is a per-project resource, so it lives in the flat module
    // list (above the Admin header), not in the Admin block.
    const aiProviders = screen.getByRole('button', { name: 'Ai Providers' });
    expect(
      aiProviders.compareDocumentPosition(adminHeader) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('prompts for a project on a project-scoped page when none is selected', async () => {
    server.use(
      http.get('*/api/v1/projects', () =>
        HttpResponse.json([{ id: 'prj_1', name: 'Proj One' }])
      ),
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([{ id: 'agt_1', name: 'Alpha' }])
      )
    );
    renderWorkspace();

    // Open the Agents list (project-scoped) without selecting a project.
    await userEvent.click(await screen.findByRole('button', { name: 'Agents' }));

    // The prompt replaces the (unscoped) list, and lists projects to pick.
    expect(
      await screen.findByText('Select a project first')
    ).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Proj One/ })).toBeInTheDocument();
  });

  test('nested sub-resources (e.g. Sessions) are not top-level sidebar items', async () => {
    renderWorkspace();

    // Top-level modules are present...
    expect(
      await screen.findByRole('button', { name: 'Agents' })
    ).toBeInTheDocument();
    // ...but Sessions (list path /agents/{agent_id}/sessions) needs a parent
    // agent_id, so it is reached from an agent's detail view, not the sidebar.
    expect(
      screen.queryByRole('button', { name: 'Sessions' })
    ).not.toBeInTheDocument();
  });

  test('a global module renders without a selected project', async () => {
    server.use(
      http.get('*/api/v1/users', () =>
        HttpResponse.json([{ id: 'usr_9', username: 'zoe' }])
      )
    );
    renderWorkspace();

    // Users is global (its list takes no project_id query), so it renders
    // even with no project active — no prompt.
    await userEvent.click(await screen.findByRole('button', { name: 'Users' }));
    expect(await screen.findByText('zoe')).toBeInTheDocument();
    expect(screen.queryByText('Select a project first')).not.toBeInTheDocument();
  });

  test('navigating to another page shows a loading state, not the old page', async () => {
    let releaseTools: () => void = () => {};
    server.use(
      ...projectHandlers,
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([{ id: 'agt_1', name: 'Alpha' }])
      ),
      http.get('*/api/v1/tools', async () => {
        await new Promise<void>((resolve) => {
          releaseTools = resolve;
        });
        return HttpResponse.json([{ id: 'tool_1', name: 'Hammer' }]);
      })
    );
    renderWorkspace();
    await selectProjOne();

    // Land on the Agents list.
    await userEvent.click(await screen.findByRole('button', { name: 'Agents' }));
    expect(await screen.findByText('Alpha')).toBeInTheDocument();

    // Navigate to Tools (whose fetch is held open). The Agents content must be
    // gone immediately, replaced by the new page's loading state — proving the
    // view remounts on navigation rather than showing stale data.
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();

    // Resolve Tools; its content then renders.
    releaseTools();
    expect(await screen.findByText('Hammer')).toBeInTheDocument();
  });

  test('keeps the selected project when navigating between modules', async () => {
    server.use(
      ...projectHandlers,
      http.get('*/api/v1/agents', () => HttpResponse.json([]))
    );
    renderWorkspace();

    // Select a project via the inline prompt.
    await selectProjOne();

    // The sidebar picker reflects the selection.
    const nav = await screen.findByRole('navigation');
    expect(
      await within(nav).findByRole('button', { name: /Proj One/ })
    ).toBeInTheDocument();

    // Navigate to a module whose route carries no project_id.
    await userEvent.click(await screen.findByRole('button', { name: 'Agents' }));

    // The selection sticks — the picker still shows the project, not the
    // "Select project…" empty state.
    expect(
      await within(nav).findByRole('button', { name: /Proj One/ })
    ).toBeInTheDocument();
    expect(
      within(nav).queryByRole('button', { name: /select project/i })
    ).not.toBeInTheDocument();
  });

  test('scopes a list request to the selected project (project_id query)', async () => {
    let agentsUrl: string | undefined;
    server.use(
      ...projectHandlers,
      http.get('*/api/v1/agents', ({ request }) => {
        agentsUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    renderWorkspace();

    await selectProjOne();
    await userEvent.click(await screen.findByRole('button', { name: 'Agents' }));

    // The Agents list (whose op accepts a project_id query param) is fetched
    // scoped to the active project.
    await waitFor(() => {
      expect(agentsUrl).toContain('project_id=prj_1');
    });
  });

  test('non-admin users see neither the Admin block nor its modules', async () => {
    server.use(
      http.get('*/api/v1/users/me', () =>
        HttpResponse.json({ id: 'usr_2', username: 'bob', role: 'user' })
      )
    );
    renderWorkspace();

    // Flat project modules are still available...
    expect(
      await screen.findByRole('button', { name: 'Agents' })
    ).toBeInTheDocument();
    // ...but the governance block and its members are hidden.
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Projects' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Api Keys' })
    ).not.toBeInTheDocument();
  });

  test('selecting a module renders its list in the main area', async () => {
    server.use(
      ...projectHandlers,
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([{ id: 'agt_1', name: 'Alpha' }])
      )
    );
    renderWorkspace();

    await selectProjOne();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Agents' })
    );
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });
});
