import { createHash } from 'node:crypto';

/**
 * Deterministic canary assignment for staged rollouts of a versioned resource
 * (docs/prd-agent-versions.md, Phase 2).
 *
 * Pure by design — no DB, no clock, and nothing agent-specific: the mechanism is
 * "split traffic between two version numbers on a stable identity key", which is
 * the same whatever the versions describe (issue #877, layer 2). A consumer
 * resolves an identity key and asks this module which version to serve, so the
 * split is reproducible in tests and identical across server processes.
 *
 * Agents are the only resource with release *semantics* today — what a release
 * targets differs per resource (the version serving a generation, the version
 * new runs start on, the version new tasks are created into), so that meaning
 * stays with each resource rather than being guessed at here.
 */

/**
 * A staged rollout, in the wire shape stored on `Agent.activeRelease` and echoed
 * verbatim in agent responses. Snake_case throughout: it crosses the API
 * boundary as a value, so nothing rewrites its keys.
 */
export type ActiveRelease = {
  stable_version: number;
  canary_version: number;
  canary_percent: number;
  /**
   * Public ID of an eval that must have a passing run against the canary
   * version before `promote` is allowed, or null when the rollout is promoted
   * on judgement alone (docs/prd-agent-versions.md, Phase 3).
   *
   * Assignment ignores it entirely — a gate constrains how a rollout *ends*,
   * never which version a request is served.
   */
  promotion_gate: string | null;
};

export type ReleaseAssignment = {
  version: number;
  isCanary: boolean;
};

const BUCKETS = 100;

const isVersionNumber = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
};

const isPercent = (value: unknown): value is number => {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= BUCKETS
  );
};

/** Distinguishes "no gate" (a valid release) from "unreadable gate". */
const MALFORMED_GATE = Symbol('malformed promotion_gate');

/**
 * Reads the stored `promotion_gate`.
 *
 * An **absent** key is "no gate": every release stored before Phase 3 lacks it,
 * and so does every ungated one since, so treating it as unreadable would drop a
 * running rollout back to the live config.
 *
 * A key that is present but malformed is the opposite case — it was written to
 * constrain promotion, so it takes the release down with it (see
 * {@link parseActiveRelease}). Promotion then answers `NO_ACTIVE_RELEASE`, which
 * is the closed direction; reading it as "no gate" would let a junk value
 * promote a canary that nothing ever validated.
 */
const readPromotionGate = (
  value: unknown
): string | null | typeof MALFORMED_GATE => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === '') return MALFORMED_GATE;
  return value;
};

/**
 * Reads a stored `active_release`, returning null unless every field is present
 * and well formed.
 *
 * A malformed row degrades to "no release" — serve the live config — rather than
 * guessing a version. Assignment runs on every generation, so the failure mode
 * of a bad guess is silently serving the wrong prompt to real traffic; falling
 * back to the live row is the only option that is wrong in a visible way.
 */
export const parseActiveRelease = (value: unknown): ActiveRelease | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    !isVersionNumber(candidate.stable_version) ||
    !isVersionNumber(candidate.canary_version) ||
    !isPercent(candidate.canary_percent)
  ) {
    return null;
  }

  const gate = readPromotionGate(candidate.promotion_gate);
  if (gate === MALFORMED_GATE) return null;

  return {
    stable_version: candidate.stable_version,
    canary_version: candidate.canary_version,
    canary_percent: candidate.canary_percent,
    promotion_gate: gate,
  };
};

/**
 * Maps an identity key to one of 100 buckets. SHA-256 rather than a cheap
 * string hash so the buckets are uniform at the sample sizes a canary actually
 * runs at — a poorly distributed hash would make a nominal 20% split land
 * anywhere, and the resulting comparison between versions would be measuring
 * the hash rather than the prompt.
 */
export const bucketForKey = (key: string): number => {
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % BUCKETS;
};

/**
 * Picks the version to serve for one request.
 *
 * `key` is the caller's stable identity — the actor's public ID where there is
 * one, else the session's. Hashing it (rather than rolling per request) is what
 * keeps a single actor on a single prompt: flipping an actor between two
 * personas mid-conversation is a worse failure than either version alone.
 *
 * A null key means there is no identity to be sticky about (an anonymous
 * one-shot generation), so the request is split randomly. That weakens the
 * determinism guarantee for heavily anonymous workloads, which is why the served
 * version is stamped on every generation record — post-hoc analysis stays honest
 * regardless of how the assignment was made.
 */
export const assignReleaseVersion = (args: {
  release: ActiveRelease;
  key: string | null;
}): ReleaseAssignment => {
  const { release, key } = args;

  const bucket =
    key === null ? Math.floor(Math.random() * BUCKETS) : bucketForKey(key);

  const isCanary = bucket < release.canary_percent;

  return {
    version: isCanary ? release.canary_version : release.stable_version,
    isCanary,
  };
};
