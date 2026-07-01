import { Badge } from '@/components/ui/badge';

import { humanizeKey } from './specUtils';
import { statusTone } from './statusUtils';

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
