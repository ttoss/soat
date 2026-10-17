import {
  assertValidToolContextKeys,
  buildContextHeaderName,
  buildContextHeaders,
  pinServerIdentityToolContext,
  RESERVED_TOOL_CONTEXT_KEYS,
} from 'src/lib/toolContext';

// The reserved identity keys must be unaddressable by a caller on every
// generation path. This is the pure pinning algorithm; the chokepoint
// wiring is covered by rest/generationIdentityPinning.test.ts.
describe('pinServerIdentityToolContext', () => {
  test('reserves exactly the server-owned keys', () => {
    expect([...RESERVED_TOOL_CONTEXT_KEYS]).toEqual([
      'session_id',
      'actor_id',
      'actor_external_id',
      'calling_project_id',
    ]);
  });

  test('strips caller-supplied reserved keys when there is no server identity', () => {
    const result = pinServerIdentityToolContext({
      toolContext: {
        session_id: 'ses_forged',
        actor_id: 'act_forged',
        actor_external_id: '+15550000000',
        userId: 'usr_legit',
      },
      identity: null,
    });
    expect(result).toEqual({ userId: 'usr_legit' });
  });

  test('strips reserved keys case-insensitively — header names are case-insensitive, so a casing variant lands on the same outbound header', () => {
    const result = pinServerIdentityToolContext({
      toolContext: {
        Session_ID: 'ses_forged',
        Actor_Id: 'act_forged',
        ACTOR_EXTERNAL_ID: 'forged',
        tenant: 't1',
      },
      identity: null,
    });
    expect(result).toEqual({ tenant: 't1' });
  });

  test('stamps the server identity over anything the caller supplied', () => {
    const result = pinServerIdentityToolContext({
      toolContext: {
        session_id: 'ses_forged',
        actor_id: 'act_forged',
        userId: 'usr_legit',
      },
      identity: {
        sessionId: 'ses_real',
        actorId: 'act_real',
        actorExternalId: '+15559876543',
      },
    });
    expect(result).toEqual({
      userId: 'usr_legit',
      session_id: 'ses_real',
      actor_id: 'act_real',
      actor_external_id: '+15559876543',
    });
  });

  test('omits actor keys entirely when the identity has no actor', () => {
    const result = pinServerIdentityToolContext({
      toolContext: { actor_id: 'act_forged' },
      identity: { sessionId: 'ses_real' },
    });
    expect(result).toEqual({ session_id: 'ses_real' });
  });

  test('returns undefined when there is nothing to carry', () => {
    expect(
      pinServerIdentityToolContext({ toolContext: undefined, identity: null })
    ).toBeUndefined();
    expect(
      pinServerIdentityToolContext({
        toolContext: { session_id: 'ses_forged' },
        identity: null,
      })
    ).toEqual({});
  });

  test('stamps identity even when the caller sent no bag at all', () => {
    const result = pinServerIdentityToolContext({
      toolContext: undefined,
      identity: { sessionId: 'ses_real', actorId: 'act_real' },
    });
    expect(result).toEqual({ session_id: 'ses_real', actor_id: 'act_real' });
  });
});

// The header prefix is deployment configuration, so a platform fronting SOAT
// does not leak the substrate name to third-party tool providers. A plain
// concatenation: no character of the key is transformed.
describe('SOAT_HEADER_PREFIX — context headers', () => {
  const originalPrefix = process.env.SOAT_HEADER_PREFIX;

  afterEach(() => {
    if (originalPrefix === undefined) {
      delete process.env.SOAT_HEADER_PREFIX;
    } else {
      process.env.SOAT_HEADER_PREFIX = originalPrefix;
    }
  });

  test('defaults to X-Soat-Context- when unset', () => {
    delete process.env.SOAT_HEADER_PREFIX;
    expect(buildContextHeaderName('userId')).toBe('X-Soat-Context-userId');
  });

  test('an empty prefix falls back to the default rather than disabling it', () => {
    process.env.SOAT_HEADER_PREFIX = '';
    expect(buildContextHeaderName('userId')).toBe('X-Soat-Context-userId');
  });

  test('a configured prefix replaces the default, key verbatim', () => {
    process.env.SOAT_HEADER_PREFIX = 'X-Naturali-';
    expect(buildContextHeaderName('userId')).toBe('X-Naturali-Context-userId');
    expect(buildContextHeaderName('actor_external_id')).toBe(
      'X-Naturali-Context-actor_external_id'
    );
  });

  test('buildContextHeaders applies the configured prefix to every key', () => {
    process.env.SOAT_HEADER_PREFIX = 'X-Naturali-';
    expect(
      buildContextHeaders({
        toolContext: { tenantId: 't1', region: 'us-east-1' },
      })
    ).toEqual({
      'X-Naturali-Context-tenantId': 't1',
      'X-Naturali-Context-region': 'us-east-1',
    });
  });

  // The prefix is read per call, not captured at module load, so a deployment
  // that sets it after the module graph is loaded (and a test that sets it per
  // case) sees the configured value.
  test('is read per call, not frozen at module load', () => {
    process.env.SOAT_HEADER_PREFIX = 'X-One-';
    expect(buildContextHeaderName('k')).toBe('X-One-Context-k');
    process.env.SOAT_HEADER_PREFIX = 'X-Two-';
    expect(buildContextHeaderName('k')).toBe('X-Two-Context-k');
  });

  // A prefix outside the RFC 7230 `token` grammar produces a header name
  // `fetch` rejects with a TypeError mid-generation — every tool call on the
  // deployment fails, far from the misconfiguration. Fail with a named error
  // instead.
  test.each([
    ['X-Bad Name-', 'a space'],
    ['X-Bad:Name-', 'a colon'],
    ['X-Bad(Name)-', 'parentheses'],
  ])('rejects the invalid prefix %p (%s)', (prefix) => {
    process.env.SOAT_HEADER_PREFIX = prefix;
    expect(() => {
      return buildContextHeaderName('userId');
    }).toThrow(/SOAT_HEADER_PREFIX/);
  });

  // The key→header collision check runs against the *configured* prefix, so a
  // deployment cannot lose the duplicate-key guard by renaming the prefix.
  test('key validation still catches a header collision under a custom prefix', () => {
    process.env.SOAT_HEADER_PREFIX = 'X-Naturali-';
    expect(() => {
      return assertValidToolContextKeys({ userId: 'a', userID: 'b' });
    }).toThrow(/both map to the header X-Naturali-Context-/);
  });
});
