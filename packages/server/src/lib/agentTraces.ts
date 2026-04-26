export type Trace = {
  id: string;
  projectId: number;
  agentId: string;
  status: string;
  createdAt: Date;
  steps: Array<unknown>;
};

export const traces = new Map<string, Trace>();

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
