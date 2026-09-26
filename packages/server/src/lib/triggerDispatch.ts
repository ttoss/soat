import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import type { GenerationInputMessage } from './generationInputMessages';
import { buildSrn } from './iam';
import { createJwtIsAllowed } from './permissions';
import { assertProjectAcceptsWork } from './projectPause';
import { resolveStoredToolContext } from './toolContextCarrier';
import {
  createFiringRecord,
  finalizeFiringFailed,
  finalizeFiringSucceeded,
  mapTriggerFiring,
  reloadFiring,
} from './triggerFirings';
import { dispatchToTarget, toErrorObject } from './triggerTargets';
import { signTriggerToken } from './triggerToken';
import { targetStartAction } from './triggerValidation';

const log = createDebug('soat:triggers');

/**
 * Builds the agent message list from the effective input:
 * - `input.messages` (array of `{role, content}`) is used verbatim;
 * - else `input.message` (string) becomes a single user message;
 * - else a non-empty object is JSON-stringified into a user message.
 * Throws `TRIGGER_INPUT_INVALID` when the input yields no message.
 */
export const buildAgentMessages = (
  input: Record<string, unknown>
): GenerationInputMessage[] => {
  if (Array.isArray(input.messages) && input.messages.length > 0) {
    return input.messages as GenerationInputMessage[];
  }
  if (typeof input.message === 'string' && input.message.length > 0) {
    return [{ role: 'user', content: input.message }];
  }
  if (Object.keys(input).length > 0) {
    return [{ role: 'user', content: JSON.stringify(input) }];
  }
  throw new DomainError(
    'TRIGGER_INPUT_INVALID',
    'Agent trigger input is empty; provide `messages`, `message`, or a non-empty input object.'
  );
};

type JsonSchemaLike = {
  required?: string[];
  properties?: Record<string, { type?: string }>;
};

const isPrimitiveTypeMatch = (expected: string, value: unknown): boolean => {
  if (expected === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  const actual = Array.isArray(value) ? 'array' : typeof value;
  return actual === expected;
};

/**
 * Lightweight orchestration input validation: checks `required` keys are present
 * and that primitive-typed properties match their declared JSON-schema `type`.
 * No ajv dependency. Throws `TRIGGER_INPUT_INVALID` with details on violation.
 */
export const validateOrchestrationInput = (args: {
  inputSchema: unknown;
  input: Record<string, unknown>;
}): void => {
  const schema = args.inputSchema as JsonSchemaLike | null | undefined;
  if (!schema || typeof schema !== 'object') return;

  const missing = (schema.required ?? []).filter((key) => {
    return args.input[key] === undefined;
  });
  if (missing.length > 0) {
    throw new DomainError(
      'TRIGGER_INPUT_INVALID',
      `Missing required input field(s): ${missing.join(', ')}.`,
      { missing }
    );
  }

  const mismatches = Object.entries(schema.properties ?? {})
    .filter(([key, spec]) => {
      const value = args.input[key];
      return (
        value !== undefined &&
        spec.type !== undefined &&
        !isPrimitiveTypeMatch(spec.type, value)
      );
    })
    .map(([key, spec]) => {
      return `${key} (expected ${spec.type})`;
    });
  if (mismatches.length > 0) {
    throw new DomainError(
      'TRIGGER_INPUT_INVALID',
      `Input type mismatch: ${mismatches.join('; ')}.`,
      { mismatches }
    );
  }
};

/**
 * Resolves the run-as identity for a firing: loads the creator (fail-closed if
 * deleted), re-checks the target-start permission against the creator's current
 * policies, and mints the short-lived run-as token. Throws on any violation.
 */
const resolveRunAsAuthHeader = async (args: {
  trigger: InstanceType<(typeof db)['Trigger']>;
  projectPublicId: string;
}): Promise<string> => {
  const { trigger, projectPublicId } = args;
  const creatorId = trigger.createdByUserId as number | null;
  const creator = creatorId
    ? await db.User.findOne({ where: { id: creatorId } })
    : null;
  if (!creator) {
    throw new DomainError(
      'TRIGGER_CREATOR_UNAVAILABLE',
      'The trigger creator no longer exists.'
    );
  }

  const creatorRole = creator.role as 'admin' | 'user';
  const creatorIsAllowed = createJwtIsAllowed({
    role: creatorRole,
    userPolicyIds: (creator.policyIds as number[]) ?? [],
    db,
  });
  const canStart = await creatorIsAllowed({
    projectPublicId,
    action: targetStartAction(trigger.targetType as string),
    resource: buildSrn({
      projectPublicId,
      resourceType: trigger.targetType as string,
      resourceId: trigger.targetId as string,
    }),
  });
  if (!canStart) {
    throw new DomainError(
      'FORBIDDEN',
      'The trigger creator no longer has permission to start this target.'
    );
  }

  return `Bearer ${signTriggerToken({
    publicId: creator.publicId as string,
    role: creatorRole,
    projectPublicId,
    triggerId: trigger.publicId as string,
  })}`;
};

/** Pre-flight input validation per target type (throws 400 before any record). */
const assertFireInputValid = async (args: {
  trigger: InstanceType<(typeof db)['Trigger']>;
  input: Record<string, unknown>;
}): Promise<void> => {
  if (args.trigger.targetType === 'agent') {
    buildAgentMessages(args.input);
    return;
  }
  if (args.trigger.targetType === 'orchestration') {
    const orchestration = await db.Orchestration.findOne({
      where: { publicId: args.trigger.targetId as string },
    });
    if (orchestration?.inputSchema) {
      validateOrchestrationInput({
        inputSchema: orchestration.inputSchema,
        input: args.input,
      });
    }
  }
};

export type PreparedFiring = {
  firing: InstanceType<(typeof db)['TriggerFiring']>;
  trigger: InstanceType<(typeof db)['Trigger']>;
  effectiveInput: Record<string, unknown>;
  /** Resolved at fire time, so a rotated secret takes effect on the next firing. */
  effectiveToolContext?: Record<string, string>;
  authHeader: string;
};

/**
 * Runs the synchronous pre-flight for a firing and creates a `pending` firing
 * record. Throws `DomainError` — surfaced as an HTTP error for a manual fire,
 * or returned before a webhook fire's `202`: inactive trigger, unavailable
 * creator, revoked target-start permission, invalid input. The returned handle
 * is executed by {@link runFiringDispatch}.
 */
type TriggerInstance = InstanceType<(typeof db)['Trigger']>;

/** Loads a trigger a firing may run, refusing one that is gone or switched off. */
const loadActiveTrigger = async (args: {
  where: { publicId: string } | { id: number };
  label: string;
}): Promise<TriggerInstance> => {
  const trigger = await db.Trigger.findOne({ where: args.where });
  if (!trigger) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trigger '${args.label}' not found.`
    );
  }
  if (!trigger.active) {
    throw new DomainError(
      'TRIGGER_NOT_ACTIVE',
      `Trigger '${args.label}' is inactive.`
    );
  }
  return trigger;
};

/**
 * The effective input for a firing: the trigger's stored input, overlaid by
 * whatever the fire supplied. Exported because the event path settles it
 * before the firing row is written, so the row records what was dispatched.
 */
export const mergeFiringInput = (args: {
  trigger: TriggerInstance;
  fireInput?: Record<string, unknown> | null;
}): Record<string, unknown> => {
  return {
    ...((args.trigger.input as Record<string, unknown> | null) ?? {}),
    ...(args.fireInput ?? {}),
  };
};

export { assertFireInputValid };

/**
 * The credentials and context a dispatch needs, resolved at fire time.
 *
 * Deliberately not stored on the firing row: a run-as token is short-lived and
 * a `tool_context` secret may have been rotated, so a firing the sweep
 * redelivers must mint both again rather than replay the ones its first
 * attempt held.
 */
const resolveDispatchCredentials = async (args: {
  trigger: TriggerInstance;
  fireToolContext?: Record<string, string> | null;
}): Promise<{
  authHeader: string;
  effectiveToolContext?: Record<string, string>;
}> => {
  const project = await db.Project.findOne({
    where: { id: args.trigger.projectId as number },
  });

  const authHeader = await resolveRunAsAuthHeader({
    trigger: args.trigger,
    projectPublicId: project?.publicId as string,
  });

  const effectiveToolContext = await resolveStoredToolContext({
    stored: args.trigger.toolContext,
    supplied: args.fireToolContext,
    projectId: args.trigger.projectId as number,
  });

  return { authHeader, effectiveToolContext };
};

export const prepareFiring = async (args: {
  triggerPublicId: string;
  source: string;
  fireInput?: Record<string, unknown> | null;
  fireToolContext?: Record<string, string> | null;
}): Promise<PreparedFiring> => {
  log('prepareFiring: trigger=%s source=%s', args.triggerPublicId, args.source);

  const trigger = await loadActiveTrigger({
    where: { publicId: args.triggerPublicId },
    label: args.triggerPublicId,
  });
  // Before the firing record: a refused manual or webhook fire answers
  // `PROJECT_PAUSED` and leaves no firing behind.
  await assertProjectAcceptsWork({ projectId: trigger.projectId as number });

  const project = await db.Project.findOne({
    where: { id: trigger.projectId as number },
  });
  const projectPublicId = project?.publicId as string;

  const authHeader = await resolveRunAsAuthHeader({ trigger, projectPublicId });

  const effectiveInput = mergeFiringInput({
    trigger,
    fireInput: args.fireInput,
  });
  await assertFireInputValid({ trigger, input: effectiveInput });

  const effectiveToolContext = await resolveStoredToolContext({
    stored: trigger.toolContext,
    supplied: args.fireToolContext,
    projectId: trigger.projectId as number,
  });

  const firing = await createFiringRecord({
    triggerId: trigger.id as number,
    projectId: trigger.projectId as number,
    source: args.source,
    input: effectiveInput,
  });

  return { firing, trigger, effectiveInput, effectiveToolContext, authHeader };
};

/**
 * Executes a prepared firing against its target and finalizes the record. Once
 * the firing record exists, target-execution errors are *recorded* (status
 * `failed`) rather than thrown — a firing that reaches the target always yields
 * an auditable record. Safe to run in the background (webhook/schedule) or
 * awaited (manual).
 */
export const runFiringDispatch = async (
  prepared: PreparedFiring
): Promise<ReturnType<typeof mapTriggerFiring>> => {
  const { firing, trigger, effectiveInput, effectiveToolContext, authHeader } =
    prepared;

  // Everything is guarded so this never rejects — callers can `void` it as a
  // fire-and-forget background task (webhook/schedule) or await it (manual).
  try {
    firing.status = 'running';
    firing.startedAt = new Date();
    await firing.save();
    const result = await dispatchToTarget({
      targetType: trigger.targetType as string,
      targetId: trigger.targetId as string,
      action: (trigger.action as string | null) ?? null,
      projectId: trigger.projectId as number,
      input: effectiveInput,
      toolContext: effectiveToolContext,
      authHeader,
      triggerId: trigger.publicId as string,
    });
    await finalizeFiringSucceeded({ firing, result });
    log('runFiringDispatch: firing=%s succeeded', firing.publicId);
  } catch (error) {
    await finalizeFiringFailed({ firing, error: toErrorObject(error) });
    log('runFiringDispatch: firing=%s failed %o', firing.publicId, error);
  }

  try {
    return await reloadFiring({ firing });
  } catch {
    // Fall back to the in-memory instance if the re-fetch fails.
    return mapTriggerFiring(firing);
  }
};

/**
 * Runs a firing whose row already exists, and records its outcome on that row.
 *
 * This is the durable path: the row was written before any of this was
 * attempted, so the same call runs whether the firing is being dispatched by
 * the process that matched the event or redelivered by the sweep after that
 * process died. Both re-resolve the trigger and its credentials, because
 * neither survives a restart and both may have changed since.
 *
 * Nothing here is raised. A trigger switched off, a deleted creator, a revoked
 * permission — each is recorded on the row, which is the only place a caller
 * that is no longer present can read it.
 */
export const runReservedFiring = async (args: {
  firing: InstanceType<(typeof db)['TriggerFiring']>;
}): Promise<void> => {
  const { firing } = args;
  log('runReservedFiring: firing=%s', firing.publicId);

  try {
    const trigger = await loadActiveTrigger({
      where: { id: firing.triggerId as number },
      label: String(firing.triggerId),
    });
    await assertProjectAcceptsWork({ projectId: trigger.projectId as number });

    const { authHeader, effectiveToolContext } =
      await resolveDispatchCredentials({ trigger });

    await runFiringDispatch({
      firing,
      trigger,
      effectiveInput: (firing.input as Record<string, unknown> | null) ?? {},
      effectiveToolContext,
      authHeader,
    });
  } catch (error) {
    await finalizeFiringFailed({ firing, error: toErrorObject(error) });
    log('runReservedFiring: firing=%s refused %o', firing.publicId, error);
  }
};

/**
 * Fires a trigger synchronously (manual fire) and returns the terminal firing
 * record. Webhook/schedule starters instead call {@link prepareFiring} then run
 * {@link runFiringDispatch} in the background.
 */
export const fireTriggerNow = async (args: {
  triggerPublicId: string;
  source: string;
  fireInput?: Record<string, unknown> | null;
  fireToolContext?: Record<string, string> | null;
}) => {
  const prepared = await prepareFiring(args);
  return runFiringDispatch(prepared);
};
