import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
import { getToolResponseMaxBytes } from './requestBounds';
import { validateExecuteAuth } from './toolAuthConfig';

export const RESPONSE_MODES = ['json', 'base64'] as const;

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
 * create/update paths and the tools formation module.
 */
export const validateHttpExecute = (args: { execute: unknown }): void => {
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

// Read chunk by chunk so an oversized body is refused before it is buffered;
// a declared `Content-Length` can be absent or wrong.
const readBoundedBody = async (args: {
  response: Response;
  url: string;
  maxBytes: number;
}): Promise<Buffer> => {
  const declared = Number(args.response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > args.maxBytes) {
    await args.response.body?.cancel();
    throw tooLarge(args);
  }
  if (!args.response.body) return Buffer.alloc(0);

  const reader = args.response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > args.maxBytes) {
      await reader.cancel();
      throw tooLarge(args);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
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
  const body = await readBoundedBody({
    ...args,
    maxBytes: getToolResponseMaxBytes(),
  });
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
