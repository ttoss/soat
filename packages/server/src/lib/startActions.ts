import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { buildSrn } from './iam';

type StartAction = {
  action: string;
  resourceType: string;
  /** False when the start creates the resource, which no id names yet. */
  byId: boolean;
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
  },
  tool: { action: 'tools:CallTool', resourceType: 'tool', byId: true },
  decider: {
    action: 'deciders:CreateDecision',
    resourceType: 'decider',
    byId: true,
  },
  workflow: { action: 'tasks:CreateTask', resourceType: 'task', byId: false },
  orchestration: {
    action: 'orchestrations:StartRun',
    resourceType: 'orchestration',
    byId: true,
  },
  eval: { action: 'evaluations:RunEval', resourceType: 'eval', byId: true },
} as const satisfies Record<string, StartAction>;

export type StartableType = keyof typeof START_ACTIONS;

/** Whether `isAllowed` may start the work of `type` named `id`. */
export const mayStart = (args: {
  isAllowed: IsAllowedFn;
  projectPublicId: string;
  type: StartableType;
  id: string;
}): Promise<boolean> => {
  const start: StartAction = START_ACTIONS[args.type];
  return args.isAllowed({
    projectPublicId: args.projectPublicId,
    action: start.action,
    resource: buildSrn({
      projectPublicId: args.projectPublicId,
      resourceType: start.resourceType,
      resourceId: start.byId ? args.id : '*',
    }),
  });
};
