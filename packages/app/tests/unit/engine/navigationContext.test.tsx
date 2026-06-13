import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';

import {
  NavigationProvider,
  useNavigation,
} from '@/engine/navigationContext';
import { SpecProvider } from '@/engine/specContext';

// NavigationProvider derives its view from the URL and the loaded spec,
// so every test needs a Router context and a SpecProvider.
const Wrapper = ({
  children,
  initialPath = '/app/',
}: {
  children: React.ReactNode;
  initialPath?: string;
}) => (
  <MemoryRouter initialEntries={[initialPath]}>
    <SpecProvider token="test-token">
      <NavigationProvider>{children}</NavigationProvider>
    </SpecProvider>
  </MemoryRouter>
);

const Harness = () => {
  const { view, activeProjectId, navigate, setProject } = useNavigation();
  return (
    <div>
      <span data-testid="state">{JSON.stringify({ view, activeProjectId })}</span>
      <button
        onClick={() =>
          navigate({
            tag: 'Agents',
            operationId: 'listAgents',
            pathParams: {},
            mode: 'list',
          })
        }
      >
        {'go'}
      </button>
      <button onClick={() => setProject('prj_1')}>{'set-project'}</button>
      <button onClick={() => navigate(null)}>{'clear'}</button>
    </div>
  );
};

describe('NavigationProvider', () => {
  test('navigate pushes the correct URL and derives the view from it', async () => {
    render(
      <Wrapper>
        <Harness />
      </Wrapper>
    );
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    // The spec has listAgents at /api/v1/agents → URL becomes /app/v1/agents
    // → view is derived back to mode:'list'
    expect(await screen.findByTestId('state')).toHaveTextContent('"mode":"list"');
  });

  test('setProject navigates to the project URL', async () => {
    render(
      <Wrapper>
        <Harness />
      </Wrapper>
    );
    await userEvent.click(screen.getByRole('button', { name: 'set-project' }));
    // /app/v1/projects/prj_1 — Projects tag includes {project_id} in some paths
    // so activeProjectId is set from the URL path param
    expect(await screen.findByTestId('state')).toHaveTextContent('"activeProjectId":"prj_1"');
  });
});
