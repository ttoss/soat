import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';

import { AuthProvider } from '@/auth/authContext';
import { LoginForm } from '@/auth/loginForm';

const renderLogin = () =>
  render(
    <AuthProvider>
      <LoginForm />
    </AuthProvider>
  );

describe('LoginForm', () => {
  test('renders the username and password fields', () => {
    renderLogin();
    expect(screen.getByText('Sign in to SOAT')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  test('shows an error message when credentials are rejected', async () => {
    renderLogin();
    await userEvent.type(screen.getByLabelText('Username'), 'tester');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });

  test('renders the SOAT wordmark with the galaxy gradient', () => {
    renderLogin();
    const wordmark = screen.getByText('SOAT');
    expect(wordmark).toHaveClass('bg-galaxy-gradient');
    expect(wordmark).toHaveClass('bg-clip-text');
    expect(wordmark).toHaveClass('text-transparent');
  });

  test('uses the gradient variant for the submit button', () => {
    renderLogin();
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toHaveClass('bg-galaxy-gradient');
  });

  test('submits valid credentials without showing an error', async () => {
    renderLogin();
    await userEvent.type(screen.getByLabelText('Username'), 'tester');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    // On success the form's parent swaps it out; here it simply clears errors.
    expect(screen.queryByText('Invalid credentials')).not.toBeInTheDocument();
  });
});
