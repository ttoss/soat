import { http, HttpResponse } from 'msw';

import { listAiProviders, provisionGuide } from '@/chat/guideProvisioning';
import { parseModules } from '@/engine/specUtils';

import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';

const modules = parseModules(testSpec);
const base = { token: 'test-token', projectId: 'prj_1' };

describe('listAiProviders', () => {
  test('returns providers scoped to the project', async () => {
    let requestedUrl = '';
    server.use(
      http.get('*/api/v1/ai-providers', ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([
          { id: 'aip_1', name: 'OpenAI', provider: 'openai' },
        ]);
      })
    );
    const providers = await listAiProviders(base);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('aip_1');
    expect(requestedUrl).toContain('project_id=prj_1');
  });

  test('returns an empty list on error', async () => {
    server.use(
      http.get('*/api/v1/ai-providers', () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 })
      )
    );
    expect(await listAiProviders(base)).toEqual([]);
  });
});

describe('provisionGuide', () => {
  test('creates the render_page tool and guide agent when absent', async () => {
    let toolBody: Record<string, unknown> | undefined;
    let agentBody: Record<string, unknown> | undefined;
    server.use(
      http.get('*/api/v1/tools', () => HttpResponse.json([])),
      http.post('*/api/v1/tools', async ({ request }) => {
        toolBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 'tool_1', name: 'render_page' });
      }),
      http.get('*/api/v1/agents', () => HttpResponse.json([])),
      http.post('*/api/v1/agents', async ({ request }) => {
        agentBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 'agt_guide', name: 'soat-app-guide' });
      })
    );

    const result = await provisionGuide({ ...base, providerId: 'aip_1', modules });

    expect(result).toEqual({ ok: true, agentId: 'agt_guide' });
    expect(toolBody).toMatchObject({ name: 'render_page', type: 'client' });
    expect(agentBody).toMatchObject({
      name: 'soat-app-guide',
      ai_provider_id: 'aip_1',
      tool_ids: ['tool_1'],
    });
  });

  test('reuses the existing tool and agent without creating duplicates', async () => {
    let createdTool = false;
    let createdAgent = false;
    server.use(
      http.get('*/api/v1/tools', () =>
        HttpResponse.json([{ id: 'tool_x', name: 'render_page', type: 'client' }])
      ),
      http.post('*/api/v1/tools', () => {
        createdTool = true;
        return HttpResponse.json({ id: 'tool_x' });
      }),
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([
          {
            id: 'agt_x',
            name: 'soat-app-guide',
            ai_provider_id: 'aip_1',
            tool_ids: ['tool_x'],
          },
        ])
      ),
      http.post('*/api/v1/agents', () => {
        createdAgent = true;
        return HttpResponse.json({ id: 'agt_x' });
      })
    );

    const result = await provisionGuide({ ...base, providerId: 'aip_1', modules });

    expect(result).toEqual({ ok: true, agentId: 'agt_x' });
    expect(createdTool).toBe(false);
    expect(createdAgent).toBe(false);
  });

  test('re-binds the provider when the existing agent points elsewhere', async () => {
    let updateBody: Record<string, unknown> | undefined;
    server.use(
      http.get('*/api/v1/tools', () =>
        HttpResponse.json([{ id: 'tool_x', name: 'render_page', type: 'client' }])
      ),
      http.get('*/api/v1/agents', () =>
        HttpResponse.json([
          {
            id: 'agt_x',
            name: 'soat-app-guide',
            ai_provider_id: 'aip_OLD',
            tool_ids: ['tool_x'],
          },
        ])
      ),
      http.put('*/api/v1/agents/agt_x', async ({ request }) => {
        updateBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 'agt_x' });
      })
    );

    const result = await provisionGuide({ ...base, providerId: 'aip_NEW', modules });

    expect(result).toEqual({ ok: true, agentId: 'agt_x' });
    expect(updateBody).toMatchObject({ ai_provider_id: 'aip_NEW' });
  });

  test('reports unavailable when the user cannot create a tool', async () => {
    server.use(
      http.get('*/api/v1/tools', () => HttpResponse.json([])),
      http.post('*/api/v1/tools', () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 })
      )
    );

    const result = await provisionGuide({ ...base, providerId: 'aip_1', modules });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unavailable/i);
  });
});
