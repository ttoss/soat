import {
  retryAfterSeconds,
  validateQuotaImmutableFields,
  validateQuotaLimit,
  validateQuotaShape,
  windowKeyFor,
  windowResetsAt,
  windowStartsAt,
} from '../../../../src/lib/quotas';

// Pure quota helpers — window math and create/update validation. Justified as a
// direct lib test under the keep-list rule: a large input space (every
// scope/metric/window/mode combination and every window's key/reset math) that
// is expensive and low-resolution to drive through HTTP.

const NOW = new Date('2026-07-07T12:31:45.123Z');

describe('quota window helpers', () => {
  describe('windowKeyFor', () => {
    test('truncates to the minute for rolling_1m', () => {
      expect(windowKeyFor({ window: 'rolling_1m', now: NOW })).toBe(
        '2026-07-07T12:31Z'
      );
    });
    test('truncates to the hour for rolling_1h', () => {
      expect(windowKeyFor({ window: 'rolling_1h', now: NOW })).toBe(
        '2026-07-07T12Z'
      );
    });
    test('truncates to the day for rolling_24h', () => {
      expect(windowKeyFor({ window: 'rolling_24h', now: NOW })).toBe(
        '2026-07-07Z'
      );
    });
    test('uses YYYY-MM for calendar_month', () => {
      expect(windowKeyFor({ window: 'calendar_month', now: NOW })).toBe(
        '2026-07'
      );
    });
  });

  describe('windowResetsAt', () => {
    test('rolls to the next minute for rolling_1m', () => {
      expect(
        windowResetsAt({ window: 'rolling_1m', now: NOW }).toISOString()
      ).toBe('2026-07-07T12:32:00.000Z');
    });
    test('rolls to the next hour for rolling_1h', () => {
      expect(
        windowResetsAt({ window: 'rolling_1h', now: NOW }).toISOString()
      ).toBe('2026-07-07T13:00:00.000Z');
    });
    test('rolls to the next day for rolling_24h', () => {
      expect(
        windowResetsAt({ window: 'rolling_24h', now: NOW }).toISOString()
      ).toBe('2026-07-08T00:00:00.000Z');
    });
    test('rolls to the first of next month for calendar_month', () => {
      expect(
        windowResetsAt({ window: 'calendar_month', now: NOW }).toISOString()
      ).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  describe('windowStartsAt', () => {
    test('truncates to the current minute for rolling_1m', () => {
      expect(
        windowStartsAt({ window: 'rolling_1m', now: NOW }).toISOString()
      ).toBe('2026-07-07T12:31:00.000Z');
    });
    test('truncates to the current hour for rolling_1h', () => {
      expect(
        windowStartsAt({ window: 'rolling_1h', now: NOW }).toISOString()
      ).toBe('2026-07-07T12:00:00.000Z');
    });
    test('truncates to the current day for rolling_24h', () => {
      expect(
        windowStartsAt({ window: 'rolling_24h', now: NOW }).toISOString()
      ).toBe('2026-07-07T00:00:00.000Z');
    });
    test('truncates to the first of the month for calendar_month', () => {
      expect(
        windowStartsAt({ window: 'calendar_month', now: NOW }).toISOString()
      ).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  describe('retryAfterSeconds', () => {
    test('rounds up seconds until reset', () => {
      expect(
        retryAfterSeconds({
          resetsAt: new Date('2026-07-07T12:32:00.000Z'),
          now: NOW,
        })
      ).toBe(15);
    });
    test('floors at 0 when the reset is already past', () => {
      expect(
        retryAfterSeconds({
          resetsAt: new Date('2026-07-07T12:30:00.000Z'),
          now: NOW,
        })
      ).toBe(0);
    });
  });
});

describe('validateQuotaLimit', () => {
  test('accepts a positive integer for requests', () => {
    expect(validateQuotaLimit({ metric: 'requests', limit: 5 })).toBeNull();
  });
  test('accepts a numeric string', () => {
    expect(validateQuotaLimit({ metric: 'requests', limit: '5' })).toBeNull();
  });
  test('rejects a fractional requests limit', () => {
    expect(validateQuotaLimit({ metric: 'requests', limit: 2.5 })).toMatch(
      /positive integer/
    );
  });
  test('accepts a fractional cost_usd limit', () => {
    expect(validateQuotaLimit({ metric: 'cost_usd', limit: 2.5 })).toBeNull();
  });
  test('rejects zero and negatives', () => {
    expect(validateQuotaLimit({ metric: 'requests', limit: 0 })).not.toBeNull();
    expect(
      validateQuotaLimit({ metric: 'cost_usd', limit: -1 })
    ).not.toBeNull();
  });
  test('rejects an empty string and non-numeric input', () => {
    expect(
      validateQuotaLimit({ metric: 'requests', limit: '' })
    ).not.toBeNull();
    expect(
      validateQuotaLimit({ metric: 'requests', limit: undefined })
    ).not.toBeNull();
    expect(
      validateQuotaLimit({ metric: 'requests', limit: 'abc' })
    ).not.toBeNull();
  });
});

describe('validateQuotaShape', () => {
  const base = {
    scope: 'project',
    metric: 'requests',
    window: 'rolling_1m',
    mode: 'enforce',
    limit: 10,
  };

  test('accepts a valid shape', () => {
    expect(validateQuotaShape(base)).toBeNull();
  });
  test('rejects an invalid scope', () => {
    expect(validateQuotaShape({ ...base, scope: 'nope' })).toMatch(/scope/);
  });
  test('rejects an invalid metric', () => {
    expect(validateQuotaShape({ ...base, metric: 'nope' })).toMatch(/metric/);
  });
  test('rejects an invalid window', () => {
    expect(validateQuotaShape({ ...base, window: 'nope' })).toMatch(/window/);
  });
  test('rejects an invalid mode', () => {
    expect(validateQuotaShape({ ...base, mode: 'nope' })).toMatch(/mode/);
  });
  test('rejects scope=agent with metric=requests', () => {
    expect(validateQuotaShape({ ...base, scope: 'agent' })).toMatch(/agent/);
  });
  test('accepts scope=agent with metric=tokens', () => {
    expect(
      validateQuotaShape({
        ...base,
        scope: 'agent',
        metric: 'tokens',
        window: 'calendar_month',
      })
    ).toBeNull();
  });
  test('accepts scope=agent with metric=cost_usd', () => {
    expect(
      validateQuotaShape({
        ...base,
        scope: 'agent',
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 1.5,
      })
    ).toBeNull();
  });
  test('rejects scope=api_key with metric=tokens', () => {
    // Usage events carry no API-key attribution, so a token/cost cap scoped to
    // an api key can never be aggregated — rejected rather than stored as a
    // silent no-op (mirrors the agent+requests rejection).
    expect(
      validateQuotaShape({
        ...base,
        scope: 'api_key',
        metric: 'tokens',
        window: 'calendar_month',
      })
    ).toMatch(/api_key/);
  });
  test('rejects scope=api_key with metric=cost_usd', () => {
    expect(
      validateQuotaShape({
        ...base,
        scope: 'api_key',
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 1.5,
      })
    ).toMatch(/api_key/);
  });
  test('still accepts scope=api_key with metric=requests', () => {
    expect(
      validateQuotaShape({ ...base, scope: 'api_key', metric: 'requests' })
    ).toBeNull();
  });

  const costBase = {
    ...base,
    metric: 'cost_usd',
    window: 'calendar_month',
    limit: 1.5,
  };

  test('accepts a cost quota scoped to one meter type', () => {
    expect(
      validateQuotaShape({ ...costBase, meterType: 'storage' })
    ).toBeNull();
  });
  test('accepts a cost quota with no meter scope', () => {
    expect(validateQuotaShape(costBase)).toBeNull();
  });
  test('rejects a meter type outside the metered vocabulary', () => {
    // An unrecorded meter type matches no event, so the cap would aggregate 0
    // forever — the same silent no-op `SCOPES_BY_METRIC` refuses.
    expect(
      validateQuotaShape({ ...costBase, meterType: 'llm_token' })
    ).toMatch(/meter_type/);
  });
  test('rejects a meter scope on a metric with no cost dimension', () => {
    expect(
      validateQuotaShape({ ...base, metric: 'tokens', meterType: 'storage' })
    ).toMatch(/cost_usd/);
  });
});

/**
 * `storage_bytes` is a stock, not a flow: the aggregate *is* the footprint, so
 * every fixed window is meaningless on it. The rule has to be fail-closed in
 * both directions, because either half stored is a quota that reads healthy
 * while enforcing nothing — a windowed storage cap would never be evaluated,
 * and `current` on a flow metric has no window math behind it (#1249).
 */
describe('validateQuotaShape — the storage_bytes stock metric', () => {
  const base = {
    scope: 'project',
    metric: 'storage_bytes',
    window: 'current',
    mode: 'enforce',
    limit: 1_000_000_000,
  };

  test('accepts a project-scope cap on the current footprint', () => {
    expect(validateQuotaShape(base)).toBeNull();
  });

  test.each(['rolling_1m', 'rolling_1h', 'rolling_24h', 'calendar_month'])(
    'rejects window=%s, which a stock metric cannot be aggregated over',
    (window) => {
      expect(validateQuotaShape({ ...base, window })).toMatch(/current/);
    }
  );

  test.each(['requests', 'tokens', 'cost_usd'])(
    'rejects window=current on the flow metric %s',
    (metric) => {
      expect(
        validateQuotaShape({ ...base, metric, window: 'current' })
      ).toMatch(/window/);
    }
  );

  test.each(['api_key', 'agent', 'actor'])(
    'rejects scope=%s, which the storage footprint carries no attribution for',
    (scope) => {
      expect(validateQuotaShape({ ...base, scope })).toMatch(/storage_bytes/);
    }
  );

  test('rejects a fractional byte limit', () => {
    expect(validateQuotaShape({ ...base, limit: 1.5 })).toMatch(
      /positive integer/
    );
  });

  test('rejects on_unpriced, which has no meaning without a price book', () => {
    expect(validateQuotaShape({ ...base, onUnpriced: 'allow' })).toMatch(
      /cost_usd/
    );
  });

  test('monitor mode is storable, and is how a cap is dry-run', () => {
    expect(validateQuotaShape({ ...base, mode: 'monitor' })).toBeNull();
  });
});

describe('validateQuotaImmutableFields', () => {
  const current = {
    scope: 'agent',
    scopeRef: 'agent_abc',
    metric: 'tokens',
    window: 'rolling_1h',
    meterType: null,
  };

  test('accepts an update that restates every immutable field unchanged', () => {
    expect(
      validateQuotaImmutableFields({
        next: {
          scope: 'agent',
          scopeRef: 'agent_abc',
          metric: 'tokens',
          window: 'rolling_1h',
        },
        current,
      })
    ).toBeNull();
  });

  test('accepts an update that supplies no immutable field at all', () => {
    expect(validateQuotaImmutableFields({ next: {}, current })).toBeNull();
  });

  test.each([
    ['scope', { scope: 'project' }],
    ['metric', { metric: 'cost_usd' }],
    ['window', { window: 'calendar_month' }],
    ['scope_ref', { scopeRef: 'agent_other' }],
    ['meter_type', { meterType: 'storage' }],
  ])('rejects a changed %s', (field, next) => {
    const error = validateQuotaImmutableFields({ next, current });
    expect(error).toMatch(new RegExp(field));
    expect(error).toMatch(/immutable/i);
  });

  test('reports both the declared and the current value', () => {
    const error = validateQuotaImmutableFields({
      next: { metric: 'cost_usd' },
      current,
    });
    expect(error).toMatch(/cost_usd/);
    expect(error).toMatch(/tokens/);
  });

  test('rejects clearing scope_ref to null', () => {
    expect(
      validateQuotaImmutableFields({ next: { scopeRef: null }, current })
    ).toMatch(/scope_ref/);
  });

  // `null` and `""` are materially different scope_ref values (see the
  // per-actor-budget tests below), so the message must never collapse one
  // into the other — a declared/stored null must read as the word "null".
  test('renders a declared null scope_ref as the word null, not an empty string', () => {
    const error = validateQuotaImmutableFields({
      next: { scopeRef: null },
      current,
    });
    expect(error).toMatch(/declared null/);
    expect(error).not.toMatch(/declared ""/);
  });

  test('renders a stored null scope_ref as the word null, not an empty string', () => {
    const error = validateQuotaImmutableFields({
      next: { scopeRef: 'key_abc' },
      current: { ...current, scope: 'project', scopeRef: null },
    });
    expect(error).toMatch(/current null/);
    expect(error).not.toMatch(/current ""/);
  });

  test('treats a null scope_ref as unchanged when it is already null', () => {
    expect(
      validateQuotaImmutableFields({
        next: { scopeRef: null },
        current: { ...current, scope: 'project', scopeRef: null },
      })
    ).toBeNull();
  });

  test('rejects setting a scope_ref on a quota that has none', () => {
    expect(
      validateQuotaImmutableFields({
        next: { scopeRef: 'key_abc' },
        current: { ...current, scope: 'project', scopeRef: null },
      })
    ).toMatch(/scope_ref/);
  });

  // For `actor` scope a null ref means "one budget per actor" while a ref caps
  // one named actor — materially different caps, so the null↔ref transition must
  // be rejected in both directions rather than quietly re-pointing the budget.
  test('rejects pinning a per-actor budget to one named actor', () => {
    expect(
      validateQuotaImmutableFields({
        next: { scopeRef: 'actor_abc' },
        current: {
          scope: 'actor',
          scopeRef: null,
          metric: 'tokens',
          window: 'calendar_month',
          meterType: null,
        },
      })
    ).toMatch(/scope_ref/);
  });

  test('rejects widening a named-actor budget to per-actor', () => {
    expect(
      validateQuotaImmutableFields({
        next: { scopeRef: null },
        current: {
          scope: 'actor',
          scopeRef: 'actor_abc',
          metric: 'tokens',
          window: 'calendar_month',
          meterType: null,
        },
      })
    ).toMatch(/scope_ref/);
  });

  // A meter scope narrows what the cap measures, so widening it back to every
  // meter is as material a change as narrowing it — rejected in both
  // directions, like the per-actor `scope_ref`.
  test('rejects clearing a meter scope back to every meter', () => {
    expect(
      validateQuotaImmutableFields({
        next: { meterType: null },
        current: { ...current, metric: 'cost_usd', meterType: 'storage' },
      })
    ).toMatch(/meter_type/);
  });

  test('treats a restated meter scope as unchanged', () => {
    expect(
      validateQuotaImmutableFields({
        next: { meterType: 'storage' },
        current: { ...current, metric: 'cost_usd', meterType: 'storage' },
      })
    ).toBeNull();
  });

  // The first offending field is reported rather than a combined list, so the
  // message stays actionable when a template changes several at once.
  test('reports the first offending field when several changed', () => {
    expect(
      validateQuotaImmutableFields({
        next: { scope: 'project', metric: 'cost_usd' },
        current,
      })
    ).toMatch(/scope/);
  });
});
