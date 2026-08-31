/**
 * What a chain does when a held tool call expires un-approved.
 *
 * Terminating is the default because the expiry is *already* fully recorded
 * without a turn: the approval row reads `expired`, `approvals.expired` is
 * emitted to webhooks, and the exceptions listener files `approval_expired`.
 * A continuation adds no record — it only tells the agent, which is worth
 * paying for solely when the agent acts on staleness. Under a forcing
 * `tool_choice` it cannot even do that: it can only propose more calls, which
 * the gate holds, which expire, which continue again (#1161, 17 days and
 * ~US$424 on one abandoned fixture).
 *
 * `react` restores that continuation for an agent that genuinely handles the
 * news — retry differently, notify through an ungated tool. It resumes with a
 * relaxed `tool_choice` so it can conclude (#1163).
 */
import { DomainError } from '../errors';

export const ON_APPROVAL_EXPIRY_VALUES = ['terminate', 'react'] as const;

export type OnApprovalExpiry = (typeof ON_APPROVAL_EXPIRY_VALUES)[number];

/**
 * Rejects a value outside the vocabulary on write, so a typo cannot read as the
 * safe default at resume time. `null`/absent inherits the default rather than
 * being a third mode.
 */
export const assertValidOnApprovalExpiry = (value: unknown): void => {
  if (value === undefined || value === null) return;
  if (
    typeof value !== 'string' ||
    !ON_APPROVAL_EXPIRY_VALUES.includes(value as OnApprovalExpiry)
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `on_approval_expiry must be one of: ${ON_APPROVAL_EXPIRY_VALUES.join(', ')}.`,
      { onApprovalExpiry: value }
    );
  }
};

/**
 * Whether an expired approval should spawn the continuation that reports it.
 * Only the explicit opt-in does; anything else — including a legacy row written
 * before the field existed — terminates.
 */
export const reactsToExpiredApproval = (value: unknown): boolean => {
  return value === 'react';
};
