/**
 * Per-node shape checks: the fields a node's type requires, and the values a
 * typed field accepts. Graph-wide checks (edges, reachability, cycles) stay in
 * `orchestrationValidation.ts`.
 */
import { REQUIRED_NODE_FIELDS } from './orchestrationNodeFields';
import {
  LOOP_ITEM_ERROR_MODES,
  type OrchestrationNode,
} from './orchestrations';

export type OrchestrationValidationIssue = {
  path: string;
  message: string;
};

/**
 * A tool node uses `operationId`, not `action`; name the field a graph got
 * wrong rather than reporting `operationId` as merely missing.
 */
const toolNodeShapeIssues = (args: {
  node: OrchestrationNode;
  basePath: string;
}): OrchestrationValidationIssue[] => {
  const { node, basePath } = args;
  const raw = node as Record<string, unknown>;
  if (raw['action'] !== undefined && !node.operationId) {
    return [
      {
        path: `${basePath}.action`,
        message: `tool node '${node.id}' uses 'operationId', not 'action'; rename the field to 'operationId'.`,
      },
    ];
  }
  return [];
};

/**
 * A poll node needs three fields; REQUIRED_NODE_FIELDS only enforces the
 * primary one (toolId), so the exit condition and cadence are checked here.
 */
const pollNodeShapeIssues = (args: {
  node: OrchestrationNode;
  basePath: string;
}): OrchestrationValidationIssue[] => {
  const { node, basePath } = args;
  const issues: OrchestrationValidationIssue[] = [];
  if (node.exitCondition === undefined || node.exitCondition === null) {
    issues.push({
      path: `${basePath}.exit_condition`,
      message: `poll node '${node.id}' is missing required field 'exit_condition' (the JSON Logic stop condition).`,
    });
  }
  if (!node.interval) {
    issues.push({
      path: `${basePath}.interval`,
      message: `poll node '${node.id}' is missing required field 'interval'.`,
    });
  }
  return issues;
};

const loopNodeShapeIssues = (args: {
  node: OrchestrationNode;
  basePath: string;
}): OrchestrationValidationIssue[] => {
  const { node, basePath } = args;
  const value: unknown = node.onItemError;
  if (
    value === undefined ||
    LOOP_ITEM_ERROR_MODES.some((mode) => {
      return mode === value;
    })
  ) {
    return [];
  }
  return [
    {
      path: `${basePath}.on_item_error`,
      message: `loop node '${node.id}' has on_item_error '${String(value)}'; expected one of ${LOOP_ITEM_ERROR_MODES.join(', ')}.`,
    },
  ];
};

const validateNodeShape = (args: {
  node: OrchestrationNode;
  index: number;
}): OrchestrationValidationIssue[] => {
  const { node, index } = args;
  const issues: OrchestrationValidationIssue[] = [];
  const basePath = `nodes[${index}]`;

  if (!node.id || typeof node.id !== 'string') {
    issues.push({ path: `${basePath}.id`, message: '`id` is required.' });
  }
  if (!node.type) {
    issues.push({ path: `${basePath}.type`, message: '`type` is required.' });
    return issues;
  }

  const requiredField = REQUIRED_NODE_FIELDS[node.type];
  if (requiredField) {
    const value = node[requiredField];
    if (value === undefined || value === null) {
      issues.push({
        path: `${basePath}.${requiredField}`,
        message: `${node.type} node '${node.id}' is missing required field '${requiredField}'.`,
      });
    }
  }

  if (node.type === 'tool') {
    issues.push(...toolNodeShapeIssues({ node, basePath }));
  }

  if (node.type === 'poll') {
    issues.push(...pollNodeShapeIssues({ node, basePath }));
  }

  if (node.type === 'loop') {
    issues.push(...loopNodeShapeIssues({ node, basePath }));
  }

  return issues;
};

export const checkNodeShapes = (
  nodes: OrchestrationNode[]
): OrchestrationValidationIssue[] => {
  const errors: OrchestrationValidationIssue[] = [];
  const seenIds = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    errors.push(...validateNodeShape({ node, index }));
    if (typeof node.id === 'string') {
      if (seenIds.has(node.id)) {
        errors.push({
          path: `nodes[${index}].id`,
          message: `Duplicate node id '${node.id}'.`,
        });
      }
      seenIds.add(node.id);
    }
  }
  return errors;
};
