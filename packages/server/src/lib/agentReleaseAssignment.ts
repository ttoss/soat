import { createHash } from 'node:crypto';

/**
 * Deterministic canary assignment for agent staged rollouts
 * (docs/prd-agent-versions.md, Phase 2).
 *
 * Pure by design — no DB, no clock. The generation path resolves an identity
 * key and asks this module which version to serve, so the split is reproducible
 * in tests and identical across server processes.
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

  return {
    stable_version: candidate.stable_version,
    canary_version: candidate.canary_version,
    canary_percent: candidate.canary_percent,
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
