/**
 * Validates caller-supplied generation metadata. Shared by the create-agent-
 * generation route and the update-generation route so both enforce the same
 * rule. Returns an error message string, or null when the metadata is valid.
 *
 * There is no reserved-key list to enforce, and that is the point: every piece
 * of state the server owns (usage attribution, the served agent version, the
 * model route's record, the extraction summary, internal recovery state) lives
 * in its own typed column, so nothing a caller writes into this bag can reach
 * platform state. A key that happens to be spelled `action_id` is just a
 * caller's annotation.
 */
export const validateGenerationMetadata = (
  metadata: unknown
): string | null => {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return 'metadata must be a JSON object';
  }

  return null;
};
