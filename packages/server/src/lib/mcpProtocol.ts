/**
 * The parts of the MCP wire protocol both halves of an `mcp` binding read: how
 * a JSON-RPC message is framed in an answer, how a protocol-level error is
 * spelled, and what a `tools/call` result means.
 *
 * Its own leaf module so the listing (`mcpToolListing.ts`) and the call
 * (`agentToolResolverMcp.ts`) share one reading of the protocol rather than
 * each keeping the subset it happened to need.
 */
import { DomainError } from '../errors';
import { readToolResponseBody } from './httpToolResponse';
import { isPlainObject } from './plainObject';
import {
  readToolErrorEnvelope,
  toolCallError,
  type ToolTrust,
  upstreamErrorMeta,
} from './toolErrorRelay';

/**
 * The JSON-RPC message in a `text/event-stream` answer. The resolver's own
 * `Accept` offers SSE, so a server framing its reply that way is answering
 * correctly; reading only the `data:` lines is what makes that answer usable
 * rather than a parse error.
 */
const parseSseFramedMessage = (raw: string): unknown => {
  const payload = raw
    .split(/\r?\n/)
    .filter((line) => {
      return line.startsWith('data:');
    })
    .map((line) => {
      return line.slice('data:'.length).trimStart();
    })
    .join('');
  if (payload === '') throw new Error('SSE response carried no data line');
  return JSON.parse(payload);
};

/**
 * Reads a JSON-RPC answer whichever of the two framings it arrived in, refused
 * over `TOOL_RESPONSE_MAX_BYTES` like any other tool target's answer.
 */
export const parseJsonRpcBody = async (args: {
  response: Response;
  url: string;
}): Promise<unknown> => {
  const { response } = args;
  const raw = new TextDecoder().decode(
    await readToolResponseBody({ response, url: args.url })
  );
  return (response.headers.get('content-type') ?? '').includes(
    'text/event-stream'
  )
    ? parseSseFramedMessage(raw)
    : JSON.parse(raw);
};

/**
 * The JSON-RPC `error` member as a sentence, or `null` when the message
 * carries none. JSON-RPC reports its errors in a 200 body, so this is the only
 * thing separating a refusal from an answer.
 */
export const jsonRpcErrorReason = (args: {
  body: unknown;
  method: string;
}): string | null => {
  if (!isPlainObject(args.body) || !('error' in args.body)) return null;
  const { error } = args.body;
  if (!isPlainObject(error)) return null;
  return `${args.method} answered the JSON-RPC error ${String(error.code)}: ${String(error.message)}`;
};

type McpContentBlock = { type?: unknown; text?: unknown };

type McpCallResult = {
  isError?: unknown;
  content?: unknown;
  structuredContent?: unknown;
};

const readResult = (body: unknown): McpCallResult | null => {
  if (!isPlainObject(body)) return null;
  const { result } = body;
  return isPlainObject(result) ? result : null;
};

const contentBlocks = (result: McpCallResult | null): McpContentBlock[] => {
  return Array.isArray(result?.content) ? result.content : [];
};

/**
 * `type` is accepted absent as well as `'text'`, because servers omit it: a
 * block with a string `text` is that block's text. Narrowing to the spelled
 * type would silently turn those answers into block arrays.
 */
const blockText = (block: McpContentBlock): string | null => {
  if (typeof block.text !== 'string') return null;
  return block.type === 'text' || block.type === undefined ? block.text : null;
};

const joinedText = (blocks: McpContentBlock[]): string | null => {
  const texts = blocks.map(blockText);
  if (texts.length === 0 || texts.includes(null)) return null;
  return texts.join('\n');
};

/**
 * What a successful call hands the model.
 *
 * `structuredContent` first: a server that publishes an `outputSchema` answers
 * there, and re-deriving the same object by parsing the text block it also
 * sends is guesswork where the server was explicit.
 *
 * Otherwise the `content` blocks. All-text blocks join — a server splitting one
 * answer across blocks means it to be read as one — and the result is parsed as
 * JSON when it is JSON. Anything else (an image, an embedded resource, a mix)
 * is handed over as the block array, because there is no text to flatten it to
 * that would not be a lie about what the server returned.
 */
const readSuccessfulResult = (args: {
  result: McpCallResult | null;
  body: unknown;
}): unknown => {
  const { result } = args;
  if (result?.structuredContent !== undefined) return result.structuredContent;

  const blocks = contentBlocks(result);
  if (blocks.length === 0) return result ?? args.body;

  const text = joinedText(blocks);
  if (text === null) return blocks;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A failed call's content, for the message the model and the log both read. */
const describeFailure = (result: McpCallResult | null): string => {
  const blocks = contentBlocks(result);
  return joinedText(blocks) ?? JSON.stringify(result?.content ?? null);
};

/**
 * A tool call that reached the server and came back a failure: a JSON-RPC
 * `error` member, or a result the server flagged `isError`.
 *
 * Thrown rather than returned: the AI SDK turns a throw into a tool error the
 * model sees and can react to. Returned, it reaches the model as a successful
 * result whose text happens to describe a failure.
 */
const mcpToolError = (args: {
  message: string;
  toolName: string;
  url: string;
  meta?: Record<string, unknown>;
}): DomainError => {
  return new DomainError('MCP_TOOL_ERROR', args.message, {
    mcp_tool: args.toolName,
    mcp_url: args.url,
    ...args.meta,
  });
};

/**
 * Turns a `tools/call` answer into the tool's output, throwing for either kind
 * of failure the protocol can report. A failed result's `structuredContent`
 * envelope is read once, for every code, and relayed by `trust`.
 */
export const readMcpCallResult = (args: {
  body: unknown;
  toolName: string;
  url: string;
  trust: ToolTrust;
}): unknown => {
  const errorReason = jsonRpcErrorReason({
    body: args.body,
    method: 'tools/call',
  });
  if (errorReason !== null) {
    throw mcpToolError({ ...args, message: errorReason });
  }

  const result = readResult(args.body);
  if (result?.isError === true) {
    const structured = isPlainObject(result.structuredContent)
      ? result.structuredContent
      : {};
    throw toolCallError({
      trust: args.trust,
      envelope: readToolErrorEnvelope({
        status: structured.status,
        body: structured,
      }),
      wrap: (envelope) => {
        return mcpToolError({
          ...args,
          message: `tools/call reported a tool error: ${describeFailure(result)}`,
          meta: upstreamErrorMeta(envelope),
        });
      },
    });
  }

  return readSuccessfulResult({ result, body: args.body });
};
