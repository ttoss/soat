import { db } from 'src/db';

import {
  type AgentToolTurn,
  AMOUNT_SCHEMA,
  pollUntil,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { assertGuardrailEvaluationDetail } from '../../fixtures/guardrailEvaluationDetail';
import { offeredProperties } from '../../fixtures/scriptedModel';

// An agent turn's tool calls run through the guardrail gate the resolver wraps
// around each bound tool. The scripted model proposes the calls a test names
// and answers with the results it got back, so `results` is exactly what each
// gated call returned to the model.

const BLOCKED = {
  status: 'blocked',
  reason: 'Blocked by a guardrail (class D).',
};

describe('POST /api/v1/agents/:agent_id/generate — tool guardrail gate', () => {
  let turn: AgentToolTurn;

  const auditEntriesFor = (
    guardrailId: string
  ): Promise<Array<Record<string, unknown>>> => {
    return pollUntil({
      read: async () => {
        const res = await turn.api().get('/api/v1/audit-log').query({
          project_id: turn.projectId,
          action: 'guardrails:Evaluate',
          resource_public_id: guardrailId,
        });
        expect(res.status).toBe(200);
        return res.body.data;
      },
      done: (entries) => {
        return entries.length > 0;
      },
    });
  };

  const getApproval = async (approvalId: string) => {
    const res = await turn.api().get(`/api/v1/approvals/${approvalId}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'agentgate' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('decisions', () => {
    test('a tool no guardrail applies to executes untouched', async () => {
      const tool = await turn.gatedTool({ documents: [] });

      const { results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 10 } }],
      });

      expect(results).toEqual([{ ok: true }]);
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([{ amount: 10 }]);
    });

    test('class A executes and records its evaluation against the turn', async () => {
      const tool = await turn.gatedTool({ documents: [{ class: 'A' }] });

      const { id, results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 10 } }],
      });

      expect(results).toEqual([{ ok: true }]);
      expect(turn.target.bodiesAt(`/${tool.name}`)).toHaveLength(1);
      // The evaluation table has no read route; it is the record the gate
      // writes for every decision, including a plain execute.
      const rows = await pollUntil({
        read: () => {
          return db.GuardrailEvaluation.findAll({
            where: { guardrailId: tool.guardrailIds[0] },
          });
        },
        done: (found) => {
          return found.length > 0;
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decision: 'execute', generationId: id });
    });

    test('class D blocks the call and audits the decision', async () => {
      const tool = await turn.gatedTool({ documents: [{ class: 'D' }] });

      const { id, results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 10 } }],
      });

      expect(results).toEqual([BLOCKED]);
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([]);

      const [entry] = await auditEntriesFor(tool.guardrailIds[0]);
      expect(entry).toBeDefined();
      expect(entry.principal_type).toBeNull();
      expect(entry.principal_id).toBeNull();
      expect(entry.resource_srn).toBe(
        `srn:${turn.projectId}:guardrail:${tool.guardrailIds[0]}`
      );
      assertGuardrailEvaluationDetail(entry.detail, 'snake');
      expect(entry.detail).toMatchObject({
        decision: 'blocked',
        guardrail_id: tool.guardrailIds[0],
        agent_id: tool.agentId,
        generation_id: id,
      });
    });

    test('class C files a tool_call approval and returns pending_approval', async () => {
      const tool = await turn.gatedTool({ documents: [{ class: 'C' }] });

      const { id, results } = await turn.generate({
        agentId: tool.agentId,
        calls: [
          {
            name: tool.name,
            args: { amount: 500, approval_reasoning: 'needs sign-off' },
          },
        ],
      });

      expect(results).toEqual([
        {
          status: 'pending_approval',
          approval_id: expect.stringMatching(/^apr_/),
          expires_at: expect.any(String),
        },
      ]);
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([]);

      const approvalId = results[0].approval_id as string;
      const approval = await getApproval(approvalId);
      expect(approval).toMatchObject({
        origin: 'tool_call',
        status: 'pending',
        reasoning: 'needs sign-off',
        proposed_action: {
          tool_id: tool.id,
          action: tool.name,
          arguments: { amount: 500 },
        },
        policy_version: `${tool.guardrailIds[0]}@1`,
        agent_id: tool.agentId,
        generation_id: id,
      });

      const [entry] = await auditEntriesFor(tool.guardrailIds[0]);
      expect(entry.detail).toMatchObject({
        decision: 'route_to_approval',
        approval_id: approvalId,
      });
    });

    test('a class-B guard that passes executes', async () => {
      const tool = await turn.gatedTool({
        documents: [
          { class: 'B', guard: { '<': [{ var: 'args.amount' }, 100] } },
        ],
      });

      const { results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 42 } }],
      });

      expect(results).toEqual([{ ok: true }]);
    });

    test('a failing class-B guard trips, files an exception and audits it', async () => {
      const tool = await turn.gatedTool({
        documents: [
          { class: 'B', guard: { '<': [{ var: 'args.amount' }, 100] } },
        ],
      });

      const { results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 999 } }],
      });

      expect(results).toEqual([
        { status: 'tripwire', reason: expect.stringContaining('tripwire') },
      ]);
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([]);

      const [entry] = await auditEntriesFor(tool.guardrailIds[0]);
      expect(entry.detail).toMatchObject({ decision: 'tripwire' });

      const version = `${tool.guardrailIds[0]}@1`;
      const exceptions = await pollUntil({
        read: async () => {
          const res = await turn
            .api()
            .get('/api/v1/exceptions')
            .query({ project_id: turn.projectId, kind: 'guardrail_tripwire' });
          expect(res.status).toBe(200);
          return res.body.data as Array<Record<string, unknown>>;
        },
        done: (items) => {
          return items.some((item) => {
            return item.guardrail_version === version;
          });
        },
      });
      const exception = exceptions.find((item) => {
        return item.guardrail_version === version;
      });
      expect(exception).toMatchObject({
        kind: 'guardrail_tripwire',
        agent_id: tool.agentId,
        orchestration_run_id: null,
        node_id: null,
      });
    });

    test('a failing class-B guard with escalate routes to approval', async () => {
      const tool = await turn.gatedTool({
        documents: [
          {
            class: 'B',
            guard: { '<': [{ var: 'args.amount' }, 100] },
            escalate: true,
          },
        ],
      });

      const { results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 999 } }],
      });

      expect(
        offeredProperties({ model: turn.model, toolName: tool.name })
      ).toHaveProperty('approval_reasoning');
      expect(results[0].status).toBe('pending_approval');
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([]);
    });

    test('scopes compose stricter-wins: an agent class C beats a tool class A', async () => {
      const agentGuardrail = await turn.createGuardrail({ class: 'C' });
      const tool = await turn.createTool({
        guardrail_ids: [await turn.createGuardrail({ class: 'A' })],
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
        guardrail_ids: [agentGuardrail],
      });

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: tool.name, args: { amount: 1 } }],
      });

      expect(results[0].status).toBe('pending_approval');
      const approval = await getApproval(results[0].approval_id as string);
      expect(approval.policy_version).toBe(`${agentGuardrail}@1`);
    });

    test('two identical class-C proposals share one pending approval', async () => {
      const tool = await turn.gatedTool({ documents: [{ class: 'C' }] });
      const call = { name: tool.name, args: { amount: 5 } };

      const first = await turn.generate({
        agentId: tool.agentId,
        calls: [call],
      });
      const second = await turn.generate({
        agentId: tool.agentId,
        calls: [call],
      });

      expect(second.results[0].approval_id).toBe(first.results[0].approval_id);
    });

    test('a guard reads windowed runtime.projects.* at evaluation time', async () => {
      const tool = await turn.gatedTool({
        documents: [
          {
            class: 'B',
            guard: { '<': [{ var: 'runtime.projects.tool_calls.24h' }, 1000] },
          },
        ],
      });

      const { results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 1 } }],
      });

      expect(results).toEqual([{ ok: true }]);
    });
  });

  describe('pinned preset parameters', () => {
    test('a class-C tool offers justification fields but never a pinned key', async () => {
      const tool = await turn.gatedTool({
        documents: [{ class: 'C' }],
        tool: { preset_parameters: { amount: 10 } },
      });

      await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: {} }],
      });

      const properties = offeredProperties({
        model: turn.model,
        toolName: tool.name,
      });
      expect(properties).toHaveProperty('approval_reasoning');
      expect(properties).not.toHaveProperty('amount');
    });

    test('the guard classifies the pinned value the call carries', async () => {
      const tool = await turn.gatedTool({
        documents: [
          { class: 'B', guard: { '<': [{ var: 'args.amount' }, 100] } },
        ],
        tool: { preset_parameters: { amount: 10 } },
      });

      const { results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 999 } }],
      });

      expect(results).toEqual([{ ok: true }]);
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([{ amount: 10 }]);
    });

    test('an approval freezes the pinned arguments the call would carry', async () => {
      const tool = await turn.gatedTool({
        documents: [{ class: 'C' }],
        tool: { preset_parameters: { amount: 500 } },
      });

      const { results } = await turn.generate({
        agentId: tool.agentId,
        calls: [{ name: tool.name, args: { amount: 1 } }],
      });

      const approval = await getApproval(results[0].approval_id as string);
      expect(approval.proposed_action.arguments).toEqual({ amount: 500 });
    });
  });

  describe('a served version naming a deleted guardrail', () => {
    // A guardrail cannot be deleted while a live row references it, but an
    // archived agent version still can, and a release serves that version's
    // `guardrail_ids` verbatim.
    test('the dangling reference fails closed to approval', async () => {
      const guardrailId = await turn.createGuardrail({ class: 'A' });
      const tool = await turn.createTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
        guardrail_ids: [guardrailId],
      });
      const detached = await turn
        .api()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ guardrail_ids: [] });
      expect(detached.status).toBe(200);
      const deleted = await turn
        .api()
        .delete(`/api/v1/guardrails/${guardrailId}`);
      expect(deleted.status).toBe(204);
      const release = await turn
        .api()
        .put(`/api/v1/agents/${agentId}/release`)
        .send({ stable_version: 1, canary_version: 2, canary_percent: 0 });
      expect(release.status).toBe(200);

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: tool.name, args: { amount: 1 } }],
      });

      expect(results[0].status).toBe('pending_approval');
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([]);
      const [entry] = await auditEntriesFor(guardrailId);
      expect(entry.detail).toMatchObject({
        decision: 'route_to_approval',
        guardrail_version: null,
        scope: 'agent',
      });
    });
  });

  describe('inline tool bindings', () => {
    test('an agent-scope guardrail gates an inline tool, filing under a synthetic id', async () => {
      const name = turn.unique('inline');
      const agentId = await turn.createAgent({
        guardrail_ids: [await turn.createGuardrail({ class: 'C' })],
        tool_bindings: [
          {
            tool: {
              name,
              type: 'http',
              parameters: AMOUNT_SCHEMA,
              execute: {
                url: `${turn.target.baseUrl}/${name}`,
                method: 'POST',
              },
            },
          },
        ],
      });

      const { results } = await turn.generate({
        agentId,
        calls: [{ name, args: { amount: 3 } }],
      });

      expect(results[0].status).toBe('pending_approval');
      expect(turn.target.bodiesAt(`/${name}`)).toEqual([]);
      const approval = await getApproval(results[0].approval_id as string);
      expect(approval.proposed_action).toEqual({
        tool_id: `inline:${name}`,
        action: name,
        arguments: { amount: 3 },
      });
    });
  });

  describe('activity feed', () => {
    const activityOf = async (args: {
      generationId: string;
      expected: number;
    }): Promise<Array<Record<string, unknown>>> => {
      return pollUntil({
        read: async () => {
          const res = await turn.api().get('/api/v1/activity').query({
            project_id: turn.projectId,
            kind: 'action_executed',
            generation_id: args.generationId,
          });
          expect(res.status).toBe(200);
          return res.body.data as Array<Record<string, unknown>>;
        },
        done: (entries) => {
          return entries.length >= args.expected;
        },
      });
    };

    test('only the call that executed records an action_executed entry', async () => {
      const executed = await turn.createTool();
      const blocked = await turn.createTool({
        guardrail_ids: [await turn.createGuardrail({ class: 'D' })],
      });
      const failing = await turn.createTool();
      turn.target.reply(`/${failing.name}`, {
        status: 500,
        body: { error: 'x' },
      });
      const agentId = await turn.createAgent({
        tool_bindings: [
          { tool_id: executed.id },
          { tool_id: blocked.id },
          { tool_id: failing.id },
        ],
      });

      const { id } = await turn.generate({
        agentId,
        calls: [
          { name: executed.name, args: { amount: 25 } },
          { name: blocked.name, args: { amount: 25 } },
          { name: failing.name, args: { amount: 25 } },
        ],
      });

      const entries = await activityOf({ generationId: id, expected: 1 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: 'action_executed',
        severity: 'info',
        agent_id: agentId,
        generation_id: id,
        ref_id: executed.id,
        orchestration_run_id: null,
        detail: expect.objectContaining({ action: executed.name }),
      });
      expect(entries[0].summary).toContain(executed.name);
    });

    test('an inline tool call records an entry with no tool ref', async () => {
      const name = turn.unique('inline');
      const agentId = await turn.createAgent({
        tool_bindings: [
          {
            tool: {
              name,
              type: 'http',
              parameters: AMOUNT_SCHEMA,
              execute: {
                url: `${turn.target.baseUrl}/${name}`,
                method: 'POST',
              },
            },
          },
        ],
      });

      const { id, results } = await turn.generate({
        agentId,
        calls: [{ name, args: { amount: 25 } }],
      });

      expect(results).toEqual([{ ok: true }]);
      const entries = await activityOf({ generationId: id, expected: 1 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        agent_id: agentId,
        ref_id: null,
        detail: expect.objectContaining({ action: name }),
      });
    });
  });
});
