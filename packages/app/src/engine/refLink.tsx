import type * as React from 'react';

import type { RefResolver } from './crossRef';
import { RefButton } from './crossRef';
import type { JsonValue } from './types';

const stringIds = (value: JsonValue): string[] => {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => {
      return typeof v === 'string' && v !== '';
    });
  }
  return [];
};

// Renders a cross-resource id (or array of ids) as link(s). Each id is resolved
// independently against the row context: navigable ids become links, the rest
// render as plain monospace text. Returns null when nothing is linkable so the
// caller can fall through to its default rendering with a single branch.
export const renderRefLink = (args: {
  refResource?: string;
  value: JsonValue;
  context: Record<string, string>;
  resolveRef?: RefResolver;
  className?: string;
}): React.ReactElement | null => {
  const { refResource, value, context, resolveRef, className } = args;
  if (!refResource || !resolveRef) return null;
  const ids = stringIds(value);
  if (ids.length === 0) return null;

  const resolved = ids.map((id) => {
    return { id, onClick: resolveRef(refResource, id, context) };
  });
  if (
    resolved.every((r) => {
      return r.onClick === null;
    })
  )
    return null;

  const renderId = ({
    id,
    onClick,
  }: {
    id: string;
    onClick: (() => void) | null;
  }): React.ReactElement => {
    if (onClick) {
      return (
        <RefButton key={id} id={id} onClick={onClick} className={className} />
      );
    }
    return (
      <span key={id} className="font-mono">
        {id}
      </span>
    );
  };

  if (resolved.length === 1) return renderId(resolved[0]);
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {resolved.map(renderId)}
    </span>
  );
};
