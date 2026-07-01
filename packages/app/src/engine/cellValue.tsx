import type * as React from 'react';

import type { RefResolver } from './crossRef';
import { RefButton } from './crossRef';
import { renderRefLink } from './refLink';
import { formatValue, isSensitiveKey } from './specUtils';
import { StatusBadge } from './statusBadge';
import type { JsonValue } from './types';

// Special-cased columns: the item's own id (links to its detail), status and
// error (rendered as badges). Returns null so CellValue falls through.
const renderSpecialCell = (args: {
  colKey: string;
  value: JsonValue;
  onOpen?: () => void;
}): React.ReactElement | null => {
  const { colKey, value, onOpen } = args;
  if (colKey === 'id' && onOpen && typeof value === 'string' && value) {
    return <RefButton id={value} onClick={onOpen} />;
  }
  if (colKey === 'status' && typeof value === 'string' && value) {
    return <StatusBadge status={value} />;
  }
  if (colKey === 'error') {
    return value ? (
      <StatusBadge error />
    ) : (
      <span className="text-muted-foreground">{'—'}</span>
    );
  }
  return null;
};

// Renders one table cell. Cross-reference ids (x-soat-ref) and the item's own
// id become links; status/error become badges; everything else is text.
export const CellValue = ({
  colKey,
  value,
  refResource,
  context,
  resolveRef,
  onOpen,
}: {
  colKey: string;
  value: JsonValue;
  refResource?: string;
  context: Record<string, string>;
  resolveRef?: RefResolver;
  onOpen?: () => void;
}): React.ReactElement => {
  if (isSensitiveKey(colKey)) {
    return <span className="text-muted-foreground italic">{'[hidden]'}</span>;
  }
  const refLink = renderRefLink({ refResource, value, context, resolveRef });
  if (refLink) return refLink;
  const special = renderSpecialCell({ colKey, value, onOpen });
  if (special) return special;
  const formatted = formatValue(colKey, value);
  if (formatted.length > 60) {
    return <span title={formatted}>{`${formatted.slice(0, 57)}…`}</span>;
  }
  return <span>{formatted}</span>;
};
