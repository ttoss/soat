import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';

import {
  NavigationProvider,
  useNavigation,
} from '@/engine/navigationContext';

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
  test('navigate sets the active view descriptor', async () => {
    render(
      <NavigationProvider>
        <Harness />
      </NavigationProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByTestId('state')).toHaveTextContent('"mode":"list"');
  });

  test('setProject sets the project and clears the current view', async () => {
    render(
      <NavigationProvider>
        <Harness />
      </NavigationProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    await userEvent.click(screen.getByRole('button', { name: 'set-project' }));

    const state = screen.getByTestId('state');
    expect(state).toHaveTextContent('"activeProjectId":"prj_1"');
    expect(state).toHaveTextContent('"view":null');
  });
});
