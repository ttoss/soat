import * as React from 'react';

import { useNavigation } from './navigationContext';
import { buildRefDescriptor, findModuleByResource } from './specUtils';
import type { JsonValue, ModuleInfo } from './types';

// Returns a handler that navigates to the detail view of the resource named by
// an `x-soat-ref` annotation, given the referenced record id.
export const useRefNavigation = (
  modules: ModuleInfo[]
): ((resource: string, id: string) => void) => {
  const { navigate } = useNavigation();
  return React.useCallback(
    (resource: string, id: string) => {
      const target = findModuleByResource(modules, resource);
      if (!target) return;
      const descriptor = buildRefDescriptor(target, id);
      if (descriptor) navigate(descriptor);
    },
    [modules, navigate]
  );
};

const RefButton = ({
  resource,
  id,
  onRefClick,
  className,
}: {
  resource: string;
  id: string;
  onRefClick: (resource: string, id: string) => void;
  className?: string;
}) => {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRefClick(resource, id);
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

// Renders a cross-resource id (or array of ids) as link(s), or null when the
// value is not a linkable ref. Returning null lets callers fall through to
// their default rendering with a single branch.
export const renderRefLink = (args: {
  refResource?: string;
  value: JsonValue;
  onRefClick?: (resource: string, id: string) => void;
  className?: string;
}): React.ReactElement | null => {
  const { refResource, value, onRefClick, className } = args;
  if (!refResource || !onRefClick) return null;
  const ids = stringIds(value);
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    return (
      <RefButton
        resource={refResource}
        id={ids[0]}
        onRefClick={onRefClick}
        className={className}
      />
    );
  }
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {ids.map((id) => {
        return (
          <RefButton
            key={id}
            resource={refResource}
            id={id}
            onRefClick={onRefClick}
            className={className}
          />
        );
      })}
    </span>
  );
};
