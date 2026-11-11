import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { authenticatedTestClient } from '../../testClient';

/**
 * A tool that declares `parameters` takes only input that satisfies them:
 * anything else is `400 VALIDATION_FAILED` before a guardrail or a dispatch.
 * A `pipeline` tool's `parameters` are what its callers send, so it narrows
 * the tool its steps call.
 */

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
};

describe('tool input validation', () => {
  let turn: AgentToolTurn;

  const call = (args: { toolId: string; input: Record<string, unknown> }) => {
    return authenticatedTestClient(turn.adminToken)
      .post(`/api/v1/tools/${args.toolId}/call`)
      .send({ input: args.input });
  };

  /** A pipeline taking `{ message }` and posting it as a chat message. */
  const messagePipeline = async () => {
    const target = await turn.createTool({
      parameters: { type: 'object' },
    });
    const pipeline = await turn.createTool({
      type: 'pipeline',
      execute: undefined,
      parameters: MESSAGE_SCHEMA,
      pipeline: {
        steps: [
          {
            id: 'send',
            tool_id: target.id,
            input: {
              messages: [{ role: 'user', content: { var: 'input.message' } }],
            },
          },
        ],
      },
    });
    return { target, pipeline };
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'toolinput' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('POST /api/v1/tools/:tool_id/call', () => {
    test('an http tool refuses input its parameters reject, before dispatch', async () => {
      const tool = await turn.createTool();

      const res = await call({ toolId: tool.id, input: { amount: 'ten' } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain('/amount');
      expect(turn.target.requestsAt(`/${tool.name}`)).toHaveLength(0);
    });

    test('an http tool runs input its parameters accept', async () => {
      const tool = await turn.createTool();

      const res = await call({ toolId: tool.id, input: { amount: 10 } });

      expect(res.status).toBe(200);
      expect(turn.target.bodiesAt(`/${tool.name}`)).toEqual([{ amount: 10 }]);
    });

    test('a preset fills a required parameter the caller leaves out', async () => {
      const tool = await turn.createTool({
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            currency: { type: 'string' },
          },
          required: ['amount', 'currency'],
        },
        preset_parameters: { currency: 'BRL' },
      });

      const res = await call({ toolId: tool.id, input: { amount: 10 } });

      expect(res.status).toBe(200);
    });

    test('a pipeline maps its own input onto the step it calls', async () => {
      const { target, pipeline } = await messagePipeline();

      const res = await call({
        toolId: pipeline.id,
        input: { message: 'hello' },
      });

      expect(res.status).toBe(200);
      expect(turn.target.bodiesAt(`/${target.name}`)).toEqual([
        { messages: [{ role: 'user', content: 'hello' }] },
      ]);
    });

    test('a pipeline refuses a message that is not text, before its steps', async () => {
      const { target, pipeline } = await messagePipeline();

      const res = await call({
        toolId: pipeline.id,
        input: { message: { type: 'document', document_id: 'doc_x' } },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain('/message must be string');
      expect(turn.target.requestsAt(`/${target.name}`)).toHaveLength(0);
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('a model call its tool parameters reject never reaches the tool', async () => {
      const tool = await turn.createTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });

      await turn.startTurn({
        agentId,
        calls: [{ name: tool.name, args: { amount: 'ten' } }],
      });

      expect(turn.target.requestsAt(`/${tool.name}`)).toHaveLength(0);
    });
  });
});
