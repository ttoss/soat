import type { soatTools } from './soatTools';
import { filterToolContext } from './toolContext';

/**
 * What goes into the request body of a SOAT action a `soat` tool invokes: the
 * operation's own body plus the ambient fields the action's schema declares it
 * accepts. Split out of `agentToolResolverExternalTools` because it is pure
 * body assembly with no outbound I/O of its own.
 */

// A `soat` action propagates the bag to whatever it starts, so the allowlist
// applies here too — unfiltered, it would be advisory on the one path that
// carries context furthest.
const withToolContext = (args: {
  body: Record<string, unknown>;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  acceptedBodyFields: string[];
}) => {
  if (!args.acceptedBodyFields.includes('tool_context')) return args.body;
  const toolContext = filterToolContext({
    toolContext: args.toolContext,
    contextKeys: args.contextKeys,
  });
  if (!toolContext || Object.keys(toolContext).length === 0) return args.body;
  return { ...args.body, tool_context: toolContext };
};

const withTraceIds = (args: {
  body: Record<string, unknown>;
  traceId?: string;
  rootTraceId?: string | null;
  acceptedBodyFields: string[];
}) => {
  const acceptsTrace =
    args.acceptedBodyFields.includes('parent_trace_id') &&
    args.acceptedBodyFields.includes('root_trace_id');
  if (!args.traceId || !acceptsTrace) return args.body;
  return {
    ...args.body,
    parent_trace_id: args.traceId,
    root_trace_id: args.rootTraceId ?? args.traceId,
  };
};

const withMaxCallDepth = (args: {
  body: Record<string, unknown>;
  remainingDepth?: number;
  acceptedBodyFields: string[];
}) => {
  if (
    args.remainingDepth === undefined ||
    !args.acceptedBodyFields.includes('max_call_depth')
  ) {
    return args.body;
  }
  return {
    ...args.body,
    max_call_depth: Math.max(0, args.remainingDepth - 1),
  };
};

/**
 * Assembles the request body a SOAT action is called with: the operation's own
 * body, plus the ambient fields the action's schema declares it accepts —
 * `tool_context`, the trace lineage, and the remaining call depth. Exported for
 * direct testing: which fields get injected into which action is a per-action
 * rule with a large input space (#371), and the schema check that enforces it is
 * invisible from the outside once the body has been sent.
 */
export const buildSoatRequestBody = (args: {
  def: (typeof soatTools)[number];
  rawArgs: Record<string, unknown>;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  traceId?: string;
  rootTraceId?: string | null;
  remainingDepth?: number;
}) => {
  const soatBody = args.def.body ? args.def.body(args.rawArgs) : undefined;
  if (!soatBody) return soatBody;

  const acceptedBodyFields = args.def.acceptedBodyFields;
  const withContext = withToolContext({
    body: soatBody,
    toolContext: args.toolContext,
    contextKeys: args.contextKeys,
    acceptedBodyFields,
  });
  const withTrace = withTraceIds({
    body: withContext,
    traceId: args.traceId,
    rootTraceId: args.rootTraceId,
    acceptedBodyFields,
  });
  return withMaxCallDepth({
    body: withTrace,
    remainingDepth: args.remainingDepth,
    acceptedBodyFields,
  });
};
