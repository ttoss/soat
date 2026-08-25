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
      DEFAULT_RESOLUTION()
    );
    expect(DEFAULT_RESOLUTION()).toMatch(/errors\.json/);
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

  /**
   * The property #1126 is about: a deployment that fronts SOAT and relays its
   * error envelope must be able to point `hint` and `docs_url` at its own
   * documentation instead of soat.ttoss.dev. `SOAT_DOCS_BASE_URL` is the
   * existing self-hosting knob for the MCP docs tools (`src/lib/docs.ts`);
   * this pins that the error envelope now reads the same one.
   */
  describe('with SOAT_DOCS_BASE_URL set', () => {
    const ORIGINAL_ENV = process.env.SOAT_DOCS_BASE_URL;

    beforeEach(() => {
      process.env.SOAT_DOCS_BASE_URL = 'https://docs.example.com';
    });

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) {
        delete process.env.SOAT_DOCS_BASE_URL;
      } else {
        process.env.SOAT_DOCS_BASE_URL = ORIGINAL_ENV;
      }
    });

    test('docsUrlFor is rebased', () => {
      expect(docsUrlFor({ code: 'QUOTA_EXCEEDED' })).toBe(
        'https://docs.example.com/docs/error-codes#quota_exceeded'
      );
    });

    test('the default resolution is rebased', () => {
      expect(DEFAULT_RESOLUTION()).toBe(
        'Read `code` against the catalog at https://docs.example.com/errors.json to decide how to proceed.'
      );
    });
  });

  /**
   * Every hint the registry serves must be relayable by a deployment that
   * fronts SOAT — naming the product or hardcoding a URL that is not derived
   * from `SOAT_DOCS_BASE_URL` would leak the substrate onto that deployment's
   * own error responses (ttoss/soat#1126). This is the guard that keeps the
   * property true as the registry grows: it fails on the *next* hint that
   * names SOAT, not just the ones fixed here.
   */
  test('no hint names SOAT or hardcodes a URL', () => {
    // Rendered under a non-default base: the *default* base legitimately
    // contains "soat" (soat.ttoss.dev), so checking the default rendering
    // would flag the configured case along with the hardcoded one. Swapping
    // the base isolates what #1126 is actually about — text a deployment
    // cannot relocate by setting `SOAT_DOCS_BASE_URL`.
    const original = process.env.SOAT_DOCS_BASE_URL;
    process.env.SOAT_DOCS_BASE_URL = 'https://docs.example.com';
    let allHints: string[];
    try {
      allHints = [
        ...Object.values(ERROR_RESOLUTIONS),
        ...Object.values(STATUS_RESOLUTIONS),
        DEFAULT_RESOLUTION(),
      ];
    } finally {
      if (original === undefined) {
        delete process.env.SOAT_DOCS_BASE_URL;
      } else {
        process.env.SOAT_DOCS_BASE_URL = original;
      }
    }

    const branded = allHints.filter((hint) => {
      return /\bsoat\b/i.test(hint);
    });
    expect(branded).toEqual([]);

    // A hint may reference the docs site, but only through the overridable
    // base — never a URL hardcoded to soat.ttoss.dev.
    const hardcoded = allHints.filter((hint) => {
      return /https?:\/\/soat\.ttoss\.dev/i.test(hint);
    });
    expect(hardcoded).toEqual([]);
  });
});
