import { BrowserRouter } from 'react-router-dom';

import { AuthProvider, useAuth } from './auth/authContext';
import { LoginForm } from './auth/loginForm';
import { NavigationProvider } from './engine/navigationContext';
import { SpecProvider } from './engine/specContext';
import { Workspace } from './views/workspace';

const AuthenticatedApp = () => {
  const { state } = useAuth();
  if (state.status !== 'authenticated') return null;
  return (
    <SpecProvider token={state.token}>
      <NavigationProvider>
        <Workspace />
      </NavigationProvider>
    </SpecProvider>
  );
};

const AppContent = () => {
  const { state } = useAuth();

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">{'Loading…'}</div>
      </div>
    );
  }

  if (state.status === 'unauthenticated') {
    return <LoginForm />;
  }

  return <AuthenticatedApp />;
};

export const App = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  );
};
