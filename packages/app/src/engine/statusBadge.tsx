import { Badge, type BadgeProps } from '@/components/ui/badge';

import { humanizeKey } from './specUtils';

type Tone = NonNullable<BadgeProps['tone']>;

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

type StatusBadgeProps = {
  status?: string;
  error?: boolean;
};

/**
 * Render a status value as a tonal Badge. When `error` is set, it always
 * renders a danger "Error" pill (used for the `error` field). Renders nothing
 * when there is neither a status nor an error.
 */
export const StatusBadge = ({ status, error = false }: StatusBadgeProps) => {
  if (error) {
    return <Badge tone="danger">{'Error'}</Badge>;
  }
  if (!status) return null;
  return <Badge tone={statusTone(status)}>{humanizeKey(status)}</Badge>;
};
