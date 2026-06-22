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

// Renders a cross-resource id as a link, or null when the value is not a
// linkable ref (no annotation, no handler, or a non-string value). Returning
// null lets callers fall through to their default rendering with one branch.
export const renderRefLink = (args: {
  refResource?: string;
  value: JsonValue;
  onRefClick?: (resource: string, id: string) => void;
  className?: string;
}): React.ReactElement | null => {
  const { refResource, value, onRefClick, className } = args;
  if (!refResource || !onRefClick || typeof value !== 'string' || !value) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRefClick(refResource, value);
      }}
      className={
        className ?? 'font-mono text-primary underline-offset-4 hover:underline'
      }
    >
      {value}
    </button>
  );
};
