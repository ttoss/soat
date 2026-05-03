export type Trace = {
  id: string;
  projectId: number;
  agentId: string;
  status: string;
  createdAt: Date;
  steps: Array<unknown>;
};

export const traces = new Map<string, Trace>();

/**
 * Serializes trace steps so that Error objects (which serialize to `{}` by
 * default) are converted to plain objects with `message`, `name`, and any
 * enumerable properties (e.g. `status`, `body` from HttpToolError).
 */
export const serializeSteps = (steps: unknown[]): unknown[] => {
  return JSON.parse(
    JSON.stringify(steps, (_key, value: unknown) => {
      if (value instanceof Error) {
        return {
          message: value.message,
          name: value.name,
          ...(value as unknown as Record<string, unknown>),
        };
      }
      return value;
    })
  ) as unknown[];
};

export const listTraces = async (_args: {
  projectIds?: number[];
}): Promise<Trace[]> => {
  const all = Array.from(traces.values());

  if (_args.projectIds === undefined) {
    return all;
  }

  return all.filter((trace) => {
    return _args.projectIds!.includes(trace.projectId);
  });
};

export const getTrace = async (args: {
  projectIds?: number[];
  traceId: string;
}): Promise<Trace | 'not_found'> => {
  const trace = traces.get(args.traceId);
  if (!trace) {
    return 'not_found';
  }

  if (
    args.projectIds !== undefined &&
    !args.projectIds.includes(trace.projectId)
  ) {
    return 'not_found';
  }

  return trace;
};
