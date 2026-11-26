import { db } from 'src/db';
import { pendingGenerations } from 'src/lib/agentGenerationHelpers';

import {
  type AgentToolTurn,
  type GenerationBody,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { pollUntil } from '../../fixtures/poll';
import { proposeSteps, type ScriptedCall } from '../../fixtures/scriptedModel';

// `runtime.generations.*` counts the results that entered a turn's context. The
// scripted model proposes `steps[n]` in its n-th step and answers with every
// result it got back, so `results` is what each call returned, in order.

const UNTRUSTED = 'runtime.generations.untrusted_tool_results.total';
const KNOWLEDGE = 'runtime.generations.knowledge_results.total';

/** Sign-off once the turn has read anything the key counts. */
const holdAfter = (key: string) => {
  return {
    default_class: 'C',
    class: { if: [{ '>': [{ var: key }, 0] }, 'C', 'A'] },
  };
};

const OK = { ok: true };
const PENDING = expect.objectContaining({ status: 'pending_approval' });

describe('runtime.generations.* — what the turn has read', () => {
  let turn: AgentToolTurn;

  /** A read tool and a write tool the provenance guardrail holds. */
  const readerAndWriter = async (
    args: {
      read?: Record<string, unknown>;
      key?: string;
      agent?: Record<string, unknown>;
    } = {}
  ) => {
    const read = await turn.createTool(args.read);
    const guardrailId = await turn.createGuardrail(
      holdAfter(args.key ?? UNTRUSTED)
    );
    const write = await turn.createTool({ guardrail_ids: [guardrailId] });
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: read.id }, { tool_id: write.id }],
      ...args.agent,
    });
    return { read, write, agentId };
  };

  const call = (tool: { name: string }): ScriptedCall => {
    return { name: tool.name, args: { amount: 1 } };
  };

  const startSteps = (args: {
    agentId: string;
    steps: ScriptedCall[][];
    before?: object[];
  }): Promise<GenerationBody> => {
    return turn.startTurn({
      agentId: args.agentId,
      calls: [],
      body: { messages: [...(args.before ?? []), proposeSteps(args.steps)] },
    });
  };

  const runSteps = async (args: {
    agentId: string;
    steps: ScriptedCall[][];
    before?: object[];
  }) => {
    const body = await startSteps(args);
    expect(body.status).toBe('completed');
    return {
      id: body.id,
      results: JSON.parse(body.output?.content ?? '[]') as unknown[],
    };
  };

  const storedCounts = async (generationId: string) => {
    const row = await db.Generation.findOne({
      where: { publicId: generationId },
      attributes: ['untrustedToolResults', 'knowledgeResults'],
      rejectOnEmpty: true,
    });
    return {
      untrusted: row.untrustedToolResults,
      knowledge: row.knowledgeResults,
    };
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'provenance' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('server-executed results', () => {
    test('a write proposed before the untrusted read executes', async () => {
      const { read, write, agentId } = await readerAndWriter();

      const { results } = await runSteps({
        agentId,
        steps: [[call(write)], [call(read)]],
      });

      expect(results).toEqual([OK, OK]);
    });

    test('a write proposed in a later step than an untrusted read files an approval', async () => {
      const { read, write, agentId } = await readerAndWriter();

      const { id, results } = await runSteps({
        agentId,
        steps: [[call(read)], [call(write)]],
      });

      expect(results).toEqual([OK, PENDING]);
      expect(turn.target.bodiesAt(`/${write.name}`)).toEqual([]);
      expect(await storedCounts(id)).toEqual({ untrusted: 1, knowledge: 0 });
    });

    test('a read tool declared trusted lets the write execute', async () => {
      const { read, write, agentId } = await readerAndWriter({
        read: { trusted_output: true },
      });

      const { results } = await runSteps({
        agentId,
        steps: [[call(read)], [call(write)]],
      });

      expect(results).toEqual([OK, OK]);
    });

    test('a write proposed in the same step as the read executes', async () => {
      const { read, write, agentId } = await readerAndWriter();

      const { results } = await runSteps({
        agentId,
        steps: [[call(read), call(write)]],
      });

      expect(results).toEqual([OK, OK]);
    });

    test('a call the gate holds counts nothing', async () => {
      const held = await turn.createTool({
        guardrail_ids: [await turn.createGuardrail({ class: 'C' })],
      });
      const write = await turn.createTool({
        guardrail_ids: [await turn.createGuardrail(holdAfter(UNTRUSTED))],
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: held.id }, { tool_id: write.id }],
      });

      const { results } = await runSteps({
        agentId,
        steps: [[call(held)], [call(write)]],
      });

      expect(results).toEqual([PENDING, OK]);
    });

    test('the counts hold with trace_content_mode none', async () => {
      const { read, write, agentId } = await readerAndWriter({
        agent: { trace_content_mode: 'none' },
      });

      const { id, results } = await runSteps({
        agentId,
        steps: [[call(read)], [call(write)]],
      });

      expect(results).toEqual([OK, PENDING]);
      expect(await storedCounts(id)).toEqual({ untrusted: 1, knowledge: 0 });
    });
  });

  describe('builtin tools', () => {
    test("a sub-agent's answer counts by the calling builtin tool's flag", async () => {
      const childAgentId = await turn.createAgent({});
      const askTool = (trusted: boolean) => {
        return {
          type: 'builtin',
          execute: undefined,
          parameters: undefined,
          actions: ['create-agent-generation'],
          preset_parameters: { agent_id: childAgentId },
          trusted_output: trusted,
        };
      };
      const ask = (tool: { name: string }): ScriptedCall => {
        return {
          name: `${tool.name}_create-agent-generation`,
          args: { messages: [{ role: 'user', content: 'hello' }] },
        };
      };
      const untrusted = await readerAndWriter({ read: askTool(false) });
      const trusted = await readerAndWriter({ read: askTool(true) });

      const held = await runSteps({
        agentId: untrusted.agentId,
        steps: [[ask(untrusted.read)], [call(untrusted.write)]],
      });
      const released = await runSteps({
        agentId: trusted.agentId,
        steps: [[ask(trusted.read)], [call(trusted.write)]],
      });

      expect(held.results[1]).toEqual(PENDING);
      expect(released.results[1]).toEqual(OK);
    });

    test('a get-document result counts as knowledge even from a trusted tool', async () => {
      const document = await turn
        .api()
        .post('/api/v1/documents')
        .send({
          project_id: turn.projectId,
          content: 'Refunds take 14 days.',
          path: `/${turn.unique('provenance')}.md`,
        });
      expect(document.status).toBe(201);
      const getDocument = {
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        actions: ['get-document'],
        trusted_output: true,
      };
      const byKnowledge = await readerAndWriter({
        read: getDocument,
        key: KNOWLEDGE,
      });
      const byUntrusted = await readerAndWriter({ read: getDocument });
      const read = (tool: { name: string }): ScriptedCall => {
        return {
          name: `${tool.name}_get-document`,
          args: { document_id: document.body.id },
        };
      };

      const held = await runSteps({
        agentId: byKnowledge.agentId,
        steps: [[read(byKnowledge.read)], [call(byKnowledge.write)]],
      });
      const released = await runSteps({
        agentId: byUntrusted.agentId,
        steps: [[read(byUntrusted.read)], [call(byUntrusted.write)]],
      });

      expect(held.results[1]).toEqual(PENDING);
      expect(released.results[1]).toEqual(OK);
    });
  });

  describe('content the turn starts with', () => {
    let documentId: string;

    beforeAll(async () => {
      const document = await turn
        .api()
        .post('/api/v1/documents')
        .send({
          project_id: turn.projectId,
          content: 'Refunds are issued within 14 days.',
          path: `/${turn.unique('provenance-knowledge')}.md`,
        });
      expect(document.status).toBe(201);
      documentId = document.body.id;
    });

    test('a knowledge_config injection counts as knowledge, not as a tool result', async () => {
      const knowledge = { knowledge_config: { document_ids: [documentId] } };
      const byKnowledge = await readerAndWriter({
        key: KNOWLEDGE,
        agent: knowledge,
      });
      const byUntrusted = await readerAndWriter({ agent: knowledge });

      const held = await runSteps({
        agentId: byKnowledge.agentId,
        steps: [[call(byKnowledge.write)]],
      });
      const released = await runSteps({
        agentId: byUntrusted.agentId,
        steps: [[call(byUntrusted.write)]],
      });

      expect(held.results).toEqual([PENDING]);
      expect(released.results).toEqual([OK]);
      expect(await storedCounts(held.id)).toEqual({
        untrusted: 0,
        knowledge: 1,
      });
    });

    test('a document message block counts as knowledge', async () => {
      const { write, agentId } = await readerAndWriter({ key: KNOWLEDGE });

      const { results } = await runSteps({
        agentId,
        before: [
          {
            role: 'user',
            content: { type: 'document', document_id: documentId },
          },
        ],
        steps: [[call(write)]],
      });

      expect(results).toEqual([PENDING]);
    });

    test("a tool_output message block counts by its tool's flag", async () => {
      const { read, write, agentId } = await readerAndWriter();

      const { results } = await runSteps({
        agentId,
        before: [
          {
            role: 'user',
            content: {
              type: 'tool_output',
              tool_id: read.id,
              input: { amount: 1 },
            },
          },
        ],
        steps: [[call(write)]],
      });

      expect(results).toEqual([PENDING]);
    });
  });

  describe('across a pause', () => {
    /** A turn that pauses on a client tool, optionally after an untrusted read. */
    const clientTurn = async (args: {
      trusted: boolean;
      readFirst: boolean;
    }) => {
      const read = await turn.createTool();
      const client = await turn.createTool({
        type: 'client',
        execute: undefined,
        trusted_output: args.trusted,
      });
      const guardrailId = await turn.createGuardrail(holdAfter(UNTRUSTED));
      const write = await turn.createTool({ guardrail_ids: [guardrailId] });
      const agentId = await turn.createAgent({
        tool_bindings: [
          { tool_id: read.id },
          { tool_id: client.id },
          { tool_id: write.id },
        ],
      });
      const steps = [[call(client)], [call(write)]];
      const paused = await startSteps({
        agentId,
        steps: args.readFirst ? [[call(read)], ...steps] : steps,
      });
      expect(paused.status).toBe('requires_action');
      return { agentId, paused };
    };

    const submit = async (args: {
      agentId: string;
      paused: GenerationBody;
    }): Promise<unknown[]> => {
      const res = await turn
        .api()
        .post(
          `/api/v1/agents/${args.agentId}/generate/${args.paused.id}/tool-outputs`
        )
        .send({
          tool_outputs: [
            {
              tool_call_id: args.paused.required_action?.tool_calls[0].id,
              output: { ok: true },
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      return JSON.parse(res.body.output.content);
    };

    test('a submitted client output counts for the resumed segment', async () => {
      const paused = await clientTurn({ trusted: false, readFirst: false });

      expect(await submit(paused)).toEqual([OK, PENDING]);
    });

    test("a trusted client tool's output does not count", async () => {
      const paused = await clientTurn({ trusted: true, readFirst: false });

      expect(await submit(paused)).toEqual([OK, OK]);
    });

    test('what the turn read before the pause still counts after it', async () => {
      const paused = await clientTurn({ trusted: true, readFirst: true });

      expect(await submit(paused)).toEqual([OK, OK, PENDING]);
    });

    test('the count holds across generation recovery', async () => {
      const paused = await clientTurn({ trusted: true, readFirst: true });
      pendingGenerations.delete(paused.paused.id);

      expect(await submit(paused)).toEqual([OK, OK, PENDING]);
    });

    test('an approval continuation starts from what its chain had read', async () => {
      const { read, write, agentId } = await readerAndWriter();
      const { id, results } = await runSteps({
        agentId,
        steps: [[call(read)], [call(write)]],
      });
      const approvalId = (results[1] as { approval_id: string }).approval_id;

      const approved = await turn
        .api()
        .post(`/api/v1/approvals/${approvalId}/approve`)
        .send({});
      expect(approved.status).toBe(200);

      const continuation = await pollUntil({
        read: () => {
          return db.Generation.findOne({ where: { rootGenerationId: id } });
        },
        done: (found) => {
          return found !== null;
        },
      });
      // The read, plus the approved write's own result.
      expect(continuation).toMatchObject({
        untrustedToolResults: 2,
        knowledgeResults: 0,
      });
    });
  });

  describe('outside a generation', () => {
    test('a direct call cannot resolve the keys and fails closed', async () => {
      const { write } = await readerAndWriter();

      const res = await turn
        .api()
        .post(`/api/v1/tools/${write.id}/call`)
        .send({ input: { amount: 1 } });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TOOL_DISPATCH_FAILED');
      expect(res.body.error.meta.outcome).toBe('route_to_approval');
    });

    test('an unserved generations key is refused at write time', async () => {
      const res = await turn
        .api()
        .post('/api/v1/guardrails')
        .send({
          project_id: turn.projectId,
          name: turn.unique('gate'),
          document: holdAfter('runtime.generations.untrusted_tool_results.24h'),
        });

      expect(res.status).toBe(400);
    });
  });
});
