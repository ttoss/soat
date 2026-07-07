import { Cron } from 'croner';
import { db } from 'src/db';

import { DomainError } from '../errors';

export const TRIGGER_TYPES = ['manual', 'webhook', 'schedule'] as const;
export const TRIGGER_TARGET_TYPES = ['orchestration', 'agent', 'tool'] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];
export type TriggerTargetType = (typeof TRIGGER_TARGET_TYPES)[number];

/**
 * The permission action a caller must hold — in addition to `triggers:*` — to
 * bind a trigger to (or fire) a target of the given type. This is the
 * no-privilege-escalation guard: you can only make a trigger start something you
 * could start yourself.
 */
export const targetStartAction = (targetType: string): string => {
  switch (targetType) {
    case 'orchestration':
      return 'orchestrations:StartRun';
    case 'agent':
      return 'agents:CreateAgentGeneration';
    case 'tool':
      return 'tools:CallTool';
    default:
      throw new DomainError(
        'VALIDATION_FAILED',
        `Unknown target_type '${targetType}'.`
      );
  }
};

/**
 * Validates the transport-independent shape invariants of a trigger:
 * - `cron` is required for schedule triggers and rejected for all other types.
 * - `action` is only valid for tool targets.
 *
 * Deeper, DB-backed rules (target existence, tool subtype requiring/forbidding
 * an action, client tools being non-executable) are enforced in
 * {@link resolveAndValidateTarget}. Throws `DomainError` on the first violation.
 */
export const validateTriggerShape = (args: {
  type: string;
  targetType: string;
  action?: string | null;
  cron?: string | null;
}): void => {
  if (args.type === 'schedule') {
    if (!args.cron) {
      throw new DomainError(
        'TRIGGER_ACTION_NOT_ALLOWED',
        'cron is required for schedule triggers.'
      );
    }
  } else if (args.cron) {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      'cron is only valid for schedule triggers.'
    );
  }

  if (args.targetType !== 'tool' && args.action) {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      'action is only valid for tool targets.'
    );
  }
};

/**
 * Validates a strict 5-field cron expression evaluated in UTC. Throws
 * `INVALID_CRON_EXPRESSION` when the expression is not exactly 5 fields or
 * cannot be parsed.
 */
export const validateCronExpression = (cron: string): void => {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new DomainError(
      'INVALID_CRON_EXPRESSION',
      'A trigger cron expression must have exactly 5 fields (UTC).',
      { cron }
    );
  }
  try {
    // Constructing a Cron throws on an unparseable pattern.
    new Cron(cron, { timezone: 'UTC' });
  } catch {
    throw new DomainError(
      'INVALID_CRON_EXPRESSION',
      `Invalid cron expression: '${cron}'.`,
      { cron }
    );
  }
};

/**
 * Computes the next UTC fire time for a cron expression, relative to `from`
 * (defaults to now). Returns `null` when the schedule has no future occurrence.
 */
export const computeNextFireAt = (cron: string, from?: Date): Date | null => {
  const c = new Cron(cron, { timezone: 'UTC' });
  return from ? c.nextRun(from) : c.nextRun();
};

const assertTargetExists = async (args: {
  found: boolean;
  targetId: string;
  label: string;
}): Promise<void> => {
  if (!args.found) {
    throw new DomainError(
      'TRIGGER_TARGET_NOT_FOUND',
      `${args.label} '${args.targetId}' not found in this project.`
    );
  }
};

/**
 * Resolves a trigger's target within the project and enforces target-specific
 * rules:
 * - the target must exist in the same project and match `targetType`;
 * - `soat`/`mcp` tool targets require an `action`; other tool types reject it;
 * - `client` tools cannot execute server-side and are rejected outright.
 *
 * Throws `DomainError` on any violation.
 */
export const resolveAndValidateTarget = async (args: {
  projectId: number;
  targetType: string;
  targetId: string;
  action?: string | null;
}): Promise<void> => {
  const where = { publicId: args.targetId, projectId: args.projectId };

  if (args.targetType === 'orchestration') {
    const orchestration = await db.Orchestration.findOne({ where });
    await assertTargetExists({
      found: Boolean(orchestration),
      targetId: args.targetId,
      label: 'Orchestration',
    });
    return;
  }

  if (args.targetType === 'agent') {
    const agent = await db.Agent.findOne({ where });
    await assertTargetExists({
      found: Boolean(agent),
      targetId: args.targetId,
      label: 'Agent',
    });
    return;
  }

  const tool = await db.Tool.findOne({ where });
  await assertTargetExists({
    found: Boolean(tool),
    targetId: args.targetId,
    label: 'Tool',
  });

  const toolType = tool!.type as string;
  if (toolType === 'client') {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      'client tools cannot be executed server-side and cannot be a trigger target.'
    );
  }
  if ((toolType === 'soat' || toolType === 'mcp') && !args.action) {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      `${toolType} tool targets require an 'action'.`
    );
  }
};

/**
 * Runs the full config validation for a trigger (shape → cron → target). Shared
 * by create and update so the rules live in one place.
 */
export const assertTriggerConfigValid = async (args: {
  type: string;
  targetType: string;
  targetId: string;
  projectId: number;
  action?: string | null;
  cron?: string | null;
  validateTarget?: boolean;
}): Promise<void> => {
  validateTriggerShape({
    type: args.type,
    targetType: args.targetType,
    action: args.action,
    cron: args.cron,
  });
  if (args.type === 'schedule' && args.cron) {
    validateCronExpression(args.cron);
  }
  if (args.validateTarget !== false) {
    await resolveAndValidateTarget({
      projectId: args.projectId,
      targetType: args.targetType,
      targetId: args.targetId,
      action: args.action,
    });
  }
};
