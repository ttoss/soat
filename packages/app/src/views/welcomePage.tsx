import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';

export const WelcomePage = () => {
  const { state, logout } = useAuth();
  if (state.status !== 'authenticated') return null;
  const { user } = state;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-bold">{`Welcome, ${user.username}`}</h1>
      <p className="text-muted-foreground">
        {'You are signed in as '}
        <strong>{user.role}</strong>
        {'.'}
      </p>
      <Button variant="outline" onClick={logout}>
        {'Sign out'}
      </Button>
    </div>
  );
};
