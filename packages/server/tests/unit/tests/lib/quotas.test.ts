import {
  retryAfterSeconds,
  validateQuotaLimit,
  validateQuotaShape,
  windowKeyFor,
  windowResetsAt,
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
});
