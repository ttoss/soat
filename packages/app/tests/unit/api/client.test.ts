import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { apiFetch } from '@/api/client';

import { server } from '../msw/server';

describe('apiFetch', () => {
  test('returns ok with parsed data on success', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([{ id: 'agt_1' }])
      )
    );
    const result = await apiFetch<{ id: string }[]>({
      url: '/api/v1/agents',
      token: 't',
    });
    expect(result).toEqual({ ok: true, data: [{ id: 'agt_1' }] });
  });

  test('sends the bearer token and JSON body on POST', async () => {
    let auth: string | null = null;
    let body: unknown;
    server.use(
      http.post('*/api/v1/agents', async ({ request }) => {
        auth = request.headers.get('Authorization');
        body = await request.json();
        return HttpResponse.json({ id: 'agt_2' }, { status: 201 });
      })
    );
    const result = await apiFetch({
      url: '/api/v1/agents',
      method: 'POST',
      body: { name: 'X' },
      token: 'secret',
    });
    expect(result.ok).toBe(true);
    expect(auth).toBe('Bearer secret');
    expect(body).toEqual({ name: 'X' });
  });

  test('parses a string error field', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json({ error: 'boom' }, { status: 400 })
      )
    );
    const result = await apiFetch({ url: '/api/v1/agents', token: 't' });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: { message: 'boom' },
    });
  });

  test('parses an object error field with message and code', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json(
          { error: { message: 'denied', code: 'forbidden' } },
          { status: 403 }
        )
      )
    );
    const result = await apiFetch({ url: '/api/v1/agents', token: 't' });
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: { message: 'denied', code: 'forbidden' },
    });
  });

  test('falls back to an HTTP status message when no error field exists', async () => {
    server.use(
      http.get('*/api/v1/agents', () =>
        HttpResponse.json({}, { status: 500 })
      )
    );
    const result = await apiFetch({ url: '/api/v1/agents', token: 't' });
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      error: { message: 'HTTP 500' },
    });
  });
});
