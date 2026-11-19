/**
 * `pipeSse` timing: the heartbeat (15 s) and the lifetime (5 min) are too
 * long for a request-driven test, so these run the transport on a real HTTP
 * server with short intervals. Framing and error frames are covered at the
 * routes (`agentGeneration.test.ts`, `chats.test.ts`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { DomainError } from 'src/errors';
import { pipeSse, type SseFrame } from 'src/lib/sse';

type Source = {
  frames: AsyncIterable<SseFrame>;
  push: (frame: SseFrame) => void;
  finish: () => void;
  fail: (error: unknown) => void;
  drained: Promise<void>;
};

/** A source the test feeds frame by frame. */
const controlledSource = (): Source => {
  const queue: Array<
    { frame: SseFrame } | { done: true } | { error: unknown }
  > = [];
  let wake: (() => void) | undefined;
  let markDrained: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    markDrained = resolve;
  });
  const enqueue = (item: (typeof queue)[number]) => {
    queue.push(item);
    wake?.();
  };
  async function* frames(): AsyncGenerator<SseFrame> {
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const item = queue.shift()!;
      if ('done' in item) {
        markDrained();
        return;
      }
      if ('error' in item) {
        markDrained();
        throw item.error;
      }
      yield item.frame;
    }
  }
  return {
    frames: frames(),
    push: (frame) => {
      return enqueue({ frame });
    },
    finish: () => {
      return enqueue({ done: true });
    },
    fail: (error) => {
      return enqueue({ error });
    },
    drained,
  };
};

const serve = async (args: {
  source: Source;
  heartbeatMs?: number;
  maxLifetimeMs?: number;
  resume?: () => Record<string, unknown>;
}) => {
  let piped: Promise<void> = Promise.resolve();
  const server = http.createServer((_req, res) => {
    piped = pipeSse({
      res,
      frames: args.source.frames,
      label: 'sse test',
      resume: args.resume,
      heartbeatMs: args.heartbeatMs ?? 60_000,
      maxLifetimeMs: args.maxLifetimeMs ?? 60_000,
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    piped: () => {
      return piped;
    },
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          return resolve();
        });
      });
    },
  };
};

/** Reads the body until `until` matches the text so far, or the stream ends. */
const readUntil = async (args: {
  response: Response;
  until?: (text: string) => boolean;
}): Promise<string> => {
  const reader = args.response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text += decoder.decode(chunk.value, { stream: true });
    if (args.until?.(text)) {
      await reader.cancel();
      return text;
    }
  }
};

describe('pipeSse', () => {
  test('frames a durable frame with its id and a transient one without', async () => {
    const source = controlledSource();
    const server = await serve({ source });
    try {
      const response = await fetch(server.url);
      source.push({ data: { delta: 'a' } });
      source.push({ id: '7', event: 'step', data: { step: 1 } });
      source.finish();

      const text = await readUntil({ response });

      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(text).toBe(
        'data: {"delta":"a"}\n\n' +
          'id: 7\nevent: step\ndata: {"step":1}\n\n' +
          'data: [DONE]\n\n'
      );
    } finally {
      await server.close();
    }
  });

  test('a failure ends with one StoredError frame and no [DONE]', async () => {
    const source = controlledSource();
    const server = await serve({ source });
    try {
      const response = await fetch(server.url);
      source.fail(
        new DomainError('AI_PROVIDER_ERROR', 'Provider returned 503')
      );

      const text = await readUntil({ response });

      expect(text).toBe(
        'data: {"error":{"code":"AI_PROVIDER_ERROR","message":"Provider returned 503"}}\n\n'
      );
    } finally {
      await server.close();
    }
  });

  test('an unexpected failure is INTERNAL_ERROR, its message withheld', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const source = controlledSource();
    const server = await serve({ source });
    try {
      const response = await fetch(server.url);
      source.fail(new Error('connection string leaked'));

      const text = await readUntil({ response });

      expect(text).toBe(
        'data: {"error":{"code":"INTERNAL_ERROR","message":"Internal Server Error"}}\n\n'
      );
    } finally {
      jest.restoreAllMocks();
      await server.close();
    }
  });

  test('a quiet stream carries heartbeat comments', async () => {
    const source = controlledSource();
    const server = await serve({ source, heartbeatMs: 20 });
    try {
      const response = await fetch(server.url);

      const text = await readUntil({
        response,
        until: (body) => {
          return body.split(': heartbeat\n\n').length > 2;
        },
      });

      expect(text.startsWith(': heartbeat\n\n: heartbeat\n\n')).toBe(true);
    } finally {
      source.finish();
      await server.close();
    }
  });

  test('the lifetime closes the stream with a resumable end frame and still drains the source', async () => {
    const source = controlledSource();
    const server = await serve({
      source,
      maxLifetimeMs: 50,
      resume: () => {
        return { generation_id: 'gen_resume' };
      },
    });
    try {
      const response = await fetch(server.url);
      source.push({ data: { delta: 'a' } });

      const text = await readUntil({ response });

      expect(text).toBe(
        'data: {"delta":"a"}\n\n' +
          'event: end\ndata: {"reason":"max_lifetime","generation_id":"gen_resume"}\n\n'
      );
      source.push({ data: { delta: 'unwritten' } });
      source.finish();
      await source.drained;
      await server.piped();
    } finally {
      await server.close();
    }
  });

  test('a client that leaves ends the response and the source still drains', async () => {
    const source = controlledSource();
    const server = await serve({ source });
    try {
      const response = await fetch(server.url);
      source.push({ data: { delta: 'a' } });
      await readUntil({
        response,
        until: (body) => {
          return body.includes('"a"');
        },
      });

      source.push({ data: { delta: 'after leaving' } });
      source.finish();

      await source.drained;
      await server.piped();
    } finally {
      await server.close();
    }
  });
});
