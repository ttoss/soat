import {
  DEFAULT_RESOLUTION,
  docsUrlFor,
  ERROR_CODES,
  ERROR_RESOLUTIONS,
  type ErrorCode,
  resolutionFor,
  STATUS_RESOLUTIONS,
} from 'src/errors';

/**
 * A direct test: the registry is a pure lookup over 120+ codes, and the
 * property that matters — *every* code answers with something actionable — is
 * one no REST test can establish, since reaching each code through HTTP would
 * mean provoking 120 distinct failures.
 */
describe('error resolutions', () => {
  const codes = Object.keys(ERROR_CODES) as ErrorCode[];

  test('every registered code resolves to a non-empty hint', () => {
    const empty = codes.filter((code) => {
      return resolutionFor({ code }).trim().length === 0;
    });

    expect(empty).toEqual([]);
  });

  test('every hint is a sentence, not a label', () => {
    const tooShort = codes.filter((code) => {
      return resolutionFor({ code }).length < 30;
    });

    expect(tooShort).toEqual([]);
  });

  test('an explicit entry wins over the status-class fallback', () => {
    expect(resolutionFor({ code: 'UNAUTHORIZED' })).toBe(
      ERROR_RESOLUTIONS.UNAUTHORIZED
    );
    expect(resolutionFor({ code: 'UNAUTHORIZED' })).not.toBe(
      STATUS_RESOLUTIONS[401]
    );
  });

  test('a code without an explicit entry falls back to its status class', () => {
    // AGENT_NOT_FOUND is a 400 in the registry and carries no explicit entry.
    expect(ERROR_RESOLUTIONS.AGENT_NOT_FOUND).toBeUndefined();
    expect(ERROR_CODES.AGENT_NOT_FOUND.httpStatus).toBe(400);
    expect(resolutionFor({ code: 'AGENT_NOT_FOUND' })).toBe(
      STATUS_RESOLUTIONS[400]
    );
  });

  test('every explicit entry names a code that still exists', () => {
    const stale = Object.keys(ERROR_RESOLUTIONS).filter((code) => {
      return !(code in ERROR_CODES);
    });

    expect(stale).toEqual([]);
  });

  test('every status class used by the registry has a fallback hint', () => {
    const uncovered = [
      ...new Set(
        codes.map((code) => {
          return ERROR_CODES[code].httpStatus;
        })
      ),
    ].filter((status) => {
      return STATUS_RESOLUTIONS[status] === undefined;
    });

    expect(uncovered).toEqual([]);
  });

  test('a code the registry does not know still gets a hint', () => {
    // `resolutionFor` takes a plain string, so the docs generators and log
    // lines can call it with text that is not a registered code — and an empty
    // hint would be worse than a generic one, since a caller reading `hint`
    // would find nothing there.
    expect(resolutionFor({ code: 'NOT_A_REGISTERED_CODE' })).toBe(
      DEFAULT_RESOLUTION
    );
    expect(DEFAULT_RESOLUTION).toMatch(/errors\.json/);
  });

  test('the docs URL is the reference-page anchor for the code', () => {
    expect(docsUrlFor({ code: 'QUOTA_EXCEEDED' })).toBe(
      'https://soat.ttoss.dev/docs/error-codes#quota_exceeded'
    );
  });

  test('every code produces a distinct docs anchor', () => {
    const urls = codes.map((code) => {
      return docsUrlFor({ code });
    });

    expect(new Set(urls).size).toBe(codes.length);
  });
});
