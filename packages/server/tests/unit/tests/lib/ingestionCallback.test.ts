import { isIngestionStale } from 'src/lib/ingestionCallback';

type StaleDoc = Parameters<typeof isIngestionStale>[0];

const buildDoc = (overrides: {
  status?: string;
  conversionAttemptId?: string | null;
  updatedAt?: Date | null;
}): StaleDoc => {
  return {
    status: overrides.status ?? 'processing',
    conversionAttemptId: overrides.conversionAttemptId ?? null,
    updatedAt: 'updatedAt' in overrides ? overrides.updatedAt : new Date(),
  } as unknown as StaleDoc;
};

describe('isIngestionStale', () => {
  const originalIngestionTimeout = process.env.INGESTION_STALL_TIMEOUT_MS;
  const originalConversionTimeout = process.env.CONVERSION_STALL_TIMEOUT_MS;

  afterEach(() => {
    if (originalIngestionTimeout === undefined) {
      delete process.env.INGESTION_STALL_TIMEOUT_MS;
    } else {
      process.env.INGESTION_STALL_TIMEOUT_MS = originalIngestionTimeout;
    }
    if (originalConversionTimeout === undefined) {
      delete process.env.CONVERSION_STALL_TIMEOUT_MS;
    } else {
      process.env.CONVERSION_STALL_TIMEOUT_MS = originalConversionTimeout;
    }
  });

  test('returns false for a terminal status', () => {
    expect(isIngestionStale(buildDoc({ status: 'ready' }))).toBe(false);
    expect(isIngestionStale(buildDoc({ status: 'failed' }))).toBe(false);
  });

  test('treats a null updatedAt as epoch, so a pending doc is immediately stale', () => {
    expect(
      isIngestionStale(buildDoc({ status: 'pending', updatedAt: null }))
    ).toBe(true);
  });

  test('a non-numeric INGESTION_STALL_TIMEOUT_MS falls back to the 5-minute default', () => {
    process.env.INGESTION_STALL_TIMEOUT_MS = 'not-a-number';
    const past5Min = new Date(Date.now() - 6 * 60 * 1000);
    expect(isIngestionStale(buildDoc({ updatedAt: past5Min }))).toBe(true);
    expect(isIngestionStale(buildDoc({ updatedAt: new Date() }))).toBe(false);
  });

  test('a negative INGESTION_STALL_TIMEOUT_MS falls back to the 5-minute default', () => {
    process.env.INGESTION_STALL_TIMEOUT_MS = '-100';
    const past5Min = new Date(Date.now() - 6 * 60 * 1000);
    expect(isIngestionStale(buildDoc({ updatedAt: past5Min }))).toBe(true);
  });

  test('a valid custom INGESTION_STALL_TIMEOUT_MS is honored instead of the default', () => {
    process.env.INGESTION_STALL_TIMEOUT_MS = '1000';
    const past2Sec = new Date(Date.now() - 2000);
    expect(isIngestionStale(buildDoc({ updatedAt: past2Sec }))).toBe(true);
    expect(isIngestionStale(buildDoc({ updatedAt: new Date() }))).toBe(false);
  });

  test('a non-numeric CONVERSION_STALL_TIMEOUT_MS falls back to the 30-minute default', () => {
    process.env.CONVERSION_STALL_TIMEOUT_MS = 'nope';
    const past30Min = new Date(Date.now() - 31 * 60 * 1000);
    expect(
      isIngestionStale(
        buildDoc({ conversionAttemptId: 'iat_x', updatedAt: past30Min })
      )
    ).toBe(true);
    expect(
      isIngestionStale(
        buildDoc({ conversionAttemptId: 'iat_x', updatedAt: new Date() })
      )
    ).toBe(false);
  });
});
