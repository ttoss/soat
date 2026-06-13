import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { SpecProvider, useSpec } from '@/engine/specContext';

import { server } from '../msw/server';

const Probe = () => {
  const { loading, error, modules } = useSpec();
  if (loading) return <span>{'loading'}</span>;
  if (error) return <span data-testid="error">{error}</span>;
  return <span data-testid="tags">{modules.map((m) => m.tag).join(',')}</span>;
};

const renderSpec = () =>
  render(
    <SpecProvider token="test-token">
      <Probe />
    </SpecProvider>
  );

describe('SpecProvider', () => {
  test('loads the spec and derives modules', async () => {
    renderSpec();
    const tags = await screen.findByTestId('tags');
    expect(tags).toHaveTextContent('Agents');
    expect(tags).toHaveTextContent('Projects');
    expect(tags).toHaveTextContent('Webhooks');
  });

  test('exposes an error when the spec request fails', async () => {
    server.use(
      http.get('*/api/v1/openapi.json', () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 })
      )
    );
    renderSpec();
    expect(await screen.findByTestId('error')).toBeInTheDocument();
  });
});
