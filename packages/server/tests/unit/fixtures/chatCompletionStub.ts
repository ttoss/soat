import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local OpenAI-compatible chat completions endpoint for an `ollama` AI
 * provider's `base_url`, so a generation runs end to end — request
 * serialization, tool dispatch and the response parse included — with only
 * the model replaced.
 *
 * `reply` decides each answer from the request it received: plain text, the
 * tool calls a model would make, or a provider error. Every request body is kept in `requests`, in
 * arrival order, for a test to read what the model was sent.
 */
export type ChatRequestMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string } }>;
  tool_call_id?: string;
};

export type ChatRequest = {
  model?: string;
  messages: ChatRequestMessage[];
  tools?: Array<{ function: { name: string } }>;
};

export type ChatReply =
  | { content: string }
  | {
      toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
    }
  /** A `400`, which the SDK does not retry: the provider refusing the call. */
  | { error: string };

export type ChatCompletionStub = {
  baseUrl: string;
  requests: ChatRequest[];
  close: () => Promise<void>;
};

const completionBody = (args: {
  reply: Exclude<ChatReply, { error: string }>;
  callIndex: number;
}) => {
  const message =
    'content' in args.reply
      ? { role: 'assistant', content: args.reply.content }
      : {
          role: 'assistant',
          content: null,
          tool_calls: args.reply.toolCalls.map((call, index) => {
            return {
              id: `call_${args.callIndex}_${index}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            };
          }),
        };
  return {
    id: `chatcmpl-stub-${args.callIndex}`,
    object: 'chat.completion',
    created: 0,
    model: 'stub-model',
    choices: [
      {
        index: 0,
        message,
        finish_reason: 'content' in args.reply ? 'stop' : 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
};

export const startChatCompletionStub = async (args: {
  reply: (request: ChatRequest) => ChatReply;
}): Promise<ChatCompletionStub> => {
  const requests: ChatRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      const request = JSON.parse(raw) as ChatRequest;
      requests.push(request);
      const reply = args.reply(request);
      if ('error' in reply) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: reply.error, type: 'invalid_request_error' },
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(completionBody({ reply, callIndex: requests.length }))
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

/** The contents of a request's tool-result messages, in order. */
export const toolResultsOf = (request: ChatRequest): string[] => {
  return request.messages
    .filter((message) => {
      return message.role === 'tool';
    })
    .map((message) => {
      return typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
    });
};

type ScriptedToolCall = { name: string; arguments: Record<string, unknown> };

const carriesMarker = (args: { request: ChatRequest; marker: string }) => {
  return JSON.stringify(args.request.messages).includes(args.marker);
};

/**
 * Tool calls scripted for one turn: a request gets them only while it carries
 * that turn's marker and no tool result yet. A stub is shared by a file's
 * tests, so a turn still running in the background (an approval's
 * continuation) must neither take the next turn's script nor be read as it.
 */
export const createTurnScript = () => {
  let armed: { marker: string; toolCalls: ScriptedToolCall[] } | null = null;
  return {
    /** Scripts the next turn; its user message must carry the marker. */
    arm: (toolCalls: ScriptedToolCall[]): string => {
      const marker = `[turn ${randomUUID()}]`;
      armed = { marker, toolCalls };
      return marker;
    },
    reply: (request: ChatRequest): ChatReply => {
      const answered = request.messages.some((message) => {
        return message.role === 'tool';
      });
      if (
        armed &&
        armed.toolCalls.length > 0 &&
        !answered &&
        carriesMarker({ request, marker: armed.marker })
      ) {
        return { toolCalls: armed.toolCalls };
      }
      return { content: 'Done.' };
    },
  };
};

/** The requests of the turn whose messages carry `marker`, in order. */
export const requestsOfTurn = (args: {
  requests: ChatRequest[];
  marker: string;
}): ChatRequest[] => {
  return args.requests.filter((request) => {
    return carriesMarker({ request, marker: args.marker });
  });
};
