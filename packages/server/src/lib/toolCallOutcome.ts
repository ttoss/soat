/**
 * How a tool call the SDK reports as a result ended when it did not succeed:
 * a guardrail held it, authorization refused it, or it failed with an error
 * the model reads as its result. The wrapper that answers marks its answer
 * here, keyed by the object itself, so the mark never reaches the model and a
 * tool cannot forge it by its output.
 */
export const MARKED_TOOL_CALL_STATUSES = [
  'blocked',
  'tripwire',
  'pending_approval',
  'denied',
  'failed',
] as const;

export type MarkedToolCallStatus = (typeof MARKED_TOOL_CALL_STATUSES)[number];

const MARKED = new WeakMap<object, MarkedToolCallStatus>();

/** A copy of `result` marked with `status`: a shared constant is never marked. */
export const markedToolResult = <T extends object>(args: {
  result: T;
  status: MarkedToolCallStatus;
}): T => {
  const answer = { ...args.result };
  MARKED.set(answer, args.status);
  return answer;
};

export const markedStatusOf = (
  output: unknown
): MarkedToolCallStatus | undefined => {
  if (typeof output !== 'object' || output === null) return undefined;
  return MARKED.get(output);
};
