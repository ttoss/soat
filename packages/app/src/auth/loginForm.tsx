import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BRAND_ASSETS } from '@/lib/brandAssets';

import { useAuth } from './authContext';

export const LoginForm = () => {
  const { login } = useAuth();
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await login({ username, password });
    if (result.error) setError(result.error);
    setLoading(false);
  };

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4"
      style={{
        backgroundImage:
          'radial-gradient(circle at 70% 20%, hsl(var(--brand-violet) / 0.14) 0%, transparent 42%), radial-gradient(circle at 20% 80%, hsl(var(--brand-cyan) / 0.08) 0%, transparent 42%)',
      }}
    >
      {/* Floating galaxy mark — purely decorative. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-[8%] top-[10%] h-72 w-72 rounded-full bg-galaxy-gradient opacity-10 blur-3xl dark:shadow-glow"
      />

      <div className="relative z-10 flex w-full max-w-sm flex-col gap-8">
        <div className="flex items-center justify-center gap-3">
          <img
            src={BRAND_ASSETS.logoMark}
            alt=""
            aria-hidden="true"
            className="h-10 w-10 object-contain"
          />
          <span className="bg-galaxy-gradient bg-clip-text font-heading text-3xl font-bold tracking-heading text-transparent">
            {'SOAT'}
          </span>
        </div>

        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-2xl">{'Sign in to SOAT'}</CardTitle>
            <CardDescription>
              {'Enter your username and password to continue'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="username">{'Username'}</Label>
                <Input
                  id="username"
                  type="text"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => {
                    return setUsername(e.target.value);
                  }}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">{'Password'}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => {
                    return setPassword(e.target.value);
                  }}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button
                type="submit"
                variant="gradient"
                className="w-full"
                disabled={loading}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
