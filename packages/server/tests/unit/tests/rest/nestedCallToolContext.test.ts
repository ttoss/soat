import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * The `tool_context` a nested `builtin` `call-tool` reaches its tool with,
 * per key: the token's layer over the calling turn's bag over the call's own
 * arguments. A key only one of them sends is kept.
 */

type Layer = 'layer' | 'turn' | 'args';
type Bags = Partial<Record<Layer, Record<string, string>>>;

const CONTEXT_HEADER = 'x-soat-context-';

const BOUND = {
  statement: [{ effect: 'Allow', action: ['agents:*', 'tools:*'] }],
};

/** `k` names every layer present; `<layer>_only` is that layer's alone. */
const bagsOf = (layers: Layer[]): Bags => {
  return Object.fromEntries(
    layers.map((layer) => {
      return [layer, { k: layer, [`${layer}_only`]: layer }];
    })
  );
};

describe('nested call-tool tool_context layers', () => {
  let turn: AgentToolTurn;
  let tokenKey: string;
  let httpTool: { id: string; name: string };
  let relayTool: { id: string; name: string };
  let relayAgentId: string;

  const credential = async (layer?: Record<string, string>) => {
    if (!layer) return turn.api();
    const res = await authenticatedTestClient(tokenKey)
      .post('/api/v1/iam/tokens')
      .send({ policy: BOUND, tool_context: layer });
    expect(res.status).toBe(201);
    return authenticatedTestClient(res.body.token as string);
  };

  /** The context keys the one call to the http tool carried. */
  const contextSent = (): Record<string, unknown> => {
    const requests = turn.target.requestsAt(`/${httpTool.name}`);
    expect(requests).toHaveLength(1);
    return Object.fromEntries(
      Object.entries(requests[0].headers)
        .filter(([name]) => {
          return name.startsWith(CONTEXT_HEADER);
        })
        .map(([name, value]) => {
          return [name.slice(CONTEXT_HEADER.length), value];
        })
    );
  };

  const relay = async (bags: Bags) => {
    const client = await credential(bags.layer);
    const res = await client.post(`/api/v1/tools/${relayTool.id}/call`).send({
      action: 'call-tool',
      input: {
        input: { amount: 1 },
        ...(bags.args ? { tool_context: bags.args } : {}),
      },
      ...(bags.turn ? { tool_context: bags.turn } : {}),
    });
    expect(res.status).toBe(200);
    return contextSent();
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'nestedctx' });
    const policyId = await turn.createPolicy({
      statement: [
        {
          effect: 'Allow',
          action: ['agents:*', 'tools:*', 'iam:CreateToken'],
        },
      ],
    });
    const key = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: turn.unique('key'),
        project_id: turn.projectId,
        policy_ids: [policyId],
      });
    expect(key.status).toBe(201);
    tokenKey = key.body.key as string;
    httpTool = await turn.createTool();
    relayTool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['call-tool'],
      preset_parameters: { tool_id: httpTool.id },
    });
    relayAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: relayTool.id }],
    });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  test.each<[Layer[], Layer]>([
    [['layer'], 'layer'],
    [['turn'], 'turn'],
    [['args'], 'args'],
    [['layer', 'turn'], 'layer'],
    [['layer', 'args'], 'layer'],
    [['turn', 'args'], 'turn'],
    [['layer', 'turn', 'args'], 'layer'],
  ])(
    '%j: `k` is %s and each layer keeps its own key',
    async (layers, winner) => {
      const sent = await relay(bagsOf(layers));

      expect(sent).toMatchObject({
        k: winner,
        ...Object.fromEntries(
          layers.map((layer) => {
            return [`${layer}_only`, layer];
          })
        ),
      });
    }
  );

  test('the turn overrides an argument key in any casing', async () => {
    const sent = await relay({ turn: { k: 'turn' }, args: { K: 'args' } });

    expect(sent.k).toBe('turn');
  });

  test('an agent turn applies the same order', async () => {
    const bags = bagsOf(['layer', 'turn', 'args']);
    const client = await credential(bags.layer);
    const res = await client
      .post(`/api/v1/agents/${relayAgentId}/generate?wait=true`)
      .send({
        messages: [
          proposeCalls([
            {
              name: `${relayTool.name}_call-tool`,
              args: { input: { amount: 1 }, tool_context: bags.args },
            },
          ]),
        ],
        tool_context: bags.turn,
      });

    expect(res.status).toBe(200);
    expect(contextSent()).toMatchObject({
      k: 'layer',
      layer_only: 'layer',
      turn_only: 'turn',
      args_only: 'args',
    });
  });
});
