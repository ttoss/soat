import { PAUSED_AUTOMATION_STATUS } from './tasksPause';

/**
 * Every non-null `automation_status` a task can hold, in one list so the board
 * listing's filter and the dispatch recorder cannot describe different sets.
 */
export const TASK_AUTOMATION_STATUSES = [
  'running',
  'completed',
  'failed',
  'unrouted',
  PAUSED_AUTOMATION_STATUS,
] as const;

export type TaskAutomationStatus = (typeof TASK_AUTOMATION_STATUSES)[number];
