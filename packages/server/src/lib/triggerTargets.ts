import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import { startEvalRun } from './evaluationRuns';
import { startOrchestrationRun } from './orchestrationEngine';
import { callTool } from './tools';
import { buildAgentMessages } from './triggerDispatch';

/**
 * How a firing reaches each kind of target.
 *
 * Separate from `triggerDispatch.ts` — which owns the firing's lifecycle, its
 * credentials and its record — because the two answer different questions. A
 * new target type is a new entry here and nothing else; a change to how a
 * firing is recorded touches none of this.
 */

const OUTPUT_MAX_CHARS = 4000;

/** Serializes a target's output and truncates it so firing records stay small. */
const truncateOutput = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= OUTPUT_MAX_CHARS) {
    return value;
  }
  return { truncated: true, preview: serialized.slice(0, OUTPUT_MAX_CHARS) };
};

export const toErrorObject = (err: unknown): Record<string, unknown> => {
  if (err instanceof DomainError) {
    return { code: err.code, message: err.message, meta: err.meta ?? null };
  }
  if (err instanceof Error) {
    return { code: 'INTERNAL', message: err.message };
  }
  return { code: 'INTERNAL', message: String(err) };
};

export type DispatchArgs = {
  targetType: string;
  targetId: string;
  action: string | null;
  projectId: number;
  input: Record<string, unknown>;
  toolContext?: Record<string, string>;
  authHeader: string;
  triggerId: string;
};

const dispatchToOrchestration = async (
  args: DispatchArgs
): Promise<Record<string, unknown>> => {
  const run = await startOrchestrationRun({
    orchestrationPublicId: args.targetId,
    projectIds: [args.projectId],
    input: args.input,
    toolContext: args.toolContext,
    authHeader: args.authHeader,
    wait: true,
    triggerId: args.triggerId,
  });
  return {
    target_type: 'orchestration',
    result_id: run.id,
    status: run.status,
    output: truncateOutput(run.output),
  };
};

const dispatchToAgent = async (
  args: DispatchArgs
): Promise<Record<string, unknown>> => {
  const generation = await createGeneration({
    agentId: args.targetId,
    projectIds: [args.projectId],
    messages: buildAgentMessages(args.input),
    stream: false,
    toolContext: args.toolContext,
    authHeader: args.authHeader,
    triggerId: args.triggerId,
  });
  // stream:false always resolves to a GenerationResult.
  const result = generation as {
    id: string;
    status: string;
    output?: { content?: string };
  };
  return {
    target_type: 'agent',
    result_id: result.id,
    status: result.status,
    output: truncateOutput(result.output?.content),
  };
};

const dispatchToEval = async (
  args: DispatchArgs
): Promise<Record<string, unknown>> => {
  // Always background: an eval is one generation per dataset item with no cap
  // on the count, so blocking a scheduler tick on it is the case
  // `sync-async.md` rules out. The firing records the run id to poll.
  const run = await startEvalRun({
    evalId: args.targetId,
    projectIds: [args.projectId],
    wait: false,
    agentVersion: args.input.agent_version,
    baselineRunId: args.input.baseline_run_id,
    toolContext: args.toolContext,
    triggerId: args.triggerId,
  });
  return {
    target_type: 'eval',
    result_id: run.id,
    status: run.status,
    output: null,
  };
};

const dispatchToTool = async (
  args: DispatchArgs
): Promise<Record<string, unknown>> => {
  const output = await callTool({
    // A firing is a call of this tool, so its guardrails decide it — a trigger
    // is not a way to reach a tool the project has classified as forbidden.
    guardrails: 'apply',
    id: args.targetId,
    projectIds: [args.projectId],
    action: args.action ?? undefined,
    input: args.input,
    toolContext: args.toolContext,
    authHeader: args.authHeader,
    attribution: { triggerId: args.triggerId },
  });
  return {
    target_type: 'tool',
    result_id: null,
    status: 'completed',
    output: truncateOutput(output),
  };
};

const TARGET_DISPATCHERS: Record<
  string,
  (args: DispatchArgs) => Promise<Record<string, unknown>>
> = {
  orchestration: dispatchToOrchestration,
  agent: dispatchToAgent,
  eval: dispatchToEval,
};

export const dispatchToTarget = async (
  args: DispatchArgs
): Promise<Record<string, unknown>> => {
  const dispatch = TARGET_DISPATCHERS[args.targetType] ?? dispatchToTool;
  return dispatch(args);
};
