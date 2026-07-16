import { applyInputMapping } from './jsonLogicMapping';
import type { NodeExecutionResult } from './orchestrationNodeExecutors';
import type { OrchestrationNode } from './orchestrations';

/**
 * Executes a `webhook` node. A webhook node parks the run awaiting an inbound
 * callback (`mode: receive`): it returns a `requires_action` the engine records,
 * and the run resumes when the callback is submitted via human-input.
 *
 * Outbound notification is deliberately **not** a webhook-node concern. To send
 * something out of a graph, use an `emit_event` node: it emits an internal
 * event that any Webhook subscription in the project delivers (signed, retried,
 * tracked) — so the graph never holds a URL or secret of its own.
 */
export const executeWebhookNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  const context = applyInputMapping(node.inputMapping, state);
  return {
    kind: 'requires_action',
    type: 'webhook_receive',
    nodeId: node.id,
    prompt: 'Waiting for webhook callback.',
    context,
  };
};
