import { DomainError } from '../errors';
import { readCappedBody } from './cappedBody';
import { isPlainObject } from './plainObject';
import { getToolResponseMaxBytes } from './requestBounds';
import { validateExecuteAuth } from './toolAuthConfig';

export const RESPONSE_MODES = ['json', 'base64'] as const;

const hasExecuteUrl = (execute: unknown): boolean => {
  return (
    isPlainObject(execute) &&
    typeof execute.url === 'string' &&
    execute.url !== ''
  );
};

export type ResponseMode = (typeof RESPONSE_MODES)[number];

export const parseResponseMode = (value: unknown): ResponseMode => {
  return value === 'base64' ? 'base64' : 'json';
};

/** The file shape `body_mode: multipart` accepts, so a step can relay it. */
export type ToolFileOutput = {
  content_type: string;
  filename?: string;
  data_base64: string;
};

/**
 * Every write-time rule on an http tool's `execute`, shared by the REST
 * create/update paths, inline tool definitions and the tools formation module.
 *
 * `type` is required so each site states which type the written tool ends up
 * as: `execute.url` is an `http` tool's only target, and a tool stored without
 * one is bindable but fails on every call.
 */
export const validateHttpExecute = (args: {
  type: unknown;
  execute: unknown;
}): void => {
  if (args.type === 'http' && !hasExecuteUrl(args.execute)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'An http tool requires execute.url.'
    );
  }
  validateExecuteAuth(args);
  if (!isPlainObject(args.execute)) return;

  const mode = args.execute.response_mode;
  if (mode === undefined || mode === null) return;
  if (!(RESPONSE_MODES as readonly unknown[]).includes(mode)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `execute.response_mode must be one of: ${RESPONSE_MODES.join(', ')}.`
    );
  }
};

const tooLarge = (args: { url: string; maxBytes: number }): DomainError => {
  return new DomainError(
    'TOOL_RESPONSE_TOO_LARGE',
    `Tool target response exceeds ${args.maxBytes} bytes.`,
    { tool_url: args.url, max_bytes: args.maxBytes }
  );
};

/** A 2xx body over `TOOL_RESPONSE_MAX_BYTES` is refused, whatever its mode. */
export const readToolResponseBody = (args: {
  response: Response;
  url: string;
}): Promise<Buffer> => {
  const maxBytes = getToolResponseMaxBytes();
  return readCappedBody({
    response: args.response,
    maxBytes,
    onOverflow: () => {
      return tooLarge({ url: args.url, maxBytes });
    },
  });
};

/** A non-2xx body only explains the status, so it is cut rather than refused. */
export const readToolErrorBody = async (args: {
  response: Response;
}): Promise<string> => {
  const body = await readCappedBody({
    response: args.response,
    maxBytes: getToolResponseMaxBytes(),
    onOverflow: 'cut',
  });
  return new TextDecoder().decode(body);
};

// RFC 5987 `filename*=charset'lang'value`; a non-UTF-8 value falls back.
const extendedFilename = (disposition: string): string | undefined => {
  const match = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return undefined;
  }
};

const plainFilename = (disposition: string): string | undefined => {
  const match = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(
    disposition
  );
  return match?.[1]?.replace(/\\(.)/g, '$1') ?? match?.[2]?.trim();
};

const filenameFrom = (disposition: string | null): string | undefined => {
  if (!disposition) return undefined;
  const name = extendedFilename(disposition) ?? plainFilename(disposition);
  // A path in the header names a location on the sender, never one here.
  return name?.split(/[/\\]/).pop() || undefined;
};

export const readBase64ToolResponse = async (args: {
  response: Response;
  url: string;
}): Promise<ToolFileOutput> => {
  const body = await readToolResponseBody(args);
  const contentType =
    (args.response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase() || 'application/octet-stream';
  const filename = filenameFrom(
    args.response.headers.get('content-disposition')
  );
  return {
    content_type: contentType,
    ...(filename ? { filename } : {}),
    data_base64: body.toString('base64'),
  };
};
