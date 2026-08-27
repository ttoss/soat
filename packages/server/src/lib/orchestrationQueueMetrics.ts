// Recent claim latencies, so the queue-stats endpoint reports p50/p95 with no
// external metrics stack. Every driver records into this same ring at claim
// time, so the percentiles are driver-independent.
const CLAIM_LATENCY_RING_CAPACITY = 4096;

type ClaimLatencySample = { at: number; latencyMs: number };

const claimLatencyRing: ClaimLatencySample[] = [];

/** Records one claim latency sample (a task's wait between becoming available
 * and being claimed). Called by a driver's `claim`. */
export const recordClaimLatency = (sample: ClaimLatencySample): void => {
  claimLatencyRing.push(sample);
  if (claimLatencyRing.length > CLAIM_LATENCY_RING_CAPACITY) {
    // Drop the oldest sample — the ring only ever reports a recent window.
    claimLatencyRing.shift();
  }
};

const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  // Nearest-rank method over the ascending samples.
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index];
};

/**
 * A snapshot of recent claim latency percentiles over the trailing
 * `windowMs` (default 5 minutes). `p50`/`p95` are `null` when no claim
 * happened in the window. Used by the queue-stats endpoint.
 */
export const claimLatencySnapshot = (args?: {
  windowMs?: number;
  now?: number;
}): { p50: number | null; p95: number | null; windowSeconds: number } => {
  const windowMs = args?.windowMs ?? 300_000;
  const now = args?.now ?? Date.now();
  const cutoff = now - windowMs;
  const recent = claimLatencyRing
    .filter((s) => {
      return s.at >= cutoff;
    })
    .map((s) => {
      return s.latencyMs;
    })
    .sort((a, b) => {
      return a - b;
    });
  return {
    p50: recent.length ? percentile(recent, 50) : null,
    p95: recent.length ? percentile(recent, 95) : null,
    windowSeconds: Math.round(windowMs / 1000),
  };
};

/** Test-only: clears the claim-latency ring so runs don't leak across tests. */
export const resetClaimLatencyRing = (): void => {
  claimLatencyRing.length = 0;
};
