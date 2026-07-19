import { DomainError } from '../errors';
import type { GenerationResult } from './agentGenerationHelpers';
import { createGeneration } from './agents';
import type { GenerationInputMessage } from './generationInputMessages';
import { startOrchestrationRun } from './orchestrationEngine';
import type { WorkflowDispatch } from './workflowsValidation';

export type DispatchResult = {
  result: unknown;
  generationId: string | null;
  runId: string | null;
};

/**
 * Shapes a dispatch `input_mapping` result into agent messages: an explicit
 * `messages` array is passed through, a `prompt` string becomes a single user
 * message, and any other non-empty object is JSON-encoded as one user message.
 */
const buildAgentMessages = (
  inputs: Record<string, unknown>
): GenerationInputMessage[] => {
  if (Array.isArray(inputs.messages)) {
    return inputs.messages as GenerationInputMessage[];
  }
  if (typeof inputs.prompt === 'string' && inputs.prompt.length > 0) {
    return [{ role: 'user', content: inputs.prompt }];
  }
  return [{ role: 'user', content: JSON.stringify(inputs) }];
};

// Runs one dispatch and returns its exposed `{result}` and provenance ids. A
// generation exposes its output; an orchestration run exposes its final state
// (matching sub-orchestration semantics, PRD D2).
export const runDispatch = async (args: {
  dispatch: WorkflowDispatch;
  projectId: number;
  inputs: Record<string, unknown>;
  // Called as soon as a dispatch id is known but before the (blocking) wait
  // completes. For orchestration dispatches this fires at run creation, so the
  // run id can be persisted while the run is still in flight (#606).
  onDispatchStarted?: (ids: {
    generationId: string | null;
    runId: string | null;
  }) => Promise<void> | void;
}): Promise<DispatchResult> => {
  if (args.dispatch.kind === 'agent') {
    const gen = (await createGeneration({
      agentId: args.dispatch.agentId!,
      projectIds: [args.projectId],
      messages: buildAgentMessages(args.inputs),
      stream: false,
    })) as GenerationResult;
    return {
      result: gen.output ?? {},
      generationId: gen.id,
      runId: null,
    };
  }

  const run = await startOrchestrationRun({
    orchestrationPublicId: args.dispatch.orchestrationId!,
    projectIds: [args.projectId],
    input: args.inputs,
    wait: true,
    onRunCreated: args.onDispatchStarted
      ? ({ runId }) => {
          return args.onDispatchStarted!({ generationId: null, runId });
        }
      : undefined,
  });
  return {
    result: run.state ?? {},
    generationId: null,
    runId: run.id,
  };
};

/**
 * Extracts the failed generation/run id a dispatch error carries in its meta.
 * `createGeneration` wraps terminal failures in a `DomainError` whose meta holds
 * the `generation_id` (see `recordGenerationFailure`), written snake_case
 * because error responses bypass the caseTransform middleware. This lets the
 * on_failure-driven transition link the causing record, mirroring the
 * on_complete path's `id: generationId ?? runId` provenance (#607).
 */
export const failedDispatchIds = (
  error: unknown
): { generationId: string | null; runId: string | null } => {
  const meta = error instanceof DomainError ? (error.meta ?? {}) : {};
  const generationId =
    typeof meta.generation_id === 'string' ? meta.generation_id : null;
  const runId = typeof meta.run_id === 'string' ? meta.run_id : null;
  return { generationId, runId };
};
