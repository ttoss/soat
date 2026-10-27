import { DomainError } from '../errors';
import type { OrchestrationNode } from './orchestrations';
import type { ValidationProblem } from './validationProblems';

/**
 * Segments that name a prototype rather than a field: a dotted write through
 * one reaches every object in the process.
 */
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export const findUnsafePathSegment = (args: {
  path: string;
}): string | undefined => {
  return args.path.split('.').find((segment) => {
    return UNSAFE_PATH_SEGMENTS.has(segment);
  });
};

const unsafeSegmentMessage = (segment: string): string => {
  return `contains the segment '${segment}', which names a prototype rather than a field.`;
};

export const assertSafeMappingPath = (args: {
  path: string;
  field: string;
}): void => {
  const segment = findUnsafePathSegment({ path: args.path });
  if (segment === undefined) return;
  throw new DomainError(
    'VALIDATION_FAILED',
    `${args.field} key '${args.path}' ${unsafeSegmentMessage(segment)}`
  );
};

export const checkUnsafeStateMappingPaths = (args: {
  nodes: OrchestrationNode[];
}): ValidationProblem[] => {
  const issues: ValidationProblem[] = [];
  for (const [index, node] of args.nodes.entries()) {
    if (!node.stateMapping) continue;
    for (const statePath of Object.keys(node.stateMapping)) {
      const segment = findUnsafePathSegment({ path: statePath });
      if (segment === undefined) continue;
      issues.push({
        code: 'UNSAFE_PATH_SEGMENT',
        path: `nodes[${index}].state_mapping.${statePath}`,
        message: unsafeSegmentMessage(segment),
      });
    }
  }
  return issues;
};
