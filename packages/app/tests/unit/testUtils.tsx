import { render } from '@testing-library/react';
import * as React from 'react';

import { AuthProvider } from '@/auth/authContext';
import { NavigationProvider, useNavigation } from '@/engine/navigationContext';

const TOKEN_KEY = 'soat_token';

/**
 * Renders the current navigation descriptor as JSON so tests can assert real
 * navigation side-effects without mocking the navigation context.
 */
export const NavProbe = (): React.ReactElement => {
  const { view, activeProjectId } = useNavigation();
  return (
    <div data-testid="nav-probe">{JSON.stringify({ view, activeProjectId })}</div>
  );
};

/**
 * Renders `ui` inside the real Auth + Navigation providers. Auth is driven
 * through its genuine public flow (a token in localStorage + the MSW
 * `/users/me` handler), so no internal component is mocked — only the API.
 *
 * Engine views receive `module`/`spec`/`pathParams` as props, so the spec
 * provider is not required here.
 */
export const renderWithAuth = (
  ui: React.ReactElement,
  { token = 'test-token' }: { token?: string } = {}
) => {
  localStorage.setItem(TOKEN_KEY, token);
  return render(
    <AuthProvider>
      <NavigationProvider>{ui}</NavigationProvider>
    </AuthProvider>
  );
};
