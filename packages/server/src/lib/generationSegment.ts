/**
 * A generation's running segment: the lease its claim write took, the timers
 * that renew it and enforce its deadline, and the one abort signal every model
 * and tool call of the segment runs under.
 *
 * Only the two claim writes start one (`createGenerationRecord`,
 * `claimPausedGeneration`), and only `settleGeneration` ends one, so the token
 * a settle fences by is always the one its own claim wrote.
 */
import { Op } from '@ttoss/postgresdb';
import type { Tool } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  type GenerationInstrumentation,
  generationInstrumentation,
} from './generationInstrumentation';
import {
  durationFromEnv,
  holdLease,
  leaseExpiry,
  newLeaseToken,
} from './leases';
import { loggableError } from './loggableError';
import { type TraceStepTarget, writeTraceStep } from './traceStepStore';

const log = createDebug('soat:generation');

const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
const DEFAULT_MODEL_CALL_TIMEOUT_MS = 10 * 60 * 1000;

// Two renewals may be lost before the sweep may take the generation.
const RENEWALS_PER_TTL = 3;

export const generationLeaseTtlMs = (): number => {
  return durationFromEnv({
    name: 'GENERATION_LEASE_TTL_MS',
    fallbackMs: DEFAULT_LEASE_TTL_MS,
  });
};

export const generationDeadlineMs = (): number => {
  return durationFromEnv({
    name: 'GENERATION_DEADLINE_MS',
    fallbackMs: DEFAULT_DEADLINE_MS,
  });
};

const modelCallTimeoutMs = (): number => {
  return durationFromEnv({
    name: 'GENERATION_MODEL_CALL_TIMEOUT_MS',
    fallbackMs: DEFAULT_MODEL_CALL_TIMEOUT_MS,
  });
};

/** The columns a claim write sets. */
export type GenerationLease = {
  leaseToken: string;
  leaseExpiresAt: Date;
  deadlineAt: Date;
};

/** The columns a settle or a pause writes: the claim is over. */
export const NO_GENERATION_LEASE = {
  leaseToken: null,
  leaseExpiresAt: null,
  deadlineAt: null,
} as const;

export const newGenerationLease = (): GenerationLease => {
  return {
    leaseToken: newLeaseToken(),
    leaseExpiresAt: leaseExpiry({ ttlMs: generationLeaseTtlMs() }),
    deadlineAt: leaseExpiry({ ttlMs: generationDeadlineMs() }),
  };
};

type Segment = {
  token: string;
  controller: AbortController;
  stop: () => void;
};

const segments = new Map<string, Segment>();

const deadlineExceeded = (): DomainError => {
  return new DomainError(
    'GENERATION_DEADLINE_EXCEEDED',
    'The generation ran past its deadline and was cancelled.',
    { deadline_ms: generationDeadlineMs() }
  );
};

const leaseLost = (generationId: string): DomainError => {
  return new DomainError(
    'GENERATION_INTERRUPTED',
    'The generation settled elsewhere while this process was running it.',
    { generation_id: generationId }
  );
};

/**
 * Extends the lease while the row is still this segment's and its deadline has
 * not passed; `false` once either stops holding. A write that throws proves
 * neither, so it answers nothing and the next renewal tries again.
 */
const renewLease = async (args: {
  generationId: string;
  token: string;
}): Promise<boolean | undefined> => {
  try {
    const [renewed] = await db.Generation.update(
      { leaseExpiresAt: leaseExpiry({ ttlMs: generationLeaseTtlMs() }) },
      {
        where: {
          publicId: args.generationId,
          status: 'running',
          leaseToken: args.token,
          deadlineAt: { [Op.gt]: new Date() },
        },
      }
    );
    return renewed > 0;
  } catch (error) {
    log('renewLease: failed %s %o', args.generationId, loggableError(error));
    return undefined;
  }
};

/**
 * Cancels what runs under the segment's signal. The segment keeps its token,
 * so the failure path still settles under its own lease.
 */
const abortSegment = (args: { generationId: string; reason: unknown }) => {
  const segment = segments.get(args.generationId);
  if (!segment) return;
  segment.stop();
  segment.controller.abort(args.reason);
};

/** Ends the segment: its timers stop and its token is forgotten. */
export const endGenerationSegment = (args: { generationId: string }): void => {
  const segment = segments.get(args.generationId);
  if (!segment) return;
  segments.delete(args.generationId);
  segment.stop();
};

/** Why the segment's signal aborted (deadline, lease lost), if it did. */
export const segmentAbortReason = (generationId: string): unknown => {
  const signal = segments.get(generationId)?.controller.signal;
  return signal?.aborted ? signal.reason : undefined;
};

/** Starts the segment a claim write just took `lease` for. */
export const startGenerationSegment = (args: {
  generationId: string;
  lease: GenerationLease;
}): void => {
  const { generationId } = args;
  const token = args.lease.leaseToken;
  log('startGenerationSegment: generationId=%s', generationId);
  endGenerationSegment({ generationId });

  const controller = new AbortController();
  const deadline = setTimeout(
    () => {
      log('startGenerationSegment: deadline generationId=%s', generationId);
      abortSegment({ generationId, reason: deadlineExceeded() });
    },
    Math.max(0, args.lease.deadlineAt.getTime() - Date.now())
  );
  deadline.unref?.();
  const heartbeat = holdLease({
    intervalMs: Math.max(
      1,
      Math.floor(generationLeaseTtlMs() / RENEWALS_PER_TTL)
    ),
    renew: () => {
      return renewLease({ generationId, token });
    },
    onLost: () => {
      log('startGenerationSegment: lease lost generationId=%s', generationId);
      abortSegment({ generationId, reason: leaseLost(generationId) });
    },
  });

  segments.set(generationId, {
    token,
    controller,
    stop: () => {
      clearTimeout(deadline);
      heartbeat.release();
    },
  });
};

/** The token this process's segment of the generation holds, if it runs one. */
export const segmentLeaseToken = (generationId: string): string | undefined => {
  return segments.get(generationId)?.token;
};

/** Renews the lease at a progress boundary: a step or a tool call ending. */
const noteSegmentProgress = (generationId: string): void => {
  const segment = segments.get(generationId);
  if (!segment) return;
  void renewLease({ generationId, token: segment.token });
};

/** The index the SDK gives a step within its call. */
const stepNumberOf = (step: unknown): number | undefined => {
  if (typeof step !== 'object' || step === null) return undefined;
  if (!('stepNumber' in step) || typeof step.stepNumber !== 'number') {
    return undefined;
  }
  return step.stepNumber;
};

/**
 * The cancellation, timeout, progress and tool set every model call of a
 * segment runs under: the segment's deadline and lease, plus `signal` (the
 * request, a session superseding the turn). The SDK hands the signal to every
 * tool. `tools` goes to the SDK only from here, so the instrumentation reads
 * the set the call runs.
 *
 * Each step is recorded as it ends, at `steps.firstIndex` (the steps the turn
 * spent before this call) plus its number; the SDK awaits it before going on.
 */
export const segmentCallOptions = (args: {
  generationId: string;
  steps: { target: TraceStepTarget; firstIndex: number };
  tools: Record<string, Tool>;
  signal?: AbortSignal;
  onStepEnd?: (step: unknown) => void;
}): Pick<
  GenerationInstrumentation,
  'onStepStart' | 'onToolExecutionStart' | 'onToolExecutionEnd'
> & {
  tools: Record<string, Tool> | undefined;
  abortSignal?: AbortSignal;
  timeout: { stepMs: number };
  onStepEnd: (step: unknown) => Promise<void>;
} => {
  const own = segments.get(args.generationId)?.controller.signal;
  const signals = [own, args.signal].filter((signal) => {
    return signal !== undefined;
  });
  const instrumentation = generationInstrumentation({
    generationId: args.generationId,
    firstIndex: args.steps.firstIndex,
    tools: args.tools,
  });
  let ended = 0;
  return {
    tools: Object.keys(args.tools).length > 0 ? args.tools : undefined,
    abortSignal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    timeout: { stepMs: modelCallTimeoutMs() },
    onStepStart: instrumentation.onStepStart,
    onToolExecutionStart: instrumentation.onToolExecutionStart,
    onToolExecutionEnd: async (event) => {
      noteSegmentProgress(args.generationId);
      await instrumentation.onToolExecutionEnd(event);
    },
    onStepEnd: async (step) => {
      noteSegmentProgress(args.generationId);
      args.onStepEnd?.(step);
      const stepNumber = stepNumberOf(step) ?? ended;
      ended = stepNumber + 1;
      await writeTraceStep({
        target: args.steps.target,
        firstIndex: args.steps.firstIndex,
        stepNumber,
        step,
      });
      await instrumentation.stepEnded(stepNumber);
    },
  };
};
