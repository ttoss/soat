import { emitCustomEvent, resolveProjectPublicId } from './eventBus';
import { applyInputMapping } from './jsonLogicMapping';
import { requireNodeField } from './orchestrationNodeFields';
import type { NodeExecutionResult } from './orchestrationNodeTypes';
import type { OrchestrationNode } from './orchestrations';

/**
 * Executes an `emit_event` node: emits an internal domain event of type
 * `eventType` carrying the input-mapped payload as the event `data`. It sends
 * nothing itself — a Webhook subscribed to that event type (in the run's
 * project) delivers it, so signing, retry, delivery tracking, and policy gating
 * are all the Webhooks module's job, not the graph's.
 *
 * Reactive and fire-and-forget, exactly like the run's own lifecycle events:
 * the node completes as soon as the event is emitted and the run neither blocks
 * on nor fails from any subscriber's delivery outcome. (For a synchronous call
 * whose failure must fail the run, use an `http` tool node instead.)
 */
export const executeEmitEventNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectId?: number;
  runPublicId?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectId, runPublicId } = args;
  const eventType = requireNodeField(node, 'eventType');

  const data = applyInputMapping(node.inputMapping, state);

  // Outside a persisted run (e.g. unit tests) there is no project to scope the
  // event to; nothing is emitted, but the node still completes.
  if (projectId !== undefined) {
    const projectPublicId = await resolveProjectPublicId({ projectId });
    // The name is the template author's, not SOAT's, so this is the one emit
    // site that cannot draw from the event registry (`soatEvents.ts`).
    emitCustomEvent({
      type: eventType,
      projectId,
      projectPublicId,
      resourceType: 'orchestration_run',
      resourceId: runPublicId ?? '',
      data,
    });
  }

  return {
    kind: 'artifact',
    artifact: { emitted: true, eventType },
  };
};
