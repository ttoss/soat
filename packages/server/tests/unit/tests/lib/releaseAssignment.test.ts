import {
  assignReleaseVersion,
  bucketForKey,
  parseActiveRelease,
} from 'src/lib/releaseAssignment';

/**
 * Deterministic canary assignment (the agents module doc — Versioning and Staged Rollout).
 *
 * Tested directly rather than through the generate endpoint: this is a pure
 * hash over a large key space, and the property that matters — a stable
 * per-actor split with a correct overall share — needs hundreds of distinct
 * keys. Driving that through HTTP would mean building an actor, a session and a
 * live provider call per case, and the observable signal (which prompt the model
 * saw) is far lower resolution than the returned version number.
 */
describe('releaseAssignment', () => {
  const release = {
    stable_version: 3,
    canary_version: 4,
    canary_percent: 20,
    promotion_gate: null,
  };

  describe('bucketForKey', () => {
    test('is stable across calls for the same key', () => {
      expect(bucketForKey('actor_abc')).toBe(bucketForKey('actor_abc'));
    });

    test('always lands in 0..99', () => {
      for (let index = 0; index < 500; index += 1) {
        const bucket = bucketForKey(`actor_${index}`);
        expect(Number.isInteger(bucket)).toBe(true);
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThanOrEqual(99);
      }
    });

    test('different keys do not all collapse to one bucket', () => {
      const buckets = new Set(
        Array.from({ length: 200 }, (_unused, index) => {
          return bucketForKey(`actor_${index}`);
        })
      );
      // A hash that returned a constant would pass every other test here.
      expect(buckets.size).toBeGreaterThan(50);
    });
  });

  describe('assignReleaseVersion', () => {
    test('an actor is assigned the same version on every repeat call', () => {
      for (let index = 0; index < 100; index += 1) {
        const key = `actor_${index}`;
        const first = assignReleaseVersion({ release, key });
        const second = assignReleaseVersion({ release, key });
        const third = assignReleaseVersion({ release, key });
        expect(second).toEqual(first);
        expect(third).toEqual(first);
      }
    });

    test('the canary share over 100 distinct actors is within 20 ± 10', () => {
      const canaryCount = Array.from({ length: 100 }, (_unused, index) => {
        return assignReleaseVersion({ release, key: `actor_${index}` });
      }).filter((assignment) => {
        return assignment.isCanary;
      }).length;

      expect(canaryCount).toBeGreaterThanOrEqual(10);
      expect(canaryCount).toBeLessThanOrEqual(30);
    });

    test('assigns only the two versions named by the release', () => {
      const versions = new Set(
        Array.from({ length: 100 }, (_unused, index) => {
          return assignReleaseVersion({ release, key: `actor_${index}` })
            .version;
        })
      );
      expect([...versions].sort()).toEqual([3, 4]);
    });

    test('canary_percent 0 sends every actor to stable', () => {
      const zero = { ...release, canary_percent: 0 };
      for (let index = 0; index < 100; index += 1) {
        const assignment = assignReleaseVersion({
          release: zero,
          key: `actor_${index}`,
        });
        expect(assignment.isCanary).toBe(false);
        expect(assignment.version).toBe(3);
      }
    });

    test('canary_percent 100 sends every actor to canary', () => {
      const full = { ...release, canary_percent: 100 };
      for (let index = 0; index < 100; index += 1) {
        const assignment = assignReleaseVersion({
          release: full,
          key: `actor_${index}`,
        });
        expect(assignment.isCanary).toBe(true);
        expect(assignment.version).toBe(4);
      }
    });

    test('an anonymous request (no key) still resolves to one of the two versions', () => {
      const seen = new Set<number>();
      for (let index = 0; index < 400; index += 1) {
        const assignment = assignReleaseVersion({ release, key: null });
        expect([3, 4]).toContain(assignment.version);
        seen.add(assignment.version);
      }
      // Anonymous traffic is split randomly rather than pinned, so a large
      // sample at 20% must reach both sides.
      expect(seen.size).toBe(2);
    });
  });

  describe('parseActiveRelease', () => {
    test('reads a stored release', () => {
      expect(parseActiveRelease(release)).toEqual({
        stable_version: 3,
        canary_version: 4,
        canary_percent: 20,
        promotion_gate: null,
      });
    });

    test('reads a gated release, and a pre-Phase-3 row as ungated', () => {
      expect(
        parseActiveRelease({ ...release, promotion_gate: 'eval_abc' })
          ?.promotion_gate
      ).toBe('eval_abc');

      // Every release stored before the gate existed lacks the key entirely.
      // Reading that as "no gate" is what keeps a running rollout parseable —
      // returning null here would drop its traffic back to the live config.
      const { promotion_gate: _gate, ...ungated } = release;
      expect(parseActiveRelease(ungated)).toEqual({
        stable_version: 3,
        canary_version: 4,
        canary_percent: 20,
        promotion_gate: null,
      });
    });

    test('a malformed gate makes the whole release unreadable', () => {
      // Fails closed. A gate that cannot be read was still *meant* to gate, so
      // the release degrades to "none" — promotion then answers
      // NO_ACTIVE_RELEASE instead of promoting a canary nothing validated.
      expect(parseActiveRelease({ ...release, promotion_gate: 42 })).toBeNull();
      expect(parseActiveRelease({ ...release, promotion_gate: '' })).toBeNull();
    });

    test('returns null for an absent release', () => {
      expect(parseActiveRelease(null)).toBeNull();
      expect(parseActiveRelease(undefined)).toBeNull();
    });

    test('returns null for a malformed release rather than serving a wrong version', () => {
      // A row written by an older/newer server, or hand-edited: fail back to
      // "no release" (serve the live config) instead of guessing a version.
      expect(parseActiveRelease({ stable_version: 1 })).toBeNull();
      expect(parseActiveRelease({ canary_version: 2 })).toBeNull();
      expect(
        parseActiveRelease({
          stable_version: 1,
          canary_version: 2,
          canary_percent: 'half',
        })
      ).toBeNull();
      expect(parseActiveRelease('nonsense')).toBeNull();
    });
  });
});
