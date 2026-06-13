import * as React from 'react';

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
  const [view, setView] = React.useState<ViewDescriptor | null>(null);
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(
    null
  );

  const navigate = React.useCallback((descriptor: ViewDescriptor | null) => {
    setView(descriptor);
  }, []);

  const setProject = React.useCallback(
    (projectId: string | null) => {
      setActiveProjectId(projectId);
      navigate(null);
    },
    [navigate]
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
