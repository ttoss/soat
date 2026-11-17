import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { buildSrn } from './iam';

type StartAction = {
  action: string;
  resourceType: string;
  /** False when the start creates the resource, which no id names yet. */
  byId: boolean;
  /**
   * True when the start's own entry point (`gateToolCall`,
   * `gateGenerationStart`) checks it under the authority the work runs under,
   * so a caller starting it on someone's behalf does not check it again.
   */
  entryChecked: boolean;
};

/**
 * What starting each kind of work takes, as that work's own start route checks
 * it. Every caller that starts work for someone else — a playbook's author, a
 * trigger's creator — asks here, so none can start what its principal could
 * not start directly.
 */
export const START_ACTIONS = {
  agent: {
    action: 'agents:CreateAgentGeneration',
    resourceType: 'agent',
    byId: true,
    entryChecked: true,
  },
  tool: {
    action: 'tools:CallTool',
    resourceType: 'tool',
    byId: true,
    entryChecked: true,
  },
  decider: {
    action: 'deciders:CreateDecision',
    resourceType: 'decider',
    byId: true,
    entryChecked: false,
  },
  workflow: {
    action: 'tasks:CreateTask',
    resourceType: 'task',
    byId: false,
    entryChecked: false,
  },
  orchestration: {
    action: 'orchestrations:StartRun',
    resourceType: 'orchestration',
    byId: true,
    entryChecked: false,
  },
  eval: {
    action: 'evaluations:RunEval',
    resourceType: 'eval',
    byId: true,
    entryChecked: false,
  },
} as const satisfies Record<string, StartAction>;

export type StartableType = keyof typeof START_ACTIONS;

/** Whether a caller starting work of `type` checks its start itself. */
export const callerChecksStart = (type: StartableType): boolean => {
  return !START_ACTIONS[type].entryChecked;
};

/** Whether `isAllowed` may start the work of `type` named `id`. */
export const startCheck = (args: {
  projectPublicId: string;
  type: StartableType;
  id: string;
}): { action: string; resource: string } => {
  const start: StartAction = START_ACTIONS[args.type];
  return {
    action: start.action,
    resource: buildSrn({
      projectPublicId: args.projectPublicId,
      resourceType: start.resourceType,
      resourceId: start.byId ? args.id : '*',
    }),
  };
};

export const mayStart = (args: {
  isAllowed: IsAllowedFn;
  projectPublicId: string;
  type: StartableType;
  id: string;
}): Promise<boolean> => {
  return args.isAllowed({
    projectPublicId: args.projectPublicId,
    ...startCheck(args),
  });
};
