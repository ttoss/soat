import { DomainError } from '../errors';
import type { OrchestrationNode } from './orchestrations';

/**
 * Which field each node type cannot execute without. One table, two consumers:
 * {@link validateNodes} rejects a graph that omits the field at author time,
 * and {@link requireNodeField} rejects it at dispatch time. Adding a node type
 * means adding one entry here — the eleven hand-written throws that used to
 * restate this table, each with its own message string and its own idea of
 * what "missing" meant, are gone (#914).
 */
export const REQUIRED_NODE_FIELDS: Partial<
  Record<OrchestrationNode['type'], keyof OrchestrationNode>
> = {
  agent: 'agentId',
  tool: 'toolId',
  transform: 'expression',
  condition: 'expression',
  approval: 'toolId',
  memory_write: 'memoryId',
  delay: 'duration',
  loop: 'orchestrationId',
  poll: 'toolId',
  emit_event: 'eventType',
  sub_orchestration: 'orchestrationId',
};

/**
 * Reads a node field an executor cannot run without, throwing
 * `ORCHESTRATION_NODE_FAILED` when it is absent and returning the value
 * non-nullable so the caller needs no further narrowing.
 *
 * A graph reaching dispatch has normally already passed {@link validateNodes},
 * so this fires for a definition that was stored before its node type gained a
 * requirement, or for a direct lib call that never validated.
 *
 * "Absent" is `null`, `undefined`, or the empty string — an empty id, duration
 * or expression is missing rather than valid, and every hand-written guard this
 * replaced treated it that way for ids already.
 */
export const requireNodeField = <K extends keyof OrchestrationNode>(
  node: OrchestrationNode,
  field: K
): NonNullable<OrchestrationNode[K]> => {
  const value = node[field];
  if (value === undefined || value === null || value === '') {
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `${node.type} node '${node.id}' missing ${String(field)}.`
    );
  }
  return value;
};
