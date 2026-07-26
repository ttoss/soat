import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal in-memory SQS stand-in, spoken over the same AWS JSON 1.0 protocol
 * `@aws-sdk/client-sqs` uses (`X-Amz-Target: AmazonSQS.<Operation>`).
 *
 * It exists so the queue-driver conformance suite can run the **real** SQS
 * driver — real command serialization, real client, real receipt handles —
 * without AWS or Docker. Per the project's testing rules this is a local fake
 * server rather than a mock of our own code: everything above the wire runs for
 * real, so a serialization mistake in the driver fails the test.
 *
 * It implements only what the driver calls, with the semantics the driver
 * depends on: delayed delivery, visibility timeout as a lease, redelivery of
 * messages whose visibility lapses, a receive counter, and delete/extend by
 * receipt handle.
 */
export type FakeSqs = {
  /** Endpoint to point an `SQSClient` at. */
  url: string;
  /** The queue URL to hand the driver. */
  queueUrl: string;
  close: () => Promise<void>;
  /** Messages currently stored, for assertions. */
  size: () => number;
  /** Moves the fake's clock forward, expiring visibility timeouts and delays. */
  advance: (ms: number) => void;
  /** Drops every message and rewinds the clock offset back to real time. */
  reset: () => void;
};

type StoredMessage = {
  messageId: string;
  body: string;
  /** Fake-clock ms at which the message becomes visible. */
  visibleAt: number;
  sentAt: number;
  receiveCount: number;
  receiptHandle: string | null;
};

type OperationResult = Record<string, unknown>;

// The SQS client verifies the MD5 of every message body it sends and receives,
// so the fake must compute it exactly as the service does.
const md5 = (value: string): string => {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
};

const readBody = async (req: http.IncomingMessage): Promise<string> => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw;
};

type QueueState = {
  messages: Map<string, StoredMessage>;
  sequence: number;
  clockOffsetMs: number;
};

const nowOf = (state: QueueState): number => {
  return Date.now() + state.clockOffsetMs;
};

const nextSequence = (state: QueueState): number => {
  state.sequence += 1;
  return state.sequence;
};

const byReceiptHandle = (
  state: QueueState,
  handle: string
): StoredMessage | undefined => {
  return [...state.messages.values()].find((m) => {
    return m.receiptHandle === handle;
  });
};

const sendMessage = (
  state: QueueState,
  input: Record<string, unknown>
): OperationResult => {
  const messageId = `msg-${nextSequence(state)}`;
  const body = String(input.MessageBody ?? '');
  state.messages.set(messageId, {
    messageId,
    body,
    visibleAt: nowOf(state) + Number(input.DelaySeconds ?? 0) * 1000,
    sentAt: nowOf(state),
    receiveCount: 0,
    receiptHandle: null,
  });
  return { MessageId: messageId, MD5OfMessageBody: md5(body) };
};

const receiveMessage = (
  state: QueueState,
  input: Record<string, unknown>
): OperationResult => {
  const max = Number(input.MaxNumberOfMessages ?? 1);
  const visibilitySeconds = Number(input.VisibilityTimeout ?? 30);
  const visible = [...state.messages.values()]
    .filter((m) => {
      return m.visibleAt <= nowOf(state);
    })
    .sort((a, b) => {
      return a.sentAt - b.sentAt;
    })
    .slice(0, max);

  return {
    Messages: visible.map((message) => {
      message.receiveCount += 1;
      message.visibleAt = nowOf(state) + visibilitySeconds * 1000;
      message.receiptHandle = `rh-${message.messageId}-${nextSequence(state)}`;
      return {
        MessageId: message.messageId,
        ReceiptHandle: message.receiptHandle,
        Body: message.body,
        MD5OfBody: md5(message.body),
        Attributes: {
          ApproximateReceiveCount: String(message.receiveCount),
          SentTimestamp: String(message.sentAt),
        },
      };
    }),
  };
};

const deleteMessage = (
  state: QueueState,
  input: Record<string, unknown>
): OperationResult => {
  const message = byReceiptHandle(state, String(input.ReceiptHandle));
  if (message) state.messages.delete(message.messageId);
  return {};
};

const changeMessageVisibility = (
  state: QueueState,
  input: Record<string, unknown>
): OperationResult => {
  const message = byReceiptHandle(state, String(input.ReceiptHandle));
  if (message) {
    message.visibleAt =
      nowOf(state) + Number(input.VisibilityTimeout ?? 0) * 1000;
  }
  return {};
};

const getQueueAttributes = (state: QueueState): OperationResult => {
  const all = [...state.messages.values()];
  const count = (visible: boolean): string => {
    return String(
      all.filter((m) => {
        return visible
          ? m.visibleAt <= nowOf(state)
          : m.visibleAt > nowOf(state);
      }).length
    );
  };
  return {
    Attributes: {
      ApproximateNumberOfMessages: count(true),
      ApproximateNumberOfMessagesNotVisible: count(false),
    },
  };
};

/**
 * The queue itself: message storage plus the handful of SQS operations the
 * driver exercises, over a clock the test can move forward.
 */
const createQueueStore = () => {
  const state: QueueState = {
    messages: new Map<string, StoredMessage>(),
    sequence: 0,
    clockOffsetMs: 0,
  };

  const operations: Record<
    string,
    (input: Record<string, unknown>) => OperationResult
  > = {
    SendMessage: (input) => {
      return sendMessage(state, input);
    },
    ReceiveMessage: (input) => {
      return receiveMessage(state, input);
    },
    DeleteMessage: (input) => {
      return deleteMessage(state, input);
    },
    ChangeMessageVisibility: (input) => {
      return changeMessageVisibility(state, input);
    },
    GetQueueAttributes: () => {
      return getQueueAttributes(state);
    },
  };

  return {
    operations,
    size: () => {
      return state.messages.size;
    },
    advance: (ms: number) => {
      state.clockOffsetMs += ms;
    },
    reset: () => {
      state.messages.clear();
      state.clockOffsetMs = 0;
    },
  };
};

export const startFakeSqs = async (): Promise<FakeSqs> => {
  const store = createQueueStore();

  const server = http.createServer((req, res) => {
    void (async () => {
      // `X-Amz-Target: AmazonSQS.SendMessage` → the operation name.
      const operation = String(req.headers['x-amz-target'] ?? '').split('.')[1];
      const handler = store.operations[operation ?? ''];
      const raw = await readBody(req);
      res.setHeader('Content-Type', 'application/x-amz-json-1.0');
      if (!handler) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            __type: 'InvalidAction',
            message: `Unsupported operation '${operation}'`,
          })
        );
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify(handler(raw ? JSON.parse(raw) : {})));
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    queueUrl: `${url}/000000000000/soat-orchestration-tasks`,
    size: store.size,
    advance: store.advance,
    reset: store.reset,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
