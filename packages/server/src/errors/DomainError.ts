import { ERROR_CODES, type ErrorCode } from './codes';

/** A key carrying an interior capital — `taskId`, `providerStatusCode`. */
const camelCaseKeys = (meta: Record<string, unknown> | undefined): string[] => {
  return Object.keys(meta ?? {}).filter((key) => {
    return /[a-z][A-Z]/.test(key);
  });
};

/** A refusal another party decided, answered with its own status and code. */
export type RelayedRefusal = { code: string; httpStatus: number };

export class DomainError extends Error {
  /** The registry entry: hint, docs page and, unless relayed, the status. */
  public readonly code: ErrorCode;
  /** What the response and a stored error carry: `code`, or a relayed one. */
  public readonly wireCode: string;
  public readonly httpStatus: number;
  public readonly meta: Record<string, unknown> | undefined;
  /** Another party decided it: its status and code are answered as given. */
  public readonly relayed: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    meta?: Record<string, unknown>,
    options?: { cause?: unknown; relayed?: RelayedRefusal }
  ) {
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
    this.wireCode = options?.relayed?.code ?? code;
    this.httpStatus =
      options?.relayed?.httpStatus ?? ERROR_CODES[code].httpStatus;
    this.meta = meta;
    this.relayed = options?.relayed !== undefined;

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
