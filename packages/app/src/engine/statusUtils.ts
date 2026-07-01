import type { BadgeProps } from '@/components/ui/badge';

export type Tone = NonNullable<BadgeProps['tone']>;

const SUCCESS = new Set([
  'active',
  'completed',
  'complete',
  'open',
  'succeeded',
  'success',
  'enabled',
  'ready',
  'done',
]);
const DANGER = new Set([
  'error',
  'failed',
  'failure',
  'expired',
  'cancelled',
  'canceled',
  'rejected',
  'revoked',
]);
const WARNING = new Set([
  'pending',
  'in_progress',
  'running',
  'queued',
  'requires_action',
  'waiting',
  'processing',
]);
const NEUTRAL = new Set([
  'inactive',
  'closed',
  'disabled',
  'archived',
  'draft',
]);

/**
 * Map a status string to the Badge tone that visually communicates it:
 * green for healthy/terminal-success, red for failure, amber for in-flight,
 * grey for dormant. Unknown values fall back to neutral.
 */
export const statusTone = (status: string): Tone => {
  const key = status.trim().toLowerCase();
  if (SUCCESS.has(key)) return 'success';
  if (DANGER.has(key)) return 'danger';
  if (WARNING.has(key)) return 'warning';
  if (NEUTRAL.has(key)) return 'neutral';
  return 'neutral';
};
