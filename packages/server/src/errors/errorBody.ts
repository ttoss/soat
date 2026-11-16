import type { ErrorCode } from './codes';
import { docsUrlFor, resolutionFor } from './resolutions';

const envFlag = (name: string): boolean => {
  const value = process.env[name];
  return (
    value !== undefined &&
    ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase())
  );
};

/**
 * `SOAT_OMIT_ERROR_HINTS` and `SOAT_OMIT_ERROR_DOCS_URL`: a deployment fronting
 * this API under its own name drops what it cannot show, each independently.
 * Read per call, like `docsBaseUrl()`.
 */
export const errorHintsOmitted = (): boolean => {
  return envFlag('SOAT_OMIT_ERROR_HINTS');
};

export const errorDocsUrlOmitted = (): boolean => {
  return envFlag('SOAT_OMIT_ERROR_DOCS_URL');
};

/**
 * The response body, in the one shape the API has: `{ error: { code, message,
 * hint?, docs_url?, meta? } }`. The only writer of `hint` and `docs_url`
 * (`tests/harness/errorHintChokepoint.test.mjs`), so every surface that relays
 * an error body (a `builtin` tool result, a refused in-turn tool call, a
 * stored error's `tool_response_body`) inherits the settings.
 */
export const errorBody = (args: {
  code: ErrorCode;
  /** A relayed refusal's own code; `code` still picks the hint and docs. */
  wireCode?: string;
  message: string;
  meta?: Record<string, unknown>;
}) => {
  return {
    error: {
      code: args.wireCode ?? args.code,
      message: args.message,
      ...(!errorHintsOmitted() && { hint: resolutionFor({ code: args.code }) }),
      ...(!errorDocsUrlOmitted() && {
        docs_url: docsUrlFor({ code: args.code }),
      }),
      ...(args.meta !== undefined && { meta: args.meta }),
    },
  };
};
