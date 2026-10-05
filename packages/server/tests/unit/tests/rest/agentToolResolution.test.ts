import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { offeredSchema, offeredToolNames } from '../../fixtures/scriptedModel';

// How an agent's bound `http` / `client` / inline tools resolve into what the
// model is offered and what a call sends. The scripted model proposes the
// calls and records what it was offered; the target records what was sent.

describe('POST /api/v1/agents/:agent_id/generate — tool resolution', () => {
  let turn: AgentToolTurn;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'toolresolve' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  const bindAgent = (
    toolIds: string[],
    extra: Record<string, unknown> = {}
  ) => {
    return turn.createAgent({
      tool_bindings: toolIds.map((toolId) => {
        return { tool_id: toolId };
      }),
      ...extra,
    });
  };

  describe('http tools', () => {
    test('a stored execute with no url fails the call without sending anything', async () => {
      const tool = await turn.createTool({ execute: { method: 'GET' } });
      const agentId = await bindAgent([tool.id]);

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: tool.name, args: {} }],
      });

      expect(JSON.stringify(results)).toContain(
        `Invalid HTTP tool execute config for ${tool.name}`
      );
      expect(turn.target.requestsAt(`/${tool.name}`)).toEqual([]);
    });

    test('output_mapping reshapes the result the model sees', async () => {
      const tool = await turn.createTool({
        output_mapping: { text: { var: 'output.body' } },
      });
      turn.target.reply(`/${tool.name}`, { body: { body: 'hello' } });
      const agentId = await bindAgent([tool.id]);

      const { results } = await turn.generate({
        agentId,
        calls: [{ name: tool.name, args: {} }],
      });

      expect(results).toEqual([{ text: 'hello' }]);
    });
  });

  // A preset is a pin, not a default: it is never offered to the model, and it
  // wins over whatever the model sends.
  describe('preset_parameters', () => {
    test('an http tool hides a preset key and pins it over the model value', async () => {
      const tool = await turn.createTool({
        parameters: {
          type: 'object',
          properties: {
            account_id: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['account_id', 'note'],
        },
        preset_parameters: { account_id: 'acct_pinned' },
      });
      const agentId = await bindAgent([tool.id]);

      await turn.generate({
        agentId,
        calls: [
          { name: tool.name, args: { account_id: 'acct_model', note: 'hi' } },
        ],
      });

      const schema = offeredSchema({ model: turn.model, toolName: tool.name });
      expect(schema?.properties).not.toHaveProperty('account_id');
      expect(schema?.required).toEqual(['note']);
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([
        { account_id: 'acct_pinned', note: 'hi' },
      ]);
    });

    test('a client tool hides a preset key and still hands the call to the caller', async () => {
      const tool = await turn.createTool({
        type: 'client',
        execute: undefined,
        parameters: {
          type: 'object',
          properties: {
            device_id: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['device_id', 'message'],
        },
        preset_parameters: { device_id: 'dev_pinned' },
      });
      const agentId = await bindAgent([tool.id]);

      const body = await turn.startTurn({
        agentId,
        calls: [{ name: tool.name, args: { message: 'hi' } }],
      });

      expect(body.status).toBe('requires_action');
      const schema = offeredSchema({ model: turn.model, toolName: tool.name });
      expect(schema?.properties).not.toHaveProperty('device_id');
      expect(schema?.required).toEqual(['message']);
    });

    describe('{{context:...}} in a preset', () => {
      const presetTool = (presetParameters: Record<string, unknown>) => {
        return turn.createTool({
          parameters: {
            type: 'object',
            properties: {
              adAccountId: { type: 'string' },
              metaAdAccountId: { type: 'integer' },
              note: { type: 'string' },
            },
          },
          preset_parameters: presetParameters,
        });
      };

      test("sends the turn's context value, retyped to the schema's type", async () => {
        const tool = await presetTool({
          adAccountId: '{{context:ocaAdAccountId}}',
          metaAdAccountId: '{{context:ocaMetaAccountId}}',
        });
        const agentId = await bindAgent([tool.id]);

        await turn.generate({
          agentId,
          calls: [
            {
              name: tool.name,
              args: { note: 'hello', adAccountId: 'act_someone_elses' },
            },
          ],
          body: {
            tool_context: {
              ocaAdAccountId: 'act_1330065197707199',
              ocaMetaAccountId: '1330065197707199',
            },
          },
        });

        expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([
          {
            note: 'hello',
            adAccountId: 'act_1330065197707199',
            metaAdAccountId: 1330065197707199,
          },
        ]);
      });

      test('a missing context key fails the call, sending nothing', async () => {
        const tool = await presetTool({
          adAccountId: '{{context:ocaAdAccountId}}',
        });
        const agentId = await bindAgent([tool.id]);

        const { results } = await turn.generate({
          agentId,
          calls: [{ name: tool.name, args: {} }],
          body: { tool_context: { ocaToken: 'tok' } },
        });

        expect(JSON.stringify(results)).toContain('ocaAdAccountId');
        expect(turn.target.requestsAt(`/${tool.name}`)).toEqual([]);
      });
    });
  });

  describe('inline tool bindings', () => {
    test('inline and persisted bindings are offered together', async () => {
      const persisted = await turn.createTool({
        type: 'client',
        execute: undefined,
      });
      const inlineName = turn.unique('inline');
      const agentId = await turn.createAgent({
        tool_bindings: [
          { tool_id: persisted.id },
          { tool: { name: inlineName, type: 'client' } },
        ],
      });

      await turn.generate({ agentId, calls: [] });

      expect(offeredToolNames(turn.model).sort()).toEqual(
        [inlineName, persisted.name].sort()
      );
    });

    test('an agent-scope guardrail gates inline http and client tools alike', async () => {
      const httpName = turn.unique('inline');
      const clientName = turn.unique('inline');
      const agentId = await turn.createAgent({
        guardrail_ids: [await turn.createGuardrail({ class: 'C' })],
        tool_bindings: [
          {
            tool: {
              name: httpName,
              type: 'http',
              execute: {
                url: `${turn.target.baseUrl}/${httpName}`,
                method: 'POST',
              },
            },
          },
          {
            tool: {
              name: clientName,
              type: 'client',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
              },
            },
          },
        ],
      });

      const { results } = await turn.generate({
        agentId,
        calls: [
          { name: httpName, args: {} },
          { name: clientName, args: { path: '/a' } },
        ],
      });

      expect(results).toEqual([
        expect.objectContaining({ status: 'pending_approval' }),
        expect.objectContaining({ status: 'pending_approval' }),
      ]);
      expect(turn.target.requestsAt(`/${httpName}`)).toEqual([]);
      // An http tool declared without parameters still offers the
      // justification fields a class-C call carries onto its approval.
      expect(
        offeredSchema({ model: turn.model, toolName: httpName })?.properties
      ).toHaveProperty('approval_reasoning');
    });
  });
});
