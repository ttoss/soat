/**
 * The parts of the MCP wire protocol both halves of an `mcp` binding read: how
 * a JSON-RPC message is framed in an answer, how a protocol-level error is
 * spelled, and what a `tools/call` result means.
 *
 * Its own leaf module so the listing (`mcpToolListing.ts`) and the call
 * (`agentToolResolverMcp.ts`) share one reading of the protocol rather than
 * each keeping the subset it happened to need (#1301).
 */
import { isPlainObject } from './plainObject';

/**
 * A tool call that reached the server and came back a failure — a JSON-RPC
 * `error` member, or a result the server flagged `isError`.
 *
 * Thrown rather than returned: the AI SDK turns a throw into a tool error the
 * model sees and can react to, which is what a failure is. Returned, it
 * reaches the model as a successful result whose text happens to describe a
 * failure, and nothing records that the call failed.
 */
export class McpToolError extends Error {
  toolName: string;
  url: string;

  constructor(args: { message: string; toolName: string; url: string }) {
    super(args.message);
    this.name = 'McpToolError';
    this.toolName = args.toolName;
    this.url = args.url;
  }
}

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

/** Reads a JSON-RPC answer whichever of the two framings it arrived in. */
export const parseJsonRpcBody = async (
  response: Response
): Promise<unknown> => {
  const raw = await response.text();
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
 * `type` is absent as well as `'text'` because servers omit it and the reader
 * this replaces never looked: a block with a string `text` was that block's
 * text. Narrowing to the spelled type here would silently turn those answers
 * into block arrays.
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
 * Turns a `tools/call` answer into the tool's output, throwing
 * {@link McpToolError} for either kind of failure the protocol can report.
 */
export const readMcpCallResult = (args: {
  body: unknown;
  toolName: string;
  url: string;
}): unknown => {
  const errorReason = jsonRpcErrorReason({
    body: args.body,
    method: 'tools/call',
  });
  if (errorReason !== null) {
    throw new McpToolError({
      message: errorReason,
      toolName: args.toolName,
      url: args.url,
    });
  }

  const result = readResult(args.body);
  if (result?.isError === true) {
    throw new McpToolError({
      message: `tools/call reported a tool error: ${describeFailure(result)}`,
      toolName: args.toolName,
      url: args.url,
    });
  }

  return readSuccessfulResult({ result, body: args.body });
};
