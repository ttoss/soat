import { AuthProvider, useAuth } from './auth/authContext';
import { LoginForm } from './auth/loginForm';
import { WelcomePage } from './views/welcomePage';

const AppContent = () => {
  const { state } = useAuth();

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (state.status === 'unauthenticated') {
    return <LoginForm />;
  }

  return <WelcomePage />;
};

export const App = () => {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};
