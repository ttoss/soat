import * as React from 'react';

import { parseModules } from './specUtils';
import type { ModuleInfo, OpenApiSpec } from './types';

type SpecState = {
  spec: OpenApiSpec | null;
  modules: ModuleInfo[];
  loading: boolean;
  error: string | null;
};

type SpecContextValue = SpecState & {
  reload: () => void;
};

const SpecContext = React.createContext<SpecContextValue>({
  spec: null,
  modules: [],
  loading: false,
  error: null,
  reload: () => {},
});

const fetchSpec = async (token: string): Promise<OpenApiSpec> => {
  const res = await fetch('/api/v1/openapi.json', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to load spec: ${res.status}`);
  return res.json() as Promise<OpenApiSpec>;
};

export const SpecProvider = ({
  children,
  token,
}: {
  children: React.ReactNode;
  token: string;
}) => {
  const [state, setState] = React.useState<Omit<SpecState, 'modules'>>({
    spec: null,
    loading: true,
    error: null,
  });

  const fetchData = React.useCallback(() => {
    if (!token) return;
    fetchSpec(token)
      .then((spec) => {
        return setState({ spec, loading: false, error: null });
      })
      .catch((error: unknown) => {
        setState({ spec: null, loading: false, error: String(error) });
      });
  }, [token]);

  const load = React.useCallback(() => {
    setState((s) => {
      return { ...s, loading: true, error: null };
    });
    fetchData();
  }, [fetchData]);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const modules = React.useMemo(() => {
    return state.spec ? parseModules(state.spec) : [];
  }, [state.spec]);

  return (
    <SpecContext.Provider value={{ ...state, modules, reload: load }}>
      {children}
    </SpecContext.Provider>
  );
};

export const useSpec = (): SpecContextValue => {
  return React.useContext(SpecContext);
};
