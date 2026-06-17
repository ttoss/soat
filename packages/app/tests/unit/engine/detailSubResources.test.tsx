import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { SubResourceTabs } from '@/engine/detailSubResources';
import { parseModules } from '@/engine/specUtils';
import type { ModuleInfo } from '@/engine/types';

import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { renderWithAuth } from '../testUtils';

const sessionsModule = (): ModuleInfo => {
  const m = parseModules(testSpec).find((x) => x.tag === 'Sessions');
  if (!m) throw new Error('Sessions module missing');
  return m;
};

describe('SubResourceTabs', () => {
  test('renders status cells as badges', async () => {
    server.use(
      http.get('*/api/v1/agents/:agent_id/sessions', () =>
        HttpResponse.json([
          { id: 'ses_1', name: 'Session One', status: 'completed' },
        ])
      )
    );

    renderWithAuth(
      <SubResourceTabs
        subResources={[sessionsModule()]}
        pathParams={{ agent_id: 'agt_1' }}
        token="test-token"
      />
    );

    await userEvent.click(
      await screen.findByRole('button', { name: /sessions/i })
    );
    const badge = await screen.findByText('Completed');
    expect(badge).toHaveClass('rounded-full');
  });
});
