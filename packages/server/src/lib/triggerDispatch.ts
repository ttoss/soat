import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { resolveJwtAuthUser } from '../middleware/auth';
import { authorizationDenied } from './authorizationDenial';
import type { GenerationInputMessage } from './generationInputMessages';
import { principalFromAuthUser } from './principals';
import { assertProjectAcceptsWork } from './projectPause';
import { mayStart, startCheck } from './startActions';
import { INTERNAL_FAILURE, toStoredError } from './storedError';
import { resolveStoredToolContext } from './toolContextCarrier';
import {
  createFiringRecord,
  finalizeFiringCompleted,
  finalizeFiringFailed,
  mapTriggerFiring,
  reloadFiring,
} from './triggerFirings';
import { dispatchToTarget } from './triggerTargets';
import { signTriggerToken, type TriggerCallerCredential } from './triggerToken';
import { readTargetType } from './triggerValidation';

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
 * The caller of a manual fire: the firing acts as this caller ∩ the trigger's
 * `policy_ids`, and records it as `acted_as`.
 */
export type FiringCaller = TriggerCallerCredential & {
  publicId: string;
  role: 'admin' | 'user';
};

/** The principal a firing acted as: the trigger, or the caller of a fire. */
export type FiringPrincipal = { principalType: string; principalId: string };

/** The user a firing's token names: the caller, else the creator. */
const tokenUser = async (args: {
  trigger: InstanceType<(typeof db)['Trigger']>;
  caller?: FiringCaller;
}): Promise<{ publicId: string; role: string }> => {
  if (args.caller) return args.caller;
  const creatorId = args.trigger.createdByUserId as number | null;
  const creator = creatorId
    ? await db.User.findOne({ where: { id: creatorId } })
    : null;
  if (!creator) {
    throw new DomainError(
      'TRIGGER_CREATOR_UNAVAILABLE',
      'The trigger creator no longer exists.'
    );
  }
  return { publicId: creator.publicId as string, role: creator.role as string };
};

/**
 * Resolves who a firing acts as and mints its run-as token: the trigger's
 * `policy_ids` alone when nobody called it, the caller ∩ `policy_ids` for a
 * manual fire. That identity must be able to start the target.
 */
const resolveFiringIdentity = async (args: {
  trigger: InstanceType<(typeof db)['Trigger']>;
  projectPublicId: string;
  caller?: FiringCaller;
}): Promise<{ authHeader: string; actedAs: FiringPrincipal }> => {
  const { trigger, projectPublicId, caller } = args;
  const user = await tokenUser({ trigger, caller });
  const token = signTriggerToken({
    publicId: user.publicId,
    role: user.role,
    projectPublicId,
    triggerId: trigger.publicId as string,
    caller: caller
      ? {
          apiKeyPublicId: caller.apiKeyPublicId,
          oauthScope: caller.oauthScope,
          bound: caller.bound,
        }
      : undefined,
  });
  const identity = await resolveJwtAuthUser({ db, token });
  const canStart =
    identity !== undefined &&
    (await mayStart({
      isAllowed: identity.isAllowed,
      projectPublicId,
      type: readTargetType(trigger.targetType as string),
      id: trigger.targetId as string,
    }));
  if (!canStart) {
    throw authorizationDenied({
      principal: { type: 'trigger', id: trigger.publicId as string },
      denied: [
        startCheck({
          projectPublicId,
          type: readTargetType(trigger.targetType as string),
          id: trigger.targetId as string,
        }),
      ],
    });
  }
  return {
    authHeader: `Bearer ${token}`,
    actedAs: caller
      ? principalFromAuthUser(caller)
      : { principalType: 'trigger', principalId: trigger.publicId as string },
  };
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
  actedAs: FiringPrincipal;
};

/**
 * Runs the synchronous pre-flight for a firing and creates a `queued` firing
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
  actedAs: FiringPrincipal;
  effectiveToolContext?: Record<string, string>;
}> => {
  const project = await db.Project.findOne({
    where: { id: args.trigger.projectId as number },
  });

  const { authHeader, actedAs } = await resolveFiringIdentity({
    trigger: args.trigger,
    projectPublicId: project?.publicId as string,
  });

  const effectiveToolContext = await resolveStoredToolContext({
    stored: args.trigger.toolContext,
    supplied: args.fireToolContext,
    projectId: args.trigger.projectId as number,
  });

  return { authHeader, actedAs, effectiveToolContext };
};

export const prepareFiring = async (args: {
  triggerPublicId: string;
  source: string;
  fireInput?: Record<string, unknown> | null;
  fireToolContext?: Record<string, string> | null;
  /** See `TriggerFiring.idempotencyKey`. */
  idempotencyKey?: string | null;
  /** Set for a manual fire; absent when nobody called the trigger. */
  caller?: FiringCaller;
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

  const { authHeader, actedAs } = await resolveFiringIdentity({
    trigger,
    projectPublicId,
    caller: args.caller,
  });

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
    idempotencyKey: args.idempotencyKey,
  });

  return {
    firing,
    trigger,
    effectiveInput,
    effectiveToolContext,
    authHeader,
    actedAs,
  };
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
  const {
    firing,
    trigger,
    effectiveInput,
    effectiveToolContext,
    authHeader,
    actedAs,
  } = prepared;

  // Everything is guarded so this never rejects — callers can `void` it as a
  // fire-and-forget background task (webhook/schedule) or await it (manual).
  try {
    firing.status = 'running';
    firing.startedAt = new Date();
    firing.actedAsPrincipalType = actedAs.principalType;
    firing.actedAsPrincipalId = actedAs.principalId;
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
    await finalizeFiringCompleted({ firing, result });
    log('runFiringDispatch: firing=%s completed', firing.publicId);
  } catch (error) {
    await finalizeFiringFailed({
      firing,
      error: toStoredError({
        error,
        opaque: INTERNAL_FAILURE,
        label: 'trigger firing',
      }),
    });
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

    const { authHeader, actedAs, effectiveToolContext } =
      await resolveDispatchCredentials({ trigger });

    await runFiringDispatch({
      firing,
      trigger,
      effectiveInput: (firing.input as Record<string, unknown> | null) ?? {},
      effectiveToolContext,
      authHeader,
      actedAs,
    });
  } catch (error) {
    await finalizeFiringFailed({
      firing,
      error: toStoredError({
        error,
        opaque: INTERNAL_FAILURE,
        label: 'trigger firing',
      }),
    });
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
  caller?: FiringCaller;
}) => {
  const prepared = await prepareFiring(args);
  return runFiringDispatch(prepared);
};
