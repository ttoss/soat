import {
  buildResolverApprovalContext,
  computeToolCallDedupKey,
  evaluateApprovalEffect,
  injectApprovalJustificationSchema,
  policyCanRequireApproval,
  resolvedActionName,
  stripApprovalJustification,
} from 'src/lib/agentToolApproval';
import type { ToolApprovalPolicy } from 'src/lib/agentToolBindings';

// Pure policy/dedup/schema logic — a large input space that would be expensive
// and low-resolution to drive through a full generation, so it is covered
// directly (tests.md keep-list rule 1). The dispatch-path wiring is covered
// through generation in the rest suite.

describe('agentToolApproval', () => {
  describe('evaluateApprovalEffect', () => {
    test('returns the default when there are no rules', () => {
      const policy: ToolApprovalPolicy = { default: 'require_approval' };
      expect(
        evaluateApprovalEffect({ policy, action: 'send', arguments: {} })
      ).toBe('require_approval');
    });

    test('first matching rule wins over the default', () => {
      const policy: ToolApprovalPolicy = {
        default: 'require_approval',
        rules: [
          {
            when: { '<': [{ var: 'arguments.amount' }, 100] },
            effect: 'allow',
          },
          { when: { '==': [{ var: 'action' }, 'send'] }, effect: 'deny' },
        ],
      };
      expect(
        evaluateApprovalEffect({
          policy,
          action: 'send',
          arguments: { amount: 50 },
        })
      ).toBe('allow');
      expect(
        evaluateApprovalEffect({
          policy,
          action: 'send',
          arguments: { amount: 500 },
        })
      ).toBe('deny');
    });

    test('matches on the resolved action name', () => {
      const policy: ToolApprovalPolicy = {
        default: 'allow',
        rules: [
          {
            when: { '==': [{ var: 'action' }, 'delete-document'] },
            effect: 'require_approval',
          },
        ],
      };
      expect(
        evaluateApprovalEffect({
          policy,
          action: 'delete-document',
          arguments: {},
        })
      ).toBe('require_approval');
      expect(
        evaluateApprovalEffect({
          policy,
          action: 'get-document',
          arguments: {},
        })
      ).toBe('allow');
    });
  });

  describe('policyCanRequireApproval', () => {
    test('true when the default requires approval', () => {
      expect(policyCanRequireApproval({ default: 'require_approval' })).toBe(
        true
      );
    });

    test('true when any rule requires approval', () => {
      expect(
        policyCanRequireApproval({
          default: 'allow',
          rules: [{ when: { var: 'x' }, effect: 'require_approval' }],
        })
      ).toBe(true);
    });

    test('false when the policy only allows and denies', () => {
      expect(
        policyCanRequireApproval({
          default: 'allow',
          rules: [{ when: { var: 'x' }, effect: 'deny' }],
        })
      ).toBe(false);
    });
  });

  describe('resolvedActionName', () => {
    test('strips the tool-name prefix for soat tools', () => {
      expect(
        resolvedActionName({
          type: 'soat',
          toolName: 'docs',
          key: 'docs_update-document',
        })
      ).toBe('update-document');
    });

    test('uses the entry key as-is for mcp and other types', () => {
      expect(
        resolvedActionName({ type: 'mcp', toolName: 'gh', key: 'create_issue' })
      ).toBe('create_issue');
      expect(
        resolvedActionName({ type: 'http', toolName: 'refund', key: 'refund' })
      ).toBe('refund');
    });
  });

  describe('stripApprovalJustification', () => {
    test('separates justification fields from executed arguments', () => {
      const result = stripApprovalJustification({
        amount: 500,
        approval_reasoning: 'over threshold',
        approval_evidence: { orderId: 'ord_1' },
        approval_predicted_impact: 'refunds $500',
      });
      expect(result.cleanArgs).toEqual({ amount: 500 });
      expect(result.reasoning).toBe('over threshold');
      expect(result.evidence).toEqual({ orderId: 'ord_1' });
      expect(result.predictedImpact).toBe('refunds $500');
    });

    test('degrades wrong-typed justification values to null', () => {
      const result = stripApprovalJustification({
        approval_reasoning: 42,
        approval_evidence: 'not an object',
      });
      expect(result.reasoning).toBeNull();
      expect(result.evidence).toBeNull();
      expect(result.predictedImpact).toBeNull();
    });
  });

  describe('injectApprovalJustificationSchema', () => {
    test('adds the three optional fields without making them required', () => {
      const injected = injectApprovalJustificationSchema({
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
      });
      const props = injected.properties as Record<string, unknown>;
      expect(props.amount).toEqual({ type: 'number' });
      expect(props.approval_reasoning).toBeDefined();
      expect(props.approval_evidence).toBeDefined();
      expect(props.approval_predicted_impact).toBeDefined();
      expect(injected.required).toEqual(['amount']);
    });

    test('folds a custom reasoning_prompt into the guidance', () => {
      const injected = injectApprovalJustificationSchema(
        { type: 'object', properties: {} },
        'Cite the policy that permits this.'
      );
      const props = injected.properties as Record<
        string,
        { description: string }
      >;
      expect(props.approval_reasoning.description).toContain(
        'Cite the policy that permits this.'
      );
    });

    test('tolerates a missing base schema', () => {
      const injected = injectApprovalJustificationSchema(null);
      expect(injected.type).toBe('object');
      expect(
        (injected.properties as Record<string, unknown>).approval_reasoning
      ).toBeDefined();
    });
  });

  describe('computeToolCallDedupKey', () => {
    const base = {
      projectId: 1,
      agentId: 'agent_1',
      toolId: 'tool_1',
      action: 'send',
    };

    test('is stable regardless of argument key order', () => {
      const a = computeToolCallDedupKey({
        ...base,
        arguments: { amount: 5, to: 'x' },
      });
      const b = computeToolCallDedupKey({
        ...base,
        arguments: { to: 'x', amount: 5 },
      });
      expect(a).toBe(b);
    });

    test('differs when the arguments differ', () => {
      const a = computeToolCallDedupKey({ ...base, arguments: { amount: 5 } });
      const b = computeToolCallDedupKey({ ...base, arguments: { amount: 6 } });
      expect(a).not.toBe(b);
    });

    test('differs across agents and actions', () => {
      const a = computeToolCallDedupKey({ ...base, arguments: {} });
      const b = computeToolCallDedupKey({
        ...base,
        agentId: 'agent_2',
        arguments: {},
      });
      expect(a).not.toBe(b);
    });
  });

  describe('buildResolverApprovalContext', () => {
    const ids = {
      agentId: 'agent_1',
      generationId: 'gen_1',
      projectId: 1,
      sessionId: 'sess_1',
    };

    test('returns undefined when no binding carries a policy', () => {
      expect(
        buildResolverApprovalContext({
          bindings: [{ toolId: 'tool_1' }, { tool: { name: 'inline' } }],
          ...ids,
        })
      ).toBeUndefined();
      expect(
        buildResolverApprovalContext({ bindings: null, ...ids })
      ).toBeUndefined();
    });

    test('maps reference policies by tool id and inline policies positionally', () => {
      const policy: ToolApprovalPolicy = { default: 'require_approval' };
      const ctx = buildResolverApprovalContext({
        bindings: [
          { toolId: 'tool_1', approvalPolicy: policy },
          { tool: { name: 'inline_a' } },
          { tool: { name: 'inline_b' }, approvalPolicy: policy },
        ],
        ...ids,
      });
      expect(ctx).toBeDefined();
      expect(ctx!.policyByToolId).toEqual({ tool_1: policy });
      expect(ctx!.inlinePolicies).toEqual([null, policy]);
      expect(ctx!.sessionId).toBe('sess_1');
    });
  });
});
