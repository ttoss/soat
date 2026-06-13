import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as React from 'react';
import { describe, expect, test } from 'vitest';

import { AuthProvider, useAuth } from '@/auth/authContext';

import { server } from '../msw/server';

const Probe = () => {
  const { state, login, logout } = useAuth();
  const [err, setErr] = React.useState('');
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      {state.status === 'authenticated' && (
        <span data-testid="user">{state.user.username}</span>
      )}
      {err && <span data-testid="login-error">{err}</span>}
      <button
        onClick={async () => {
          const r = await login({ username: 'tester', password: 'pw' });
          if (r.error) setErr(r.error);
        }}
      >
        {'login'}
      </button>
      <button
        onClick={async () => {
          const r = await login({ username: 'tester', password: 'wrong' });
          if (r.error) setErr(r.error);
        }}
      >
        {'login-bad'}
      </button>
      <button onClick={logout}>{'logout'}</button>
    </div>
  );
};

const renderAuth = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );

describe('AuthProvider', () => {
  test('is unauthenticated when no token is stored', async () => {
    renderAuth();
    expect(await screen.findByText('unauthenticated')).toBeInTheDocument();
  });

  test('restores an authenticated session from a stored token', async () => {
    localStorage.setItem('soat_token', 'test-token');
    renderAuth();
    expect(await screen.findByTestId('user')).toHaveTextContent('tester');
  });

  test('clears an invalid stored token', async () => {
    localStorage.setItem('soat_token', 'bad');
    server.use(
      http.get('*/api/v1/users/me', () =>
        HttpResponse.json({ error: 'nope' }, { status: 401 })
      )
    );
    renderAuth();
    expect(await screen.findByText('unauthenticated')).toBeInTheDocument();
    expect(localStorage.getItem('soat_token')).toBeNull();
  });

  test('login stores the token and authenticates', async () => {
    renderAuth();
    await screen.findByText('unauthenticated');
    await userEvent.click(screen.getByRole('button', { name: 'login' }));
    expect(await screen.findByTestId('user')).toHaveTextContent('tester');
    expect(localStorage.getItem('soat_token')).toBe('test-token');
  });

  test('login surfaces an error for bad credentials', async () => {
    renderAuth();
    await screen.findByText('unauthenticated');
    await userEvent.click(screen.getByRole('button', { name: 'login-bad' }));
    expect(await screen.findByTestId('login-error')).toHaveTextContent(
      'Invalid credentials'
    );
  });

  test('logout clears the session', async () => {
    localStorage.setItem('soat_token', 'test-token');
    renderAuth();
    await screen.findByTestId('user');
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    expect(await screen.findByText('unauthenticated')).toBeInTheDocument();
    expect(localStorage.getItem('soat_token')).toBeNull();
  });
});
