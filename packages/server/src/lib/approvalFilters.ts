import { DomainError } from '../errors';

const APPROVAL_FILTERS = {
  status: ['pending', 'approved', 'rejected', 'expired'],
  origin: ['node', 'tool_call', 'task_transition'],
};

/**
 * Rejects an out-of-enum `status`/`origin` filter with 400 instead of letting
 * it reach the DB, where an invalid enum value throws and surfaces as an
 * unhandled 500.
 */
export const assertValidApprovalFilters = (args: {
  status?: string;
  origin?: string;
}): void => {
  for (const field of ['status', 'origin'] as const) {
    const value = args[field];
    if (value && !APPROVAL_FILTERS[field].includes(value)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Invalid ${field} '${value}'.`
      );
    }
  }
};
