import { DomainError } from '../errors';

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const APPROVAL_ORIGINS = ['node', 'tool_call', 'task_transition'];

/**
 * Rejects an out-of-enum `origin` filter with 400 instead of letting it reach
 * the DB, where an invalid enum value throws and surfaces as an unhandled 500.
 */
export const assertValidApprovalFilters = (args: { origin?: string }): void => {
  if (args.origin && !APPROVAL_ORIGINS.includes(args.origin)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Invalid origin '${args.origin}'.`
    );
  }
};
