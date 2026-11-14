import createDebug from 'debug';
import { db } from 'src/db';

import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import { authUserOfWork } from '../middleware/auth';
import { authorizationDenied } from './authorizationDenial';
import type { GenerationInputMessage } from './generationInputMessages';
import { principalOfAuthority } from './principals';
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
import { readTargetType } from './triggerValidation';
import {
  captureAuthority,
  narrowAuthority,
  parseWorkAuthority,
  requireWorkAuthority,
  triggerAuthority,
  type WorkAuthority,
  workAuthorityMissing,
} from './workAuthority';

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

/** The principal a firing acted as: the trigger, or the caller of a fire. */
export type FiringPrincipal = { principalType: string; principalId: string };

/**
 * The authority a firing runs under: the trigger's `policy_ids` alone when
 * nobody called it; for a manual fire, the trigger's grant capped by the
 * caller's whole authority, acting as the caller.
 */
const firingAuthority = (args: {
  trigger: InstanceType<(typeof db)['Trigger']>;
  projectPublicId: string;
  caller?: AuthUser;
}): WorkAuthority => {
  const own = triggerAuthority({
    triggerPublicId: args.trigger.publicId as string,
    projectPublicId: args.projectPublicId,
  });
  const { caller } = args;
  if (!caller) return own;
  const { terms } = caller;
  if (terms.grant.holder !== 'user') {
    throw new DomainError(
      'TRIGGER_RECURSION_FORBIDDEN',
      'A trigger-scoped credential cannot fire a trigger.'
    );
  }
  const callerAuthority = captureAuthority({
    authUser: caller,
    projectPublicId: args.projectPublicId,
  })!;
  return {
    ...narrowAuthority({ authority: own, by: callerAuthority }),
    principal: callerAuthority.principal,
    actsFor: callerAuthority.actsFor,
    work: callerAuthority.work,
  };
};

/**
 * Checks that a firing's authority can start the trigger's target, and names
 * who it acts as.
 */
const resolveFiringIdentity = async (args: {
  trigger: InstanceType<(typeof db)['Trigger']>;
  authority: WorkAuthority | null;
}): Promise<{ authority: WorkAuthority; actedAs: FiringPrincipal }> => {
  const { trigger } = args;
  const authority = requireWorkAuthority({
    authority: args.authority,
    work: `Firing of trigger '${trigger.publicId as string}'`,
  });
  const projectPublicId = authority.project;
  if (!projectPublicId) {
    throw workAuthorityMissing({
      work: `Firing of trigger '${trigger.publicId as string}'`,
    });
  }
  const identity = await authUserOfWork({ db, authority });
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
  return { authority, actedAs: principalOfAuthority(authority)! };
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
  authority: WorkAuthority | null;
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
 * The authority is the one the firing row stores; the `tool_context` is
 * resolved again, since a secret may have been rotated since the first
 * attempt.
 */
const resolveDispatchCredentials = async (args: {
  trigger: TriggerInstance;
  stored: unknown;
  fireToolContext?: Record<string, string> | null;
}): Promise<{
  authority: WorkAuthority;
  actedAs: FiringPrincipal;
  effectiveToolContext?: Record<string, string>;
}> => {
  const { authority, actedAs } = await resolveFiringIdentity({
    trigger: args.trigger,
    authority: parseWorkAuthority(args.stored),
  });

  const effectiveToolContext = await resolveStoredToolContext({
    stored: args.trigger.toolContext,
    supplied: args.fireToolContext,
    projectId: args.trigger.projectId as number,
  });

  return { authority, actedAs, effectiveToolContext };
};

export const prepareFiring = async (args: {
  triggerPublicId: string;
  source: string;
  fireInput?: Record<string, unknown> | null;
  fireToolContext?: Record<string, string> | null;
  /** See `TriggerFiring.idempotencyKey`. */
  idempotencyKey?: string | null;
  /** Set for a manual fire; absent when nobody called the trigger. */
  caller?: AuthUser;
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

  const { authority, actedAs } = await resolveFiringIdentity({
    trigger,
    authority: firingAuthority({
      trigger,
      projectPublicId,
      caller: args.caller,
    }),
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
    authority,
  });

  return {
    firing,
    trigger,
    effectiveInput,
    effectiveToolContext,
    authority,
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
    authority,
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
      authority,
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
 * Nothing here is raised. A trigger switched off, a firing with no stored
 * authority, a revoked permission — each is recorded on the row, which is the only place a caller
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

    const { authority, actedAs, effectiveToolContext } =
      await resolveDispatchCredentials({ trigger, stored: firing.authority });

    await runFiringDispatch({
      firing,
      trigger,
      effectiveInput: (firing.input as Record<string, unknown> | null) ?? {},
      effectiveToolContext,
      authority,
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
  caller?: AuthUser;
}) => {
  const prepared = await prepareFiring(args);
  return runFiringDispatch(prepared);
};
