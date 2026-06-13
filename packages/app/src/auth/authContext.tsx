import * as React from 'react';

type User = {
  id: string;
  username: string;
  role: 'admin' | 'user';
};

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: User; token: string };

type AuthContextValue = {
  state: AuthState;
  login: (args: {
    username: string;
    password: string;
  }) => Promise<{ error?: string }>;
  logout: () => void;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

const TOKEN_KEY = 'soat_token';

type Action =
  | { type: 'SET_AUTHENTICATED'; user: User; token: string }
  | { type: 'SET_UNAUTHENTICATED' };

const reducer = (_state: AuthState, action: Action): AuthState => {
  switch (action.type) {
    case 'SET_AUTHENTICATED':
      return {
        status: 'authenticated',
        user: action.user,
        token: action.token,
      };
    case 'SET_UNAUTHENTICATED':
      return { status: 'unauthenticated' };
  }
};

const fetchCurrentUser = async (token: string): Promise<User | null> => {
  try {
    const res = await fetch('/api/v1/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as User;
    return { id: data.id, username: data.username, role: data.role };
  } catch {
    return null;
  }
};

const callLogin = async (args: {
  username: string;
  password: string;
}): Promise<{ user: User; token: string } | { error: string }> => {
  try {
    const res = await fetch('/api/v1/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => {
        return {};
      })) as {
        error?: string;
      };
      return { error: data.error ?? 'Invalid credentials' };
    }
    const data = (await res.json()) as User & { token: string };
    return {
      user: { id: data.id, username: data.username, role: data.role },
      token: data.token,
    };
  } catch {
    return { error: 'Network error. Please try again.' };
  }
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, dispatch] = React.useReducer(reducer, { status: 'loading' });

  React.useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      dispatch({ type: 'SET_UNAUTHENTICATED' });
      return;
    }
    fetchCurrentUser(token).then((user) => {
      if (user) {
        dispatch({ type: 'SET_AUTHENTICATED', user, token });
      } else {
        localStorage.removeItem(TOKEN_KEY);
        dispatch({ type: 'SET_UNAUTHENTICATED' });
      }
    });
  }, []);

  const login = async (args: { username: string; password: string }) => {
    const result = await callLogin(args);
    if ('error' in result) return { error: result.error };
    localStorage.setItem(TOKEN_KEY, result.token);
    dispatch({
      type: 'SET_AUTHENTICATED',
      user: result.user,
      token: result.token,
    });
    return {};
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    dispatch({ type: 'SET_UNAUTHENTICATED' });
  };

  return (
    <AuthContext.Provider value={{ state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
