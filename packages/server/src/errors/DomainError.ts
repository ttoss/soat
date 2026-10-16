import { ERROR_CODES, type ErrorCode } from './codes';

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
  }
}
