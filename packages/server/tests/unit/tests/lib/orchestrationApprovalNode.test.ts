import { executeApprovalNode } from 'src/lib/orchestrationApprovalNode';
import type { OrchestrationNode } from 'src/lib/orchestrations';

// executeApprovalNode is a pure mapping-resolver: its branch space (present vs
// absent reasoning/evidence/impact, default vs explicit expiry, non-object
// coercion, missing tool_id) is large and expensive to drive through a full
// orchestration run per case, so it is covered directly here. The end-to-end
// park → resolve → resume flow is covered via REST in rest/approvalNode.test.ts.

const base: OrchestrationNode = {
  id: 'gate',
  type: 'approval',
  toolId: 'tool_x',
};

const spec = (node: OrchestrationNode, state: Record<string, unknown>) => {
  const res = executeApprovalNode({ node, state });
  if (res.kind !== 'requires_action') {
    throw new Error(`expected requires_action, got ${res.kind}`);
  }
  return res;
};

describe('executeApprovalNode', () => {
  test('resolves every mapping and freezes the proposal', () => {
    const res = spec(
      {
        ...base,
        arguments: { amount: { var: 'input.amt' } },
        reasoning: 'needs review',
        evidence: { orderId: 'ord_1' },
        predictedImpact: 'issues a refund',
        expiresIn: 60,
        instructions: 'Please review',
      },
      { input: { amt: 500 } }
    );

    expect(res.type).toBe('approval');
    expect(res.nodeId).toBe('gate');
    expect(res.prompt).toBe('Please review');
    expect(res.approvalSpec).toEqual({
      toolId: 'tool_x',
      arguments: { amount: 500 },
      reasoning: 'needs review',
      evidence: { orderId: 'ord_1' },
      predictedImpact: 'issues a refund',
      expiresInSeconds: 60,
      policyVersion: null,
    });
  });

  test('defaults absent evidence/reasoning/impact to null and applies the 24h expiry', () => {
    const res = spec(base, {});
    expect(res.prompt).toBe('Approval required.');
    expect(res.approvalSpec).toEqual({
      toolId: 'tool_x',
      arguments: {},
      reasoning: null,
      evidence: null,
      predictedImpact: null,
      expiresInSeconds: 24 * 60 * 60,
      policyVersion: null,
    });
  });

  test('coerces a null-valued reasoning and a non-object evidence to null, and stringifies impact', () => {
    const res = spec(
      {
        ...base,
        reasoning: { var: 'input.missing' },
        evidence: 'not-an-object',
        predictedImpact: 42,
      },
      { input: {} }
    );
    expect(res.approvalSpec?.reasoning).toBeNull();
    expect(res.approvalSpec?.evidence).toBeNull();
    expect(res.approvalSpec?.predictedImpact).toBe('42');
  });

  test('ignores a non-positive expires_in and falls back to the default', () => {
    const res = spec({ ...base, expiresIn: 0 }, {});
    expect(res.approvalSpec?.expiresInSeconds).toBe(24 * 60 * 60);
  });

  test('throws when tool_id is missing', () => {
    expect(() => {
      return executeApprovalNode({
        node: { id: 'gate', type: 'approval' },
        state: {},
      });
    }).toThrow(/missing toolId/);
  });
});
