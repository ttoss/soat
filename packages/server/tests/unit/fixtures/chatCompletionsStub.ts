import type { IncomingHttpHeaders, Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One answer the stub gives: an HTTP status and a JSON body. */
export type StubReply = { status?: number; body: unknown };

/** A request the stub received, with its JSON body parsed. */
export type RecordedRequest = {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
};

/** A reply chosen from the request it answers. */
export type StubResponder = (request: RecordedRequest) => StubReply;

export type ChatCompletionsStub = {
  /** The `base_url` an `ollama` AI provider points at. */
  baseUrl: string;
  /** Every chat-completions request, in arrival order. */
  completions: RecordedRequest[];
  /** Every request answered by one of the `routes`, in arrival order. */
  routeRequests: RecordedRequest[];
  /** Replaces the reply queue; the last reply repeats once the queue drains. */
  reply: (...replies: Array<StubReply | StubResponder>) => void;
  close: () => Promise<void>;
};

const parseBody = (raw: string): Record<string, unknown> => {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : {};
};

const USAGE = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };

/** A completion that ends the turn with `content` as the answer. */
export const textCompletion = (content: string): StubReply => {
  return {
    body: {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: USAGE,
    },
  };
};

/** A completion that calls each named tool once. */
export const toolCallCompletion = (
  calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>
): StubReply => {
  return {
    body: {
      id: 'chatcmpl-stub-tool',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call) => {
              return {
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args ?? {}),
                },
              };
            }),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: USAGE,
    },
  };
};

/** An upstream failure the provider answers with. */
export const providerFailure = (status: number = 500): StubReply => {
  return { status, body: { error: { message: 'upstream unavailable' } } };
};

/** The names of the tools a recorded completion request offered. */
export const offeredToolNames = (request: RecordedRequest): string[] => {
  const tools = request.body.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const fn = 'function' in entry ? entry.function : undefined;
    if (typeof fn !== 'object' || fn === null || !('name' in fn)) return [];
    return typeof fn.name === 'string' ? [fn.name] : [];
  });
};

/** The `role: "system"` text of a recorded completion request. */
export const systemText = (request: RecordedRequest): string => {
  const messages = request.body.messages;
  if (!Array.isArray(messages)) return '';
  return messages
    .flatMap((message: unknown) => {
      if (typeof message !== 'object' || message === null) return [];
      if (!('role' in message) || message.role !== 'system') return [];
      return 'content' in message && typeof message.content === 'string'
        ? [message.content]
        : [];
    })
    .join('\n');
};

/**
 * A local OpenAI-compatible provider, the LLM boundary a REST test drives a
 * real generation through: every request is a chat completion answered from a
 * queue, except a path that starts with a key of `routes`, which plays an HTTP
 * tool or any other outbound endpoint the turn calls.
 */
export const startChatCompletionsStub = async (
  args: {
    routes?: Record<string, StubResponder>;
  } = {}
): Promise<ChatCompletionsStub> => {
  const completions: RecordedRequest[] = [];
  const routeRequests: RecordedRequest[] = [];
  let queue: Array<StubReply | StubResponder> = [textCompletion('ok')];

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const recorded: RecordedRequest = {
        url: req.url ?? '',
        headers: req.headers,
        body: parseBody(raw),
      };
      const route = Object.entries(args.routes ?? {}).find(([prefix]) => {
        return recorded.url.startsWith(prefix);
      });

      let reply: StubReply;
      if (route) {
        routeRequests.push(recorded);
        reply = route[1](recorded);
      } else {
        completions.push(recorded);
        const next = queue.length > 1 ? (queue.shift() ?? queue[0]) : queue[0];
        reply = typeof next === 'function' ? next(recorded) : next;
      }

      res.writeHead(reply.status ?? 200, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    completions,
    routeRequests,
    reply: (...replies) => {
      queue = replies.length > 0 ? replies : [textCompletion('ok')];
    },
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          return error ? reject(error) : resolve();
        });
      });
    },
  };
};
