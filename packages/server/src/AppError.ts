class AppError extends Error {
  public readonly cause: unknown;
  public readonly status: number;

  constructor(args: { message: string; cause?: unknown; status?: number }) {
    super(args.message);
    this.name = 'AppError';
    this.cause = args.cause;
    this.status = args.status ?? 500;
  }
}

export { AppError };
