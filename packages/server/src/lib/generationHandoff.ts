/**
 * A sub-agent generation that outlives the builtin call starting it.
 *
 * The call's wait is bounded (`toolCallTimeoutMs`), the generation is not. Past
 * the bound the call answers with the running generation instead of a timeout,
 * and the generation's outcome is reported to the parent as a continuation
 * (`fireAgentContinuation`) once both have settled: reported while the parent
 * still runs, a session turn would collide with the parent's own.
 */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { fireAgentContinuation } from './agentContinuation';
import { toolCallTimeoutMs } from './externalToolCall';
import { onGenerationSettled } from './generationEvents';
import { whenGenerationRecorded } from './generationRecorded';
import { getGenerationTraceId } from './generations';
import {
  completedTurnOutputText,
  loadGenerationWithTrace,
} from './generationTurn';
import { withCallTimeout } from './inProcessApi';
import { loggableError } from './loggableError';
import { isTimeoutError } from './timeoutError';
import { forWork, parseWorkAuthority } from './workAuthority';

const log = createDebug('soat:generation-handoff');

/** The builtin actions whose call hands a running generation back. */
const HANDOFF_ACTIONS: ReadonlySet<string> = new Set([
  'create-agent-generation',
]);

const SETTLED_STATUSES = ['completed', 'failed', 'requires_action'];

/** The call a handoff is keyed by: the parent generation and its tool call. */
export type HandoffCall = { generationId: string; toolCallId: string };

const outcomeText = async (args: {
  child: InstanceType<(typeof db)['Generation']>;
  assistantContent?: string;
}): Promise<string> => {
  const { child } = args;
  if (child.status === 'failed') {
    return `has failed. Error: ${JSON.stringify(child.error ?? null)}.`;
  }
  if (child.status === 'requires_action') {
    return 'is paused waiting for client tool outputs; submit them to its tool-outputs to resume it.';
  }
  const content =
    args.assistantContent ??
    (await completedTurnOutputText(
      await loadGenerationWithTrace({ generationId: child.publicId })
    ));
  return `has completed. Result: ${JSON.stringify(content ?? '')}.`;
};

/**
 * Reports `child` to its parent once both have settled, exactly once: the
 * claim is the conditional write of `reportedAt`.
 */
const reportIfSettled = async (args: {
  childId: string;
  assistantContent?: string;
}): Promise<void> => {
  const pending = await db.Generation.findOne({
    where: { publicId: args.childId, reportedAt: null },
    attributes: ['reportsToGenerationId'],
  });
  if (!pending?.reportsToGenerationId) return;
  const parent = await db.Generation.findOne({
    where: { publicId: pending.reportsToGenerationId },
  });
  if (!parent || parent.status === 'running') return;

  const [claimed, rows] = await db.Generation.update(
    { reportedAt: new Date() },
    {
      where: {
        publicId: args.childId,
        reportedAt: null,
        status: { [Op.in]: SETTLED_STATUSES },
      },
      returning: true,
    }
  );
  if (claimed === 0) return;
  const child = rows[0];
  log('reportIfSettled: child=%s parent=%s', child.publicId, parent.publicId);

  const session = parent.sessionId
    ? await db.Session.findByPk(parent.sessionId, { attributes: ['publicId'] })
    : null;
  const authority = parseWorkAuthority(parent.authority);
  await fireAgentContinuation({
    agentPublicId: parent.agentPublicId,
    projectInternalId: parent.projectId,
    sessionPublicId: session?.publicId ?? null,
    initiatorGenerationId: parent.publicId,
    message: `Generation ${child.publicId} that your call ${child.reportsToToolCallId} started ${await outcomeText({ child, assistantContent: args.assistantContent })}`,
    authority: authority ? forWork({ authority, work: child.publicId }) : null,
  });
};

/**
 * Reports a settled generation, and every one it stopped waiting for. Never
 * rejects: it runs after the generation's answer, with no caller to receive it.
 */
const reportSettled = async (args: {
  generationId: string;
  assistantContent?: string;
}): Promise<void> => {
  try {
    await reportIfSettled({
      childId: args.generationId,
      assistantContent: args.assistantContent,
    });
    const children = await db.Generation.findAll({
      where: { reportsToGenerationId: args.generationId, reportedAt: null },
      attributes: ['publicId'],
    });
    for (const child of children) {
      await reportIfSettled({ childId: child.publicId });
    }
  } catch (error) {
    log(
      'reportSettled: generation=%s failed %o',
      args.generationId,
      loggableError(error)
    );
  }
};

onGenerationSettled(reportSettled);

/**
 * The call's answer once its wait is over: the generation `key` names in the
 * parent's project, marked to report to `call`'s generation. `null` when no
 * generation is recorded under the key yet.
 */
const handOffRunningGeneration = async (args: {
  key: string;
  call: HandoffCall;
  projectId: number;
}): Promise<Record<string, unknown> | null> => {
  const child = await db.Generation.findOne({
    where: { projectId: args.projectId, idempotencyKey: args.key },
  });
  if (!child) return null;
  log('handOffRunningGeneration: child=%s', child.publicId);

  await db.Generation.update(
    {
      reportsToGenerationId: args.call.generationId,
      reportsToToolCallId: args.call.toolCallId,
    },
    { where: { id: child.id, reportsToGenerationId: null } }
  );
  // Settled between the timeout and the mark: no lifecycle event follows.
  void reportSettled({ generationId: child.publicId });

  return {
    status: 'running',
    generation_id: child.publicId,
    trace_id: await getGenerationTraceId({ id: child.publicId }),
    message:
      'The generation is still running. Its outcome is sent to you in a follow-up message once it settles; do not start it again.',
  };
};

/**
 * Past the bound, the generation `key` names once it is recorded. The bound
 * can pass while the call is still writing that record, so a missing row is
 * waited for, not taken as a timeout; the call settling first answers with
 * its own result or error.
 */
const handOffWhenRecorded = async <T>(args: {
  key: string;
  call: HandoffCall;
  pending: Promise<T>;
}): Promise<T | Record<string, unknown>> => {
  const parent = await db.Generation.findOne({
    where: { publicId: args.call.generationId },
    attributes: ['projectId'],
    rejectOnEmpty: true,
  });
  const projectId = parent.projectId as number;
  for (;;) {
    const watch = whenGenerationRecorded({ idempotencyKey: args.key });
    try {
      const child = await handOffRunningGeneration({ ...args, projectId });
      if (child) return child;
      log('handOffWhenRecorded: key=%s not recorded yet', args.key);
      // An announced record reads `undefined`: look it up again.
      const settled = await Promise.race([watch.recorded, args.pending]);
      if (settled !== undefined) return settled;
    } finally {
      watch.cancel();
    }
  }
};

/**
 * The headers a builtin call is sent with, and how it waits: bounded by
 * `toolCallTimeoutMs`, and, when its action may hand off a generation, keyed so
 * the generation it starts is found again and answered with past the bound.
 */
export const handoffFor = (args: {
  def: { name: string };
  rawArgs: Record<string, unknown>;
  call?: HandoffCall | null;
  toolContext?: Record<string, string>;
  contextKeys?: string[] | null;
  buildContextHeaders: (args: {
    toolContext?: Record<string, string>;
    contextKeys?: string[] | null;
  }) => Record<string, string>;
}): {
  headers: Record<string, string>;
  wait: <T>(promise: Promise<T>) => Promise<T | Record<string, unknown>>;
} => {
  const { call } = args;
  const callerKey =
    typeof args.rawArgs.idempotency_key === 'string' &&
    args.rawArgs.idempotency_key !== ''
      ? args.rawArgs.idempotency_key
      : null;
  const key =
    HANDOFF_ACTIONS.has(args.def.name) && call
      ? (callerKey ?? `handoff:${call.generationId}:${call.toolCallId}`)
      : null;
  return {
    // The caller's own key already names the generation; a second conflicts.
    headers: {
      ...args.buildContextHeaders({
        toolContext: args.toolContext,
        contextKeys: args.contextKeys,
      }),
      ...(key && key !== callerKey ? { 'Idempotency-Key': key } : {}),
    },
    wait: (promise) => {
      return withCallTimeout({
        promise,
        ms: toolCallTimeoutMs(),
        label: `Builtin action '${args.def.name}'`,
      }).catch((error: unknown) => {
        if (!key || !call || !isTimeoutError({ error })) throw error;
        return handOffWhenRecorded({ key, call, pending: promise });
      });
    },
  };
};
