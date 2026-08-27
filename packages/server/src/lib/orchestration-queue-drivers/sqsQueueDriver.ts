import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import createDebug from 'debug';

import { DomainError } from '../../errors';
import {
  claimLatencySnapshot,
  recordClaimLatency,
} from '../orchestrationQueueMetrics';
import { taskLeaseTtlMs } from './config';
import type {
  ClaimedTask,
  OrchestrationQueueDriver,
  QueueStats,
  RunTaskKind,
} from './types';

const log = createDebug('soat:orchestrations');

// SQS caps a single ReceiveMessage at 10 messages and a delay at 15 minutes.
const SQS_MAX_RECEIVE = 10;
const SQS_MAX_DELAY_SECONDS = 900;

const RUN_TASK_KINDS: readonly RunTaskKind[] = ['continue', 'wake', 'resume'];

/** The message body the driver writes and reads back — the queue carries only
 * the run reference, never run state (state lives in Postgres). */
type SqsTaskBody = { orchestrationRunId: number; kind: RunTaskKind };

const isRunTaskKind = (value: unknown): value is RunTaskKind => {
  return (
    typeof value === 'string' && RUN_TASK_KINDS.includes(value as RunTaskKind)
  );
};

/**
 * Parses a message body back into a task reference. A body that is not the
 * shape this driver writes (hand-published, or left by an older format) is
 * rejected rather than coerced — the caller drops the message so it is not
 * redelivered forever.
 */
export const parseSqsTaskBody = (
  raw: string | undefined
): SqsTaskBody | null => {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { orchestrationRunId, kind } = parsed as Record<string, unknown>;
  if (
    typeof orchestrationRunId !== 'number' ||
    !Number.isFinite(orchestrationRunId)
  )
    return null;
  if (!isRunTaskKind(kind)) return null;
  return { orchestrationRunId, kind };
};

/** Whole seconds of delay between `now` and `availableAt`, clamped to what SQS
 * accepts. A longer wait than SQS can express becomes the 15-minute maximum:
 * the task simply becomes visible early and the run's own wake time (persisted
 * on the run) still gates whether there is anything to do. */
export const sqsDelaySeconds = (args: {
  availableAt?: Date;
  now: Date;
}): number => {
  if (!args.availableAt) return 0;
  const deltaMs = args.availableAt.getTime() - args.now.getTime();
  if (deltaMs <= 0) return 0;
  return Math.min(SQS_MAX_DELAY_SECONDS, Math.ceil(deltaMs / 1000));
};

const requiredQueueUrl = (): string => {
  const url = process.env.ORCHESTRATION_QUEUE_SQS_QUEUE_URL;
  if (!url) {
    throw new DomainError(
      'QUEUE_DRIVER_MISCONFIGURED',
      'ORCHESTRATION_QUEUE_SQS_QUEUE_URL must be set when ORCHESTRATION_QUEUE_DRIVER=sqs.'
    );
  }
  return url;
};

/**
 * Builds the SQS client. `ORCHESTRATION_QUEUE_SQS_ENDPOINT` points the client at
 * a non-AWS endpoint (LocalStack, ElasticMQ, or the in-test fake) — credentials
 * and region otherwise resolve through the standard AWS provider chain.
 */
const createSqsClient = (): SQSClient => {
  const endpoint = process.env.ORCHESTRATION_QUEUE_SQS_ENDPOINT;
  const region =
    process.env.ORCHESTRATION_QUEUE_SQS_REGION ??
    process.env.AWS_REGION ??
    'us-east-1';
  return new SQSClient({ region, ...(endpoint ? { endpoint } : {}) });
};

/** The bound queue a driver instance talks to: a lazily-built client and the
 * queue URL, both resolved on first use so importing this module never requires
 * SQS configuration. */
type SqsContext = { client: () => SQSClient; queueUrl: () => string };

const sqsEnqueue = async (
  ctx: SqsContext,
  args: { orchestrationRunId: number; kind: RunTaskKind; availableAt?: Date }
): Promise<void> => {
  const body: SqsTaskBody = {
    orchestrationRunId: args.orchestrationRunId,
    kind: args.kind,
  };
  const delaySeconds = sqsDelaySeconds({
    availableAt: args.availableAt,
    now: new Date(),
  });
  log(
    'sqs.enqueue: orchestrationRunId=%d kind=%s delay=%ds',
    args.orchestrationRunId,
    args.kind,
    delaySeconds
  );
  await ctx.client().send(
    new SendMessageCommand({
      QueueUrl: ctx.queueUrl(),
      MessageBody: JSON.stringify(body),
      ...(delaySeconds > 0 ? { DelaySeconds: delaySeconds } : {}),
    })
  );
};

/**
 * Turns one received message into a claimed task, recording its claim latency
 * (`SentTimestamp` → now) into the shared metrics ring. Returns `null` for a
 * message this driver cannot act on; the caller drops those.
 */
const toClaimedTask = (args: {
  message: Message;
  now: Date;
}): ClaimedTask | null => {
  const body = parseSqsTaskBody(args.message.Body);
  if (!body || !args.message.ReceiptHandle) return null;

  const sentTimestamp = Number(args.message.Attributes?.SentTimestamp);
  if (Number.isFinite(sentTimestamp)) {
    recordClaimLatency({
      at: args.now.getTime(),
      latencyMs: Math.max(0, args.now.getTime() - sentTimestamp),
    });
  }
  return {
    id: args.message.MessageId ?? 'unknown',
    handle: args.message.ReceiptHandle,
    orchestrationRunId: body.orchestrationRunId,
    kind: body.kind,
    attempts: Number(args.message.Attributes?.ApproximateReceiveCount ?? 1),
  };
};

/**
 * Deletes a message the driver cannot decode. Nothing in the runtime can act on
 * it, so leaving it would cycle it through every worker until the queue's
 * redrive policy intervened.
 */
const dropUndecodable = async (
  ctx: SqsContext,
  message: Message
): Promise<void> => {
  log('sqs.claim: dropping undecodable message id=%s', message.MessageId);
  if (!message.ReceiptHandle) return;
  await ctx.client().send(
    new DeleteMessageCommand({
      QueueUrl: ctx.queueUrl(),
      ReceiptHandle: message.ReceiptHandle,
    })
  );
};

const sqsClaim = async (
  ctx: SqsContext,
  args: { limit: number; now?: Date }
): Promise<ClaimedTask[]> => {
  if (args.limit <= 0) return [];
  const now = args.now ?? new Date();
  const response = await ctx.client().send(
    new ReceiveMessageCommand({
      QueueUrl: ctx.queueUrl(),
      MaxNumberOfMessages: Math.min(SQS_MAX_RECEIVE, args.limit),
      // The visibility timeout is the lease: the same TTL the Postgres driver
      // writes into `lease_expires_at`, in whole seconds.
      VisibilityTimeout: Math.max(1, Math.ceil(taskLeaseTtlMs() / 1000)),
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
    })
  );

  const claimed: ClaimedTask[] = [];
  for (const message of response.Messages ?? []) {
    const task = toClaimedTask({ message, now });
    if (!task) {
      await dropUndecodable(ctx, message);
      continue;
    }
    claimed.push(task);
  }
  log('sqs.claim: claimed %d message(s)', claimed.length);
  return claimed;
};

const sqsAck = async (ctx: SqsContext, task: ClaimedTask): Promise<void> => {
  log('sqs.ack: id=%s', task.id);
  await ctx.client().send(
    new DeleteMessageCommand({
      QueueUrl: ctx.queueUrl(),
      ReceiptHandle: task.handle,
    })
  );
};

const sqsRetry = async (
  ctx: SqsContext,
  args: { task: ClaimedTask; availableAt: Date }
): Promise<void> => {
  const seconds = sqsDelaySeconds({
    availableAt: args.availableAt,
    now: new Date(),
  });
  log('sqs.retry: id=%s delay=%ds', args.task.id, seconds);
  await ctx.client().send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: ctx.queueUrl(),
      ReceiptHandle: args.task.handle,
      VisibilityTimeout: seconds,
    })
  );
};

const sqsStats = async (
  ctx: SqsContext,
  args?: { now?: Date }
): Promise<QueueStats> => {
  const now = args?.now ?? new Date();
  const response = await ctx.client().send(
    new GetQueueAttributesCommand({
      QueueUrl: ctx.queueUrl(),
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    })
  );
  const attributes = response.Attributes ?? {};
  return {
    driver: 'sqs',
    queueDepth: Number(attributes.ApproximateNumberOfMessages ?? 0),
    claimedTasks: Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
    // SQS exposes no per-message age on the queue and no per-tenant view: the
    // oldest-task age and the per-project breakdown are Postgres-only.
    oldestQueuedAgeSeconds: null,
    claimLatencyMs: claimLatencySnapshot({ now: now.getTime() }),
    perProject: [],
  };
};

/**
 * The SQS driver, for deployments that standardize on a managed queue.
 *
 * | Queue operation | SQS                                                       |
 * | --------------- | --------------------------------------------------------- |
 * | `enqueue`       | `SendMessage` (`DelaySeconds` for a future `availableAt`)  |
 * | `claim`         | `ReceiveMessage` — the visibility timeout **is** the lease |
 * | `ack`           | `DeleteMessage`                                           |
 * | `retry`         | `ChangeMessageVisibility` (the backoff delay)             |
 * | `failed`        | the queue's redrive policy → dead-letter queue            |
 *
 * At-least-once delivery and lease expiry come from SQS itself, and
 * `ApproximateReceiveCount` is the `attempts` counter; repeated failures are
 * the queue's redrive policy, so configure `maxReceiveCount` and a DLQ there.
 *
 * **Not supported:** per-project `max_concurrent_runs` — SQS hands out whatever
 * is visible and cannot evaluate a per-tenant limit at receive time the way the
 * Postgres claim's SQL join can. Parallelism is bounded only by
 * `ORCHESTRATION_WORKER_CONCURRENCY` per worker; deployments needing
 * per-project limits stay on the Postgres driver.
 */
export const createSqsQueueDriver = (args?: {
  client?: SQSClient;
  queueUrl?: string;
}): OrchestrationQueueDriver => {
  let cachedClient: SQSClient | undefined = args?.client;
  const ctx: SqsContext = {
    client: () => {
      cachedClient ??= createSqsClient();
      return cachedClient;
    },
    queueUrl: () => {
      return args?.queueUrl ?? requiredQueueUrl();
    },
  };

  return {
    name: 'sqs',
    enforcesProjectConcurrency: false,
    enqueue: (enqueueArgs) => {
      return sqsEnqueue(ctx, enqueueArgs);
    },
    claim: (claimArgs) => {
      return sqsClaim(ctx, claimArgs);
    },
    ack: (ackArgs) => {
      return sqsAck(ctx, ackArgs.task);
    },
    retry: (retryArgs) => {
      return sqsRetry(ctx, retryArgs);
    },
    stats: (statsArgs) => {
      return sqsStats(ctx, statsArgs);
    },
  };
};
