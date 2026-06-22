import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { extractProjectId, pathToView, viewToPath } from './routeUtils';
import { useSpec } from './specContext';
import type { ViewDescriptor } from './types';

type NavigationContextValue = {
  view: ViewDescriptor | null;
  activeProjectId: string | null;
  navigate: (descriptor: ViewDescriptor | null) => void;
  setProject: (projectId: string | null) => void;
};

const NavigationContext = React.createContext<NavigationContextValue>({
  view: null,
  activeProjectId: null,
  navigate: () => {},
  setProject: () => {},
});

export const NavigationProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { spec, modules } = useSpec();
  const location = useLocation();
  const router = useNavigate();

  const view = React.useMemo(() => {
    if (!spec || modules.length === 0) return null;
    return pathToView(location.pathname, spec, modules);
  }, [location.pathname, spec, modules]);

  // The active project is sticky: it persists across module navigation instead
  // of being cleared when the new view's URL carries no project_id. Whenever a
  // visited route DOES carry one (a project detail page or a project-scoped
  // resource), we adopt it via React's render-time state-adjustment pattern.
  const urlProjectId = extractProjectId(view);
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(
    urlProjectId
  );
  if (urlProjectId && urlProjectId !== activeProjectId) {
    setActiveProjectId(urlProjectId);
  }

  const navigate = React.useCallback(
    (descriptor: ViewDescriptor | null) => {
      if (!descriptor) {
        // Go up one level: remove the last path segment.
        const segments = location.pathname.split('/').filter(Boolean);
        const parent =
          segments.length > 1 ? `/${segments.slice(0, -1).join('/')}` : '/app/';
        router(parent);
        return;
      }
      if (!spec) return;
      const path = viewToPath(descriptor, spec);
      if (path) router(path);
    },
    [router, spec, location.pathname]
  );

  const setProject = React.useCallback(
    (projectId: string | null) => {
      setActiveProjectId(projectId);
      router(projectId ? `/app/v1/projects/${projectId}` : '/app/');
    },
    [router]
  );

  return (
    <NavigationContext.Provider
      value={{ view, activeProjectId, navigate, setProject }}
    >
      {children}
    </NavigationContext.Provider>
  );
};

export const useNavigation = (): NavigationContextValue => {
  return React.useContext(NavigationContext);
};
