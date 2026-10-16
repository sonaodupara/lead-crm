import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';

export type Role = 'owner' | 'supervisor' | 'accountant' | 'technician' | 'sales';
export interface User { id: string; name: string; email: string; role: Role }

const Ctx = createContext<{ user: User | null; loading: boolean; login: (e: string, p: string) => Promise<void>; logout: () => void }>(null as any);
export const useAuth = () => useContext(Ctx);

const USER_KEY = 'sh_user';
const cachedUser = (): User | null => { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } };

export function AuthProvider({ children }: { children: ReactNode }) {
  // Start from the cached profile so a technician can open the app with no signal.
  const [user, setUser] = useState<User | null>(getToken() ? cachedUser() : null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  const logout = useCallback(() => {
    setToken(null); try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
    setUser(null);
  }, []);

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api.get<User>('/api/auth/me')
      .then((u) => { setUser(u); try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch { /* ignore */ } })
      .catch((e) => { if (e?.status === 401) logout(); })   // offline / server down: keep the cached session
      .finally(() => setLoading(false));
    const expired = () => logout();
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
  }, [logout]);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ token: string; user: User }>('/api/auth/login', { email, password });
    setToken(r.token);
    try { localStorage.setItem(USER_KEY, JSON.stringify(r.user)); } catch { /* ignore */ }
    setUser(r.user);
  };
  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}
