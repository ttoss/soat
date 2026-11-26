import { db } from 'src/db';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { pollUntil } from '../../fixtures/poll';
import type { ScriptedCall } from '../../fixtures/scriptedModel';

// A session turn starts `runtime.generations.*` from the messages it is sent:
// what an earlier turn read keeps counting while its messages are in the
// window, and stops once `max_context_messages` trims them.

const UNTRUSTED = 'runtime.generations.untrusted_tool_results.total';
const KNOWLEDGE = 'runtime.generations.knowledge_results.total';

const holdAfter = (key: string) => {
  return {
    default_class: 'C',
    class: { if: [{ '>': [{ var: key }, 0] }, 'C', 'A'] },
  };
};

const OK = { ok: true };
const PENDING = expect.objectContaining({ status: 'pending_approval' });

describe('session turns count what the messages they are sent carry', () => {
  let turn: AgentToolTurn;

  const readerAndWriter = async (key = UNTRUSTED) => {
    const read = await turn.createTool();
    const write = await turn.createTool({
      guardrail_ids: [await turn.createGuardrail(holdAfter(key))],
    });
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: read.id }, { tool_id: write.id }],
    });
    return { read, write, agentId };
  };

  const call = (tool: { name: string }): ScriptedCall => {
    return { name: tool.name, args: { amount: 1 } };
  };

  const openSession = async (args: {
    agentId: string;
    maxContextMessages?: number;
  }): Promise<string> => {
    const res = await turn.api().post('/api/v1/sessions').send({
      agent_id: args.agentId,
      max_context_messages: args.maxContextMessages,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const say = async (args: {
    sessionId: string;
    body: Record<string, unknown>;
  }) => {
    const res = await turn
      .api()
      .post(`/api/v1/sessions/${args.sessionId}/messages`)
      .send(args.body);
    expect(res.status).toBe(201);
  };

  /** One session turn whose model proposes `calls`, with its results. */
  const runTurn = async (args: {
    sessionId: string;
    calls: ScriptedCall[];
  }) => {
    await say({
      sessionId: args.sessionId,
      body: { message: JSON.stringify({ calls: args.calls }) },
    });
    const res = await turn
      .api()
      .post(`/api/v1/sessions/${args.sessionId}/generate?wait=true`)
      .send({});
    expect(res.status).toBe(200);
    return {
      generationId: res.body.generation_id as string,
      results: JSON.parse(res.body.content) as unknown[],
    };
  };

  const storedCounts = async (generationId: string) => {
    const row = await db.Generation.findOne({
      where: { publicId: generationId },
      rejectOnEmpty: true,
    });
    return {
      untrusted: row.untrustedToolResults,
      knowledge: row.knowledgeResults,
    };
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'sessprov' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  test('a write on a later turn than an untrusted read is held', async () => {
    const { read, write, agentId } = await readerAndWriter();
    const sessionId = await openSession({ agentId });

    expect((await runTurn({ sessionId, calls: [call(read)] })).results).toEqual(
      [OK]
    );
    const second = await runTurn({ sessionId, calls: [call(write)] });

    expect(second.results).toEqual([PENDING]);
    expect(turn.target.bodiesAt(`/${write.name}`)).toEqual([]);
    expect(await storedCounts(second.generationId)).toEqual({
      untrusted: 1,
      knowledge: 0,
    });
  });

  test('each message counts once, however many turns replay it', async () => {
    const { read, agentId } = await readerAndWriter();
    const sessionId = await openSession({ agentId });

    await runTurn({ sessionId, calls: [call(read)] });
    await runTurn({ sessionId, calls: [] });
    const third = await runTurn({ sessionId, calls: [] });

    expect(await storedCounts(third.generationId)).toEqual({
      untrusted: 1,
      knowledge: 0,
    });
  });

  test("an approval continuation counts its chain's reads once", async () => {
    const { read, write, agentId } = await readerAndWriter();
    const sessionId = await openSession({ agentId });
    await runTurn({ sessionId, calls: [call(read)] });
    const held = await runTurn({ sessionId, calls: [call(write)] });
    const { approval_id: approvalId } = held.results[0] as {
      approval_id: string;
    };

    const approved = await turn
      .api()
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .send({});
    expect(approved.status).toBe(200);

    const continuation = await pollUntil({
      read: () => {
        return db.Generation.findOne({
          where: { rootGenerationId: held.generationId, status: 'completed' },
        });
      },
      done: (found) => {
        return found !== null;
      },
    });
    // The replayed read, plus the approved write's own result.
    expect(continuation).toMatchObject({
      untrustedToolResults: 2,
      knowledgeResults: 0,
    });
  });

  test('a read trimmed out of the window no longer counts', async () => {
    const { read, write, agentId } = await readerAndWriter();
    const sessionId = await openSession({
      agentId,
      maxContextMessages: 1,
    });

    await runTurn({ sessionId, calls: [call(read)] });
    const second = await runTurn({ sessionId, calls: [call(write)] });

    expect(second.results).toEqual([OK]);
  });

  test('a document message counts as knowledge on the turn it is sent to', async () => {
    const document = await turn
      .api()
      .post('/api/v1/documents')
      .send({
        project_id: turn.projectId,
        content: 'Refunds are issued within 14 days.',
        path: `/${turn.unique('sessprov')}.md`,
      });
    expect(document.status).toBe(201);
    const { write, agentId } = await readerAndWriter(KNOWLEDGE);
    const sessionId = await openSession({ agentId });

    await say({ sessionId, body: { document_id: document.body.id } });
    const { results } = await runTurn({ sessionId, calls: [call(write)] });

    expect(results).toEqual([PENDING]);
  });

  test('a fork keeps what its copied messages count', async () => {
    const { read, write, agentId } = await readerAndWriter();
    const sessionId = await openSession({ agentId });
    await runTurn({ sessionId, calls: [call(read)] });

    const fork = await turn
      .api()
      .post(`/api/v1/sessions/${sessionId}/fork`)
      .send({});
    expect(fork.status).toBe(201);
    const { results } = await runTurn({
      sessionId: fork.body.id,
      calls: [call(write)],
    });

    expect(results).toEqual([PENDING]);
  });
});
