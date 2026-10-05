import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local OpenAI-compatible chat endpoint, so an agent generation runs the real
 * provider client, metering and recording end to end without a live model.
 * `reply` builds each `chat.completion` body from the parsed request; the
 * default answers every call with one short assistant message.
 */
export type StubChatProvider = {
  baseUrl: string;
  /** How many completions the stub has answered. */
  completions: () => number;
  close: () => Promise<void>;
};

type ChatRequest = {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: unknown[];
};

export const stubCompletion = (args: {
  model?: string;
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: Record<string, unknown> | null;
}): Record<string, unknown> => {
  const toolCalls = args.toolCalls ?? [];
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 0,
    model: args.model ?? 'stub-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: args.content ?? 'stub reply',
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((call) => {
                  return {
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  };
                }),
              }
            : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    // `null` omits the field entirely: a provider that reports no usage.
    ...(args.usage === null
      ? {}
      : {
          usage: args.usage ?? {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
  };
};

export const startStubChatProvider = async (args?: {
  reply?: (request: ChatRequest) => Record<string, unknown>;
}): Promise<StubChatProvider> => {
  let answered = 0;
  // The default answers as the model it was asked for, so a call meters
  // against the provider's configured model.
  const reply =
    args?.reply ??
    ((request: ChatRequest) => {
      return stubCompletion({ model: request.model });
    });

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      answered += 1;
      const body = raw ? (JSON.parse(raw) as ChatRequest) : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply(body)));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    completions: () => {
      return answered;
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
