import * as React from 'react';

import type { RefResolver } from './crossRef';
import { useNavigation } from './navigationContext';
import { buildRefDescriptor, findModuleByResource } from './specUtils';
import type { ModuleInfo } from './types';

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
