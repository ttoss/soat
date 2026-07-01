import { createClient } from '@soat/sdk';
import * as React from 'react';

import { apiBaseUrl } from '@/api/client';

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
  const client = createClient({
    baseUrl: apiBaseUrl(),
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await client.get({ url: '/api/v1/openapi.json' });
  if (result.error !== undefined) {
    throw new Error(`Failed to load spec: ${result.response?.status ?? 0}`);
  }
  return result.data as OpenApiSpec;
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

// eslint-disable-next-line react-refresh/only-export-components -- consumer hook is intentionally colocated with its provider
export const useSpec = (): SpecContextValue => {
  return React.useContext(SpecContext);
};
