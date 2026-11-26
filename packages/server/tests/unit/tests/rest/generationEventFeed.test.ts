import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { app } from 'src/app';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { createScopedPrincipal } from '../../fixtures/bootstrap';
import { pollUntil } from '../../fixtures/poll';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient, testClient } from '../../testClient';

type Event = {
  seq: number;
  type: string;
  step_index: number | null;
  tool_call_id: string | null;
  step: {
    index: number;
    tool_calls: Array<{ tool_name: string | null }>;
  } | null;
};

type Frame = { id?: string; event?: string; data: string };

/** The frames of an SSE body, comments dropped. */
const framesOf = (text: string): Frame[] => {
  return text
    .split('\n\n')
    .map((block) => {
      const frame: Partial<Frame> = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        if (line.startsWith('event: ')) frame.event = line.slice(7);
        if (line.startsWith('data: ')) frame.data = line.slice(6);
      }
      return frame;
    })
    .filter((frame): frame is Frame => {
      return frame.data !== undefined;
    });
};

const TOOL_TURN_TYPES = [
  'generations.started',
  'generations.step_started',
  'generations.tool_call_started',
  'generations.tool_call_ended',
  'generations.step_ended',
  'generations.step_started',
  'generations.step_ended',
  'generations.completed',
];

/**
 * A generation's transcript, incrementally. Turns run for real against a
 * scripted model; only the model and the tools' HTTP target are fakes.
 */
describe('GET /api/v1/generations/:generation_id/events', () => {
  let turn: AgentToolTurn;
  let toolName: string;
  let agentId: string;
  let doneId: string;
  let noTraceToken: string;
  let noPermToken: string;

  const events = (id: string, query = '', token?: string) => {
    return authenticatedTestClient(token ?? turn.adminToken).get(
      `/api/v1/generations/${id}/events${query}`
    );
  };

  const runTurn = async (): Promise<string> => {
    const { id } = await turn.generate({
      agentId,
      calls: [{ name: toolName, args: { amount: 1 } }],
    });
    return id;
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'genevents' });
    const tool = await turn.createTool();
    toolName = tool.name;
    agentId = await turn.createAgent({ tool_bindings: [{ tool_id: tool.id }] });
    doneId = await runTurn();
    noTraceToken = await createScopedPrincipal({
      adminToken: turn.adminToken,
      projectId: turn.projectId,
      username: 'geneventsnotrace',
      actions: ['generations:GetGeneration'],
    });
    noPermToken = await createScopedPrincipal({
      adminToken: turn.adminToken,
      projectId: turn.projectId,
      username: 'geneventsnoperm',
      actions: ['agents:GetAgent'],
    });
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('as a page', () => {
    test('lists the rows in seq order, each ended step with its content', async () => {
      const res = await events(doneId);

      expect(res.status).toBe(200);
      expect(res.body.generation_id).toBe(doneId);
      expect(res.body.status).toBe('completed');
      expect(res.body.next_cursor).toBeNull();
      const data: Event[] = res.body.data;
      expect(
        data.map((event) => {
          return event.type;
        })
      ).toEqual(TOOL_TURN_TYPES);
      expect(
        data.map((event) => {
          return event.seq;
        })
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const ended = data.filter((event) => {
        return event.type === 'generations.step_ended';
      });
      expect(
        ended.map((event) => {
          return event.step?.index;
        })
      ).toEqual([0, 1]);
      expect(ended[0].step?.tool_calls[0].tool_name).toBe(toolName);
      expect(
        data
          .filter((event) => {
            return event.type !== 'generations.step_ended';
          })
          .every((event) => {
            return event.step === null;
          })
      ).toBe(true);
    });

    test('limit and cursor page through the rows', async () => {
      const first = await events(doneId, '?limit=3');
      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(3);
      expect(first.body.next_cursor).toEqual(expect.any(String));

      const second = await events(
        doneId,
        `?limit=3&cursor=${encodeURIComponent(first.body.next_cursor)}`
      );

      expect(second.status).toBe(200);
      expect(second.body.data[0].seq).toBe(4);
    });

    test('after_seq reads the rows after it', async () => {
      const res = await events(doneId, '?after_seq=5');

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((event: Event) => {
          return event.seq;
        })
      ).toEqual([6, 7, 8]);
    });

    test('Last-Event-ID is read as after_seq', async () => {
      const res = await authenticatedTestClient(turn.adminToken)
        .get(`/api/v1/generations/${doneId}/events`)
        .set('Last-Event-ID', '7');

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((event: Event) => {
          return event.seq;
        })
      ).toEqual([8]);
    });

    test.each(['-1', 'x', '1.5'])('after_seq=%s is 400', async (value) => {
      const res = await events(doneId, `?after_seq=${value}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a purged generation serves no step content', async () => {
      const id = await runTurn();
      const purge = await authenticatedTestClient(turn.adminToken).delete(
        `/api/v1/generations/${id}/content`
      );
      expect(purge.status).toBe(200);

      const res = await events(id);

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((event: Event) => {
          return event.type;
        })
      ).toEqual(TOOL_TURN_TYPES);
      expect(
        res.body.data.every((event: Event) => {
          return event.step === null;
        })
      ).toBe(true);
    });
  });

  describe('access', () => {
    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(`/api/v1/generations/${doneId}/events`);
      expect(res.status).toBe(401);
    });

    test('an unknown generation returns 404', async () => {
      const res = await events('gen_doesnotexist');
      expect(res.status).toBe(404);
    });

    test('a user without generations:GetGeneration gets 404', async () => {
      const res = await events(doneId, '', noPermToken);
      expect(res.status).toBe(404);
    });

    test('content without traces:GetTrace is 403', async () => {
      const res = await events(doneId, '', noTraceToken);
      expect(res.status).toBe(403);
    });

    test('progress_only serves the rows without traces:GetTrace', async () => {
      const res = await events(doneId, '?progress_only=true', noTraceToken);

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((event: Event) => {
          return event.type;
        })
      ).toEqual(TOOL_TURN_TYPES);
      expect(
        res.body.data.every((event: Event) => {
          return event.step === null;
        })
      ).toBe(true);
    });

    test('a stream without traces:GetTrace is 403 before it opens', async () => {
      const res = await events(doneId, '?stream=true', noTraceToken);
      expect(res.status).toBe(403);
    });
  });

  describe('as a stream', () => {
    test('serves each row as a progress frame and ends with [DONE]', async () => {
      const res = await events(doneId, '?stream=true');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      const frames = framesOf(res.text);
      expect(frames.at(-1)?.data).toBe('[DONE]');
      const progress = frames.slice(0, -1);
      expect(
        progress.map((frame) => {
          return [frame.event, frame.id];
        })
      ).toEqual(
        TOOL_TURN_TYPES.map((_, index) => {
          return ['progress', String(index + 1)];
        })
      );
      expect(JSON.parse(progress[4].data).step.index).toBe(0);
    });

    test('resumes after Last-Event-ID', async () => {
      const res = await authenticatedTestClient(turn.adminToken)
        .get(`/api/v1/generations/${doneId}/events?stream=true`)
        .set('Last-Event-ID', '6');

      expect(res.status).toBe(200);
      expect(
        framesOf(res.text).map((frame) => {
          return frame.id ?? frame.data;
        })
      ).toEqual(['7', '8', '[DONE]']);
    });

    test('follows a running generation until it settles', async () => {
      const held = turn.unique('held_refund');
      const tool = await turn.createTool({ name: held });
      const heldAgentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      turn.target.reply(`/${held}`, async () => {
        await released;
        return { body: { ok: true } };
      });

      const accepted = await turn
        .api()
        .post(`/api/v1/agents/${heldAgentId}/generate`)
        .send({
          messages: [proposeCalls([{ name: held, args: { amount: 1 } }])],
        });
      expect(accepted.status).toBe(202);
      const id: string = accepted.body.generation_id;
      const started = await pollUntil({
        read: async () => {
          return (await events(id, '?progress_only=true')).body.data as Event[];
        },
        done: (data) => {
          return data.some((event) => {
            return event.type === 'generations.tool_call_started';
          });
        },
      });
      const cursor = started.at(-1)?.seq;

      // A server of the test's own, so the stream is read as it arrives.
      const server = http.createServer(app.callback()).listen(0);
      try {
        const { port } = server.address() as AddressInfo;
        const body = await new Promise<string>((resolve, reject) => {
          const req = http.get(
            {
              host: '127.0.0.1',
              port,
              path: `/api/v1/generations/${id}/events?stream=true&after_seq=${cursor}`,
              headers: { Authorization: `Bearer ${turn.adminToken}` },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => {
                text += chunk;
              });
              res.on('end', () => {
                resolve(text);
              });
              // The stream is open and waiting: the call ends only now.
              release();
            }
          );
          req.on('error', reject);
        });

        const types = framesOf(body)
          .filter((frame) => {
            return frame.event === 'progress';
          })
          .map((frame) => {
            return (JSON.parse(frame.data) as Event).type;
          });
        expect(types).toContain('generations.tool_call_ended');
        expect(types.at(-1)).toBe('generations.completed');
        expect(framesOf(body).at(-1)?.data).toBe('[DONE]');
      } finally {
        release();
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    });
  });
});

describe('a streamed session or conversation turn', () => {
  let turn: AgentToolTurn;
  let agentId: string;
  let toolName: string;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'turnstream' });
    const tool = await turn.createTool();
    toolName = tool.name;
    agentId = await turn.createAgent({ tool_bindings: [{ tool_id: tool.id }] });
  });

  afterAll(async () => {
    await turn.close();
  });

  const expectTurnStream = (args: {
    text: string;
    handle: Record<string, string>;
  }) => {
    const frames = framesOf(args.text);
    expect(frames[0].event).toBe('accepted');
    const accepted = JSON.parse(frames[0].data);
    expect(accepted).toMatchObject({ status: 'accepted', ...args.handle });
    expect(accepted.generation_id).toMatch(/^gen_/);
    const progress = frames
      .filter((frame) => {
        return frame.event === 'progress';
      })
      .map((frame) => {
        return JSON.parse(frame.data) as Event;
      });
    expect(
      progress.map((event) => {
        return event.type;
      })
    ).toEqual(expect.arrayContaining(['generations.tool_call_ended']));
    expect(progress.at(-1)?.type).toBe('generations.completed');
    expect(frames.at(-1)?.data).toBe('[DONE]');
    return progress;
  };

  const calls = () => {
    return JSON.stringify({ calls: [{ name: toolName, args: { amount: 1 } }] });
  };

  describe('POST /api/v1/sessions/:session_id/generate', () => {
    const openSession = async (): Promise<string> => {
      const session = await turn
        .api()
        .post('/api/v1/sessions')
        .send({ agent_id: agentId });
      expect(session.status).toBe(201);
      const message = await turn
        .api()
        .post(`/api/v1/sessions/${session.body.id}/messages`)
        .send({ message: calls() });
      expect(message.status).toBe(201);
      return session.body.id;
    };

    test('stream serves the accepted handle, then the turn at step granularity', async () => {
      const sessionId = await openSession();

      const res = await turn
        .api()
        .post(`/api/v1/sessions/${sessionId}/generate`)
        .send({ stream: true });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      const progress = expectTurnStream({
        text: res.text,
        handle: { session_id: sessionId },
      });
      const ended = progress.find((event) => {
        return event.type === 'generations.step_ended';
      });
      expect(ended?.step?.tool_calls[0].tool_name).toBe(toolName);
    });

    test('stream with wait=false is 400', async () => {
      const sessionId = await openSession();

      const res = await turn
        .api()
        .post(`/api/v1/sessions/${sessionId}/generate?wait=false`)
        .send({ stream: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/conversations/:conversation_id/generate', () => {
    test('stream serves the accepted handle, then the turn', async () => {
      const conversation = await turn
        .api()
        .post('/api/v1/conversations')
        .send({ project_id: turn.projectId });
      expect(conversation.status).toBe(201);
      const message = await turn
        .api()
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .send({ message: calls(), role: 'user' });
      expect(message.status).toBe(201);

      const res = await turn
        .api()
        .post(`/api/v1/conversations/${conversation.body.id}/generate`)
        .send({ agent_id: agentId, stream: true });

      expect(res.status).toBe(200);
      expectTurnStream({
        text: res.text,
        handle: { conversation_id: conversation.body.id },
      });
    });
  });
});
