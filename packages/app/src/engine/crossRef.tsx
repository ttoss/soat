import * as React from 'react';

import { useNavigation } from './navigationContext';
import { buildRefDescriptor, findModuleByResource } from './specUtils';
import type { JsonValue, ModuleInfo } from './types';

// A row-scoped resolver: given the resource a field references and a record id,
// it returns a navigation handler when the target detail view can be reached,
// or null when it cannot (unknown resource, or an unfilled parent id). The
// `context` carries the current path params merged with the row's own fields,
// which is how nested targets recover their parent ids.
export type RefResolver = (
  resource: string,
  id: string,
  context: Record<string, string>
) => (() => void) | null;

// Returns a resolver that turns an (resource, id, context) triple into a
// navigation handler to the referenced resource's detail view, or null.
export const useRefResolver = (modules: ModuleInfo[]): RefResolver => {
  const { navigate } = useNavigation();
  return React.useCallback(
    (resource, id, context) => {
      const target = findModuleByResource(modules, resource);
      if (!target) return null;
      const descriptor = buildRefDescriptor(target, id, context);
      if (!descriptor) return null;
      return () => {
        return navigate(descriptor);
      };
    },
    [modules, navigate]
  );
};

const RefButton = ({
  id,
  onClick,
  className,
}: {
  id: string;
  onClick: () => void;
  className?: string;
}) => {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        className ?? 'font-mono text-primary underline-offset-4 hover:underline'
      }
    >
      {id}
    </button>
  );
};

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
