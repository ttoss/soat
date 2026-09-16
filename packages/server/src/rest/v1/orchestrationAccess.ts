/**
 * The orchestration cluster's binding of the shared item-route preamble.
 *
 * Every route that acts on one orchestration — its own routes, its version
 * history, and its runs — authorizes against `srn:<project>:orchestration:<id>`.
 *
 * A **run** is authorized through the orchestration it runs rather than through
 * an SRN of its own. That is the resource type these routes have always probed
 * (`resourceType: 'orchestration'`), so a statement naming
 * `srn:<project>:orchestration:*` keeps covering run actions; a new
 * `orchestration_run` type would have silently narrowed every such policy.
 *
 * Lives beside `orchestrationAuth.ts` rather than inside it because that module
 * is the *audit* half of the same preamble, and the two are imported by
 * different sets of routes.
 */
import type { Context } from 'src/Context';
import {
  findRunOrchestrationId,
  orchestrations,
} from 'src/lib/orchestrationAccessor';

import {
  authorizeResource,
  makeItemRouteAuthorizer,
  type ResourceAccess,
} from './resourceAccess';

const orchestrationAccess = makeItemRouteAuthorizer({
  findScope: orchestrations.findScope,
  resourceType: 'orchestration',
  param: 'orchestration_id',
  label: 'Orchestration',
  errorCode: 'ORCHESTRATION_NOT_FOUND',
});

/** A read of one orchestration or its versions. */
export const authorizeOrchestrationRead = orchestrationAccess.authorizeRead;

/** Anything that changes an orchestration or restores a version. */
export const authorizeOrchestrationWrite = orchestrationAccess.authorizeWrite;

const authorizeRun = async (args: {
  ctx: Context;
  action: string;
  onDenied: 'hide' | 'refuse';
}): Promise<ResourceAccess> => {
  const runId = args.ctx.params.orchestration_run_id;
  const orchestrationId = await findRunOrchestrationId({ id: runId });

  return authorizeResource({
    ctx: args.ctx,
    scope: orchestrationId
      ? await orchestrations.findScope({ id: orchestrationId })
      : null,
    resourceType: 'orchestration',
    resourceId: orchestrationId ?? runId,
    // The caller asked for a run, so that is the id an absence names — the
    // orchestration behind it is an implementation detail of the check.
    missingId: runId,
    label: 'Run',
    errorCode: 'ORCHESTRATION_RUN_NOT_FOUND',
    action: args.action,
    onDenied: args.onDenied,
  });
};

/** `GetRun`: a run the caller may not read is indistinguishable from absence. */
export const authorizeRunRead = async (args: {
  ctx: Context;
  action: string;
}): Promise<ResourceAccess> => {
  return authorizeRun({ ...args, onDenied: 'hide' });
};

/** `CancelRun` / `PauseRun` / `ResumeRun` / `SubmitHumanInput`. */
export const authorizeRunWrite = async (args: {
  ctx: Context;
  action: string;
}): Promise<ResourceAccess> => {
  return authorizeRun({ ...args, onDenied: 'refuse' });
};
