/**
 * Validates a caller-owned `metadata` bag. Shared by every entry point that
 * accepts one — the create-agent-generation and update-generation routes, and
 * start-orchestration-run (#342) — so they all enforce the same rule and answer
 * with the same message. Returns an error message string, or null when the
 * metadata is valid.
 *
 * There is no reserved-key list to enforce, and that is the point: every piece
 * of state the server owns (usage attribution, the served agent version, the
 * model route's record, the extraction summary, a run's own state and input,
 * internal recovery state) lives in its own typed column, so nothing a caller
 * writes into this bag can reach platform state. A key that happens to be
 * spelled `action_id` is just a caller's annotation.
 */
export const validateMetadataBag = (metadata: unknown): string | null => {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return 'metadata must be a JSON object';
  }

  return null;
};
