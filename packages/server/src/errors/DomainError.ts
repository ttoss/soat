import { ERROR_CODES, type ErrorCode } from './codes';

/** A key carrying an interior capital — `taskId`, `providerStatusCode`. */
const camelCaseKeys = (meta: Record<string, unknown> | undefined): string[] => {
  return Object.keys(meta ?? {}).filter((key) => {
    return /[a-z][A-Z]/.test(key);
  });
};

export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly meta: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    meta?: Record<string, unknown>,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = ERROR_CODES[code].httpStatus;
    this.meta = meta;

    // `meta` reaches the wire as-is (error bodies, MCP results, stored
    // `StoredError`s), whose contract is snake_case. Its top-level keys are
    // server-owned, so a camelCase one is a site that skipped the convention;
    // the suite is the enforcement, as for `responseContract`.
    const camel = camelCaseKeys(meta);
    if (process.env.NODE_ENV === 'test' && camel.length > 0) {
      throw new Error(
        `DomainError '${code}' meta has camelCase key(s): ${camel.join(', ')}. ` +
          `Error meta keys are snake_case.`
      );
    }
  }
}
