import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { createGeneration } from './agents';
import type { GenerationInputMessage } from './generationInputMessages';
import { buildSrn } from './iam';
import { startOrchestrationRun } from './orchestrationEngine';
import { createJwtIsAllowed } from './permissions';
import { callTool } from './tools';
import {
  createFiringRecord,
  finalizeFiringFailed,
  finalizeFiringSucceeded,
  getFiringById,
  mapTriggerFiring,
} from './triggerFirings';
import { signTriggerToken } from './triggerToken';
import { targetStartAction } from './triggerValidation';

const log = createDebug('soat:triggers');

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

const toErrorObject = (err: unknown): Record<string, unknown> => {
  if (err instanceof DomainError) {
    return { code: err.code, message: err.message, meta: err.meta ?? null };
  }
  if (err instanceof Error) {
    return { code: 'INTERNAL', message: err.message };
  }
  return { code: 'INTERNAL', message: String(err) };
};

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

const dispatchToTarget = async (args: {
  targetType: string;
  targetId: string;
  action: string | null;
  projectId: number;
  input: Record<string, unknown>;
  authHeader: string;
  triggerId: string;
}): Promise<Record<string, unknown>> => {
  if (args.targetType === 'orchestration') {
    const run = await startOrchestrationRun({
      orchestrationPublicId: args.targetId,
      projectIds: [args.projectId],
      input: args.input,
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
  }

  if (args.targetType === 'agent') {
    const generation = await createGeneration({
      agentId: args.targetId,
      projectIds: [args.projectId],
      messages: buildAgentMessages(args.input),
      stream: false,
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
  }

  const output = await callTool({
    id: args.targetId,
    projectIds: [args.projectId],
    action: args.action ?? undefined,
    input: args.input,
    authHeader: args.authHeader,
  });
  return {
    target_type: 'tool',
    result_id: null,
    status: 'completed',
    output: truncateOutput(output),
  };
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
  authHeader: string;
};

/**
 * Runs the synchronous pre-flight for a firing and creates a `pending` firing
 * record. Throws `DomainError` — surfaced as an HTTP error for a manual fire,
 * or returned before a webhook fire's `202`: inactive trigger, unavailable
 * creator, revoked target-start permission, invalid input. The returned handle
 * is executed by {@link runFiringDispatch}.
 */
export const prepareFiring = async (args: {
  triggerPublicId: string;
  source: string;
  fireInput?: Record<string, unknown> | null;
}): Promise<PreparedFiring> => {
  log('prepareFiring: trigger=%s source=%s', args.triggerPublicId, args.source);

  const trigger = await db.Trigger.findOne({
    where: { publicId: args.triggerPublicId },
  });
  if (!trigger) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trigger '${args.triggerPublicId}' not found.`
    );
  }
  if (!trigger.active) {
    throw new DomainError(
      'TRIGGER_NOT_ACTIVE',
      `Trigger '${args.triggerPublicId}' is inactive.`
    );
  }

  const project = await db.Project.findOne({
    where: { id: trigger.projectId as number },
  });
  const projectPublicId = project?.publicId as string;

  const authHeader = await resolveRunAsAuthHeader({ trigger, projectPublicId });

  const effectiveInput: Record<string, unknown> = {
    ...((trigger.input as Record<string, unknown> | null) ?? {}),
    ...(args.fireInput ?? {}),
  };
  await assertFireInputValid({ trigger, input: effectiveInput });

  const firing = await createFiringRecord({
    triggerId: trigger.id as number,
    projectId: trigger.projectId as number,
    source: args.source,
    input: effectiveInput,
  });

  return { firing, trigger, effectiveInput, authHeader };
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
  const { firing, trigger, effectiveInput, authHeader } = prepared;

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
    const finalized = await getFiringById({ internalId: firing.id as number });
    if (finalized) return finalized;
  } catch {
    // Fall back to the in-memory instance if the re-fetch fails.
  }
  return mapTriggerFiring(firing);
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
}) => {
  const prepared = await prepareFiring(args);
  return runFiringDispatch(prepared);
};
