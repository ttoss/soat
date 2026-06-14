import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { App } from '@/app';

describe('App', () => {
  test('shows the login form when there is no session', async () => {
    render(<App />);
    expect(await screen.findByText('Sign in to SOAT')).toBeInTheDocument();
  });

  test('shows the workspace when a session is restored', async () => {
    localStorage.setItem('soat_token', 'test-token');
    render(<App />);
    expect(await screen.findByText('SOAT')).toBeInTheDocument();
    expect(screen.queryByText('Sign in to SOAT')).not.toBeInTheDocument();
  });
});
