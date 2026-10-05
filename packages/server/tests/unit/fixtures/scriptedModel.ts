import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local fakes for a model turn that calls tools: an OpenAI-compatible chat
 * endpoint (an `ollama` provider's `base_url`) whose tool calls the test
 * scripts in the user message, and a target that records every tool request.
 * The turn then runs for real — resolver, guardrail gate, dispatch, metering.
 */

export type ScriptedCall = { name: string; args: Record<string, unknown> };

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
};

export type ChatRequest = {
  messages?: ChatMessage[];
  tools?: Array<{
    function: {
      name: string;
      parameters?: { properties?: object; required?: string[] };
    };
  }>;
};

/**
 * The user message that makes the scripted model propose `calls` in one step.
 * Once the turn carries a result for them, the model answers with those
 * results as its text, so a turn's `output` is what its tools returned.
 */
export const proposeCalls = (calls: ScriptedCall[]) => {
  return { role: 'user', content: JSON.stringify({ calls }) };
};

const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const readBody = (req: http.IncomingMessage): Promise<string> => {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      resolve(raw);
    });
  });
};

const listen = async (server: http.Server): Promise<string> => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

const close = (server: http.Server): Promise<void> => {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
};

const completion = (body: ChatRequest) => {
  const messages = body.messages ?? [];
  const lastUser = messages.reduce((found, message, index) => {
    return message.role === 'user' ? index : found;
  }, -1);
  const script = parseJson(messages[lastUser]?.content) as {
    calls?: ScriptedCall[];
  };
  const results = messages.slice(lastUser + 1).filter((message) => {
    return message.role === 'tool';
  });
  const calls = script?.calls ?? [];

  const message =
    results.length > 0 || calls.length === 0
      ? {
          role: 'assistant',
          content: JSON.stringify(
            results.map((result) => {
              return parseJson(result.content);
            })
          ),
        }
      : {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call, index) => {
            return {
              id: `call_${index}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            };
          }),
        };

  return {
    id: 'chatcmpl-scripted',
    object: 'chat.completion',
    created: 0,
    model: 'stub-model',
    choices: [
      {
        index: 0,
        message,
        finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
};

export type ScriptedModel = {
  baseUrl: string;
  /** Every chat request received, in arrival order. */
  requests: ChatRequest[];
  close: () => Promise<void>;
};

type OfferedSchema = { properties?: object; required?: string[] };

/** The parameters schema the model was last offered for one tool. */
export const offeredSchema = (args: {
  model: ScriptedModel;
  toolName: string;
}): OfferedSchema | undefined => {
  return args.model.requests
    .flatMap((request) => {
      return request.tools ?? [];
    })
    .findLast((entry) => {
      return entry.function.name === args.toolName;
    })?.function.parameters;
};

/** The parameter properties the model was last offered for one tool. */
export const offeredProperties = (args: {
  model: ScriptedModel;
  toolName: string;
}): object | undefined => {
  return offeredSchema(args)?.properties;
};

/** The tool names the model was offered on its last request. */
export const offeredToolNames = (model: ScriptedModel): string[] => {
  return (model.requests.at(-1)?.tools ?? []).map((entry) => {
    return entry.function.name;
  });
};

export const startScriptedModel = async (): Promise<ScriptedModel> => {
  const requests: ChatRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}') as ChatRequest;
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completion(body)));
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    requests,
    close: () => {
      return close(server);
    },
  };
};

export type RecordedRequest = {
  /** The path without its query string; replies and `bodiesAt` key on it. */
  path: string;
  /** The request target as sent, query string included. */
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  /** The JSON body, or `{}` when the body is empty or not JSON. */
  body: Record<string, unknown>;
  raw: string;
};

type TargetReply = {
  status?: number;
  /** Sent as JSON; ignored when `raw` is set. */
  body?: unknown;
  raw?: string;
  contentType?: string;
  delayMs?: number;
  /** Drops the connection without answering. */
  destroy?: boolean;
};

type TargetResponder = (body: Record<string, unknown>) => TargetReply;

export type ToolTarget = {
  baseUrl: string;
  /** Every request received, in arrival order. */
  requests: RecordedRequest[];
  /** The JSON bodies received on one path. */
  bodiesAt: (path: string) => Array<Record<string, unknown>>;
  /** The requests received on one path. */
  requestsAt: (path: string) => RecordedRequest[];
  /** Overrides the reply for one path; every other path answers `{ ok: true }`. */
  reply: (path: string, reply: TargetReply | TargetResponder) => void;
  reset: () => void;
  close: () => Promise<void>;
};

const parseObject = (raw: string): Record<string, unknown> => {
  const parsed = parseJson(raw);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

const sendReply = (res: http.ServerResponse, reply: TargetReply) => {
  res.writeHead(reply.status ?? 200, {
    'Content-Type': reply.contentType ?? 'application/json',
  });
  res.end(reply.raw ?? JSON.stringify(reply.body ?? { ok: true }));
};

export const startToolTarget = async (): Promise<ToolTarget> => {
  const requests: RecordedRequest[] = [];
  const replies = new Map<string, TargetReply | TargetResponder>();

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    const body = parseObject(raw);
    requests.push({
      path,
      url,
      method: req.method ?? '',
      headers: req.headers,
      body,
      raw,
    });
    const configured = replies.get(path) ?? {};
    const reply =
      typeof configured === 'function' ? configured(body) : configured;
    if (reply.destroy) {
      req.socket.destroy();
      return;
    }
    if (reply.delayMs) {
      setTimeout(() => {
        sendReply(res, reply);
      }, reply.delayMs);
      return;
    }
    sendReply(res, reply);
  });
  const baseUrl = await listen(server);

  const requestsAt = (path: string) => {
    return requests.filter((request) => {
      return request.path === path;
    });
  };

  return {
    baseUrl,
    requests,
    requestsAt,
    bodiesAt: (path) => {
      return requestsAt(path).map((request) => {
        return request.body;
      });
    },
    reply: (path, reply) => {
      replies.set(path, reply);
    },
    reset: () => {
      requests.length = 0;
      replies.clear();
    },
    close: () => {
      return close(server);
    },
  };
};
