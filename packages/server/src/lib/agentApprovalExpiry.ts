/**
 * What a chain does when a held tool call expires un-approved.
 *
 * Terminating is the default because the expiry is *already* fully recorded
 * without a turn: the approval row reads `expired`, `approvals.expired` is
 * emitted to webhooks, and the exceptions listener files `approval_expired`.
 * A continuation adds no record — it only tells the agent, which is worth
 * paying for solely when the agent acts on staleness. An expiry nobody watched
 * is also where a chain grows with nobody reading the result: the reaction turn
 * proposes more calls, the gate holds them, they expire, and it continues.
 *
 * `react` restores that continuation for an agent that genuinely handles the
 * news — retry differently, notify through an ungated tool. It runs under the
 * agent's own `tool_choice`, so an agent that forces one reaches its declared
 * `hasToolCall` exit or spends the turn's steps; nothing rewrites the choice for
 * it (`assertForcedToolChoiceCanStop`).
 */
import { DomainError } from '../errors';

export const ON_APPROVAL_EXPIRY_VALUES = ['terminate', 'react'] as const;

export type OnApprovalExpiry = (typeof ON_APPROVAL_EXPIRY_VALUES)[number];

/**
 * Rejects a value outside the vocabulary on write, so a typo cannot read as the
 * safe default at resume time. `null`/absent inherits the default rather than
 * being a third mode.
 */
const KNOWN_VALUES: ReadonlySet<string> = new Set(ON_APPROVAL_EXPIRY_VALUES);

export const assertValidOnApprovalExpiry = (value: unknown): void => {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !KNOWN_VALUES.has(value)) {
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
