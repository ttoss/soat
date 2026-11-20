/**
 * How a tool call the SDK reports as a result ended when the tool never ran:
 * a guardrail held it, or authorization refused it. The wrapper that answers
 * in the tool's place marks its answer here, keyed by the object itself, so
 * the mark never reaches the model and a tool cannot forge it by its output.
 */
export const HELD_TOOL_CALL_STATUSES = [
  'blocked',
  'tripwire',
  'pending_approval',
  'denied',
] as const;

export type HeldToolCallStatus = (typeof HELD_TOOL_CALL_STATUSES)[number];

const HELD = new WeakMap<object, HeldToolCallStatus>();

/** A copy of `result` marked held: a shared constant is never marked. */
export const heldToolResult = <T extends object>(args: {
  result: T;
  status: HeldToolCallStatus;
}): T => {
  const answer = { ...args.result };
  HELD.set(answer, args.status);
  return answer;
};

export const heldStatusOf = (
  output: unknown
): HeldToolCallStatus | undefined => {
  if (typeof output !== 'object' || output === null) return undefined;
  return HELD.get(output);
};
