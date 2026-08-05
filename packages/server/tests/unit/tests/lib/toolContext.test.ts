import {
  pinServerIdentityToolContext,
  RESERVED_TOOL_CONTEXT_KEYS,
} from 'src/lib/toolContext';

// #850/#851 — the reserved identity keys must be unaddressable by a caller on
// every generation path. This is the pure pinning algorithm; the chokepoint
// wiring is covered by generationContextPinning.test.ts.
describe('pinServerIdentityToolContext', () => {
  test('reserves exactly the three identity keys', () => {
    expect([...RESERVED_TOOL_CONTEXT_KEYS]).toEqual([
      'sessionId',
      'actorId',
      'actorExternalId',
    ]);
  });

  test('strips caller-supplied reserved keys when there is no server identity', () => {
    const result = pinServerIdentityToolContext({
      toolContext: {
        sessionId: 'ses_forged',
        actorId: 'act_forged',
        actorExternalId: '+15550000000',
        userId: 'usr_legit',
      },
      identity: null,
    });
    expect(result).toEqual({ userId: 'usr_legit' });
  });

  test('strips reserved keys case-insensitively — header names are case-insensitive, so a casing variant lands on the same outbound header', () => {
    const result = pinServerIdentityToolContext({
      toolContext: {
        sessionID: 'ses_forged',
        ActorId: 'act_forged',
        actorexternalid: 'forged',
        tenant: 't1',
      },
      identity: null,
    });
    expect(result).toEqual({ tenant: 't1' });
  });

  test('stamps the server identity over anything the caller supplied', () => {
    const result = pinServerIdentityToolContext({
      toolContext: {
        sessionId: 'ses_forged',
        actorId: 'act_forged',
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
      sessionId: 'ses_real',
      actorId: 'act_real',
      actorExternalId: '+15559876543',
    });
  });

  test('omits actor keys entirely when the identity has no actor', () => {
    const result = pinServerIdentityToolContext({
      toolContext: { actorId: 'act_forged' },
      identity: { sessionId: 'ses_real' },
    });
    expect(result).toEqual({ sessionId: 'ses_real' });
  });

  test('returns undefined when there is nothing to carry', () => {
    expect(
      pinServerIdentityToolContext({ toolContext: undefined, identity: null })
    ).toBeUndefined();
    expect(
      pinServerIdentityToolContext({
        toolContext: { sessionId: 'ses_forged' },
        identity: null,
      })
    ).toEqual({});
  });

  test('stamps identity even when the caller sent no bag at all', () => {
    const result = pinServerIdentityToolContext({
      toolContext: undefined,
      identity: { sessionId: 'ses_real', actorId: 'act_real' },
    });
    expect(result).toEqual({ sessionId: 'ses_real', actorId: 'act_real' });
  });
});
