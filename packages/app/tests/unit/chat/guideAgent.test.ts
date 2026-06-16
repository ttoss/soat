import { http, HttpResponse } from 'msw';

import { runGuideTurn } from '@/chat/guideAgent';
import type { GuideToolCall } from '@/chat/types';

import { server } from '../msw/server';

const base = {
  token: 'test-token',
  agentId: 'agt_guide',
  messages: [{ role: 'user', content: 'hi' }],
};

const noopExecutor = () => ({ output: { ok: true } });

describe('runGuideTurn', () => {
  test('returns the final text for a completed generation', async () => {
    server.use(
      http.post('*/api/v1/agents/agt_guide/generate', () =>
        HttpResponse.json({ id: 'gen_1', status: 'completed', text: 'Hello!' })
      )
    );

    const result = await runGuideTurn({ ...base, executeToolCall: noopExecutor });

    expect(result).toEqual({ ok: true, text: 'Hello!', view: undefined });
  });

  test('resolves tool calls and resumes until completed', async () => {
    const seen: GuideToolCall[] = [];
    let toolOutputsBody: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/agents/agt_guide/generate', () =>
        HttpResponse.json({
          id: 'gen_1',
          status: 'requires_action',
          tool_calls: [
            {
              tool_call_id: 'c1',
              tool_name: 'render_page',
              args: { operationId: 'listAgents', mode: 'list' },
            },
          ],
        })
      ),
      http.post(
        '*/api/v1/agents/agt_guide/generate/gen_1/tool-outputs',
        async ({ request }) => {
          toolOutputsBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: 'gen_1',
            status: 'completed',
            text: 'Here are your agents.',
          });
        }
      )
    );

    const result = await runGuideTurn({
      ...base,
      executeToolCall: (call) => {
        seen.push(call);
        return { output: { ok: true }, view: { tag: 'Agents', operationId: 'listAgents', pathParams: {}, mode: 'list' } };
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('Here are your agents.');
      expect(result.view?.operationId).toBe('listAgents');
    }
    expect(seen[0].tool_name).toBe('render_page');
    expect(toolOutputsBody).toEqual({
      tool_outputs: [{ tool_call_id: 'c1', output: { ok: true } }],
    });
  });

  test('surfaces an API error', async () => {
    server.use(
      http.post('*/api/v1/agents/agt_guide/generate', () =>
        HttpResponse.json(
          { error: { code: 'AI_PROVIDER_ERROR', message: 'boom' } },
          { status: 502 }
        )
      )
    );

    const result = await runGuideTurn({ ...base, executeToolCall: noopExecutor });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('boom');
  });
});
