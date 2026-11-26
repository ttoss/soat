import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { pollFor, pollUntil } from '../../fixtures/poll';
import type { RecordedRequest } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * An event trigger whose tool writes back through the API: the tool server
 * forwards the causation header it received, so the write's event carries the
 * chain and the trigger is refused on its first recurrence.
 */

const CAUSATION_HEADER = 'x-soat-causation';

/** Bounds the loop when the chain is lost, so a failing run still ends. */
const MAX_WRITE_BACKS = 6;

type Firing = {
  status: string;
  error: Record<string, unknown> | null;
};

describe('an event trigger loop through a tool that writes via the API', () => {
  let turn: AgentToolTurn;
  let policyId: string;
  let seq = 0;

  /** Creates a document, forwarding the causation header a tool call carried. */
  const writeBack = async (request: Pick<RecordedRequest, 'headers'>) => {
    seq += 1;
    const write = authenticatedTestClient(turn.adminToken).post(
      '/api/v1/documents'
    );
    const causation = request.headers[CAUSATION_HEADER];
    if (typeof causation === 'string') write.set(CAUSATION_HEADER, causation);
    const res = await write.send({
      project_id: turn.projectId,
      content: `written back ${seq}`,
      path: `/evtloop/doc-${seq}.txt`,
    });
    expect(res.status).toBe(201);
  };

  /** A path on the target that writes back on each of its first calls. */
  const writingPath = (args: { mcp: boolean }) => {
    const path = `/${turn.unique('writer')}`;
    let calls = 0;
    turn.target.reply(path, async (body, request) => {
      if (args.mcp && body.method !== 'tools/call') {
        const result =
          body.method === 'tools/list' ? { tools: [{ name: 'write' }] } : {};
        return { body: { jsonrpc: '2.0', id: body.id, result } };
      }
      calls += 1;
      if (calls <= MAX_WRITE_BACKS) await writeBack(request);
      const done = { content: [{ type: 'text', text: '{"ok":true}' }] };
      return {
        body: args.mcp ? { jsonrpc: '2.0', id: body.id, result: done } : {},
      };
    });
    return path;
  };

  /** The settled firings, once `settled` have settled and, if set, one refused. */
  const firingsOf = (args: {
    triggerId: string;
    settled: number;
    refused?: boolean;
  }): Promise<Firing[]> => {
    return pollUntil({
      read: async () => {
        const res = await authenticatedTestClient(turn.adminToken).get(
          `/api/v1/trigger-firings?trigger_id=${args.triggerId}&limit=100`
        );
        expect(res.status).toBe(200);
        return [...(res.body.data as Firing[])].reverse().filter((firing) => {
          return firing.status === 'completed' || firing.status === 'failed';
        });
      },
      done: (settled) => {
        // A refusal settles while the firing that caused it still runs.
        const refused = settled.some((firing) => {
          return firing.status === 'failed';
        });
        return settled.length >= args.settled && (refused || !args.refused);
      },
    });
  };

  const loopExceptionFor = (triggerId: string) => {
    return pollFor({
      read: async () => {
        const res = await authenticatedTestClient(turn.adminToken).get(
          `/api/v1/exceptions?project_id=${turn.projectId}&kind=event_trigger_loop&limit=100`
        );
        expect(res.status).toBe(200);
        return res.body.data as Array<{ detail: Record<string, unknown> }>;
      },
      pick: (exceptions) => {
        return exceptions.find((exception) => {
          return exception.detail.trigger_id === triggerId;
        });
      },
    });
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'evtloop' });
    policyId = await turn.createPolicy({
      statement: [
        {
          effect: 'Allow',
          action: ['documents:GetDocument', 'tools:CallTool'],
          resource: ['*'],
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await turn.close();
  });

  test.each([
    { kind: 'http', mcp: false },
    { kind: 'mcp', mcp: true },
  ])(
    'through an $kind tool, the trigger is refused on its first recurrence',
    async ({ mcp }) => {
      const path = writingPath({ mcp });
      const url = `${turn.target.baseUrl}${path}`;
      const tool = await turn.createTool(
        mcp
          ? {
              type: 'mcp',
              execute: undefined,
              parameters: undefined,
              mcp: { url },
            }
          : { parameters: { type: 'object' }, execute: { url, method: 'POST' } }
      );
      const trigger = await turn
        .api()
        .post('/api/v1/triggers')
        .send({
          project_id: turn.projectId,
          name: turn.unique('evtloop'),
          type: 'event',
          events: ['documents.created'],
          target_type: 'tool',
          target_id: tool.id,
          ...(mcp ? { action: 'write' } : {}),
          policy_ids: [policyId],
        });
      expect(trigger.status).toBe(201);
      const triggerId = trigger.body.id as string;

      try {
        await writeBack({ headers: {} });

        const firings = await firingsOf({
          triggerId,
          settled: 2,
          refused: true,
        });
        expect(
          firings.map((firing) => {
            return firing.status;
          })
        ).toEqual(['completed', 'failed']);
        expect(firings[1].error).toMatchObject({
          code: 'TRIGGER_CAUSATION_LIMIT',
          meta: { reason: 'repeat', causation_chain: [triggerId] },
        });
        await loopExceptionFor(triggerId);
      } finally {
        await turn.api().delete(`/api/v1/triggers/${triggerId}`);
      }
    },
    120_000
  );

  test('an unsigned causation header starts a fresh chain', async () => {
    const tool = await turn.createTool({ parameters: { type: 'object' } });
    const trigger = await turn
      .api()
      .post('/api/v1/triggers')
      .send({
        project_id: turn.projectId,
        name: turn.unique('evtloop'),
        type: 'event',
        events: ['documents.created'],
        target_type: 'tool',
        target_id: tool.id,
        policy_ids: [policyId],
      });
    expect(trigger.status).toBe(201);
    const triggerId = trigger.body.id as string;

    try {
      await writeBack({ headers: { [CAUSATION_HEADER]: 'forged' } });

      const firings = await firingsOf({ triggerId, settled: 1 });
      expect(firings[0].status).toBe('completed');
    } finally {
      await turn.api().delete(`/api/v1/triggers/${triggerId}`);
    }
  }, 120_000);
});
