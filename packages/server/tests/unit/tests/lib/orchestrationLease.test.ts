import { leaseTtlMs, newLeaseExpiry } from 'src/lib/orchestrationLease';

describe('orchestrationLease', () => {
  const original = process.env.ORCHESTRATION_RUN_LEASE_TTL_MS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ORCHESTRATION_RUN_LEASE_TTL_MS;
    } else {
      process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = original;
    }
  });

  describe('leaseTtlMs', () => {
    test('defaults to 10 minutes when the env var is unset', () => {
      delete process.env.ORCHESTRATION_RUN_LEASE_TTL_MS;
      expect(leaseTtlMs()).toBe(600_000);
    });

    test('defaults when the env var is not a positive number', () => {
      process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = 'not-a-number';
      expect(leaseTtlMs()).toBe(600_000);
      process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = '-5';
      expect(leaseTtlMs()).toBe(600_000);
    });

    test('honours a positive numeric override', () => {
      process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = '1234';
      expect(leaseTtlMs()).toBe(1234);
    });
  });

  describe('newLeaseExpiry', () => {
    test('returns now + TTL when now is provided', () => {
      process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = '1000';
      const expiry = newLeaseExpiry({ now: 10_000 });
      expect(expiry.getTime()).toBe(11_000);
    });

    test('falls back to the current time when now is omitted', () => {
      process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = '1000';
      const before = Date.now();
      const expiry = newLeaseExpiry().getTime();
      const after = Date.now();
      expect(expiry).toBeGreaterThanOrEqual(before + 1000);
      expect(expiry).toBeLessThanOrEqual(after + 1000);
    });
  });
});
