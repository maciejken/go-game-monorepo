import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_FEATURES,
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
} from '../services/api';
import type { AuthUser, ServerFeatures } from '../services/api';
import { AuthContext } from './useAuth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [features, setFeatures] = useState<ServerFeatures>(DEFAULT_FEATURES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then(({ user: me, features: serverFeatures }) => {
        setUser(me);
        setFeatures(serverFeatures);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const loggedInUser = await loginRequest(username, password);
    setUser(loggedInUser);
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const newUser = await registerRequest(username, password);
    setUser(newUser);
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, features, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
