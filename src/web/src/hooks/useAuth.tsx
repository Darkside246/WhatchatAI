import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type AuthUserDto, type WorkspaceBusiness, type BusinessRole } from '../lib/api.js';

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  user: AuthUserDto | null;
  business: WorkspaceBusiness | null;
  role: BusinessRole | null;
  /** Only true while no business has any member yet - the one-time first-run signup window. */
  registrationOpen: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; displayName: string }) => Promise<void>;
  /** Real multi-tenant signup (POST /api/trials/register) - creates a genuinely new business, unlike register() above which is the single-install bootstrap path. No local state hand-rolling here: the route already sets a real session cookie, so this just rehydrates user/business/role via the normal refresh(). */
  registerTrial: (input: { name: string; email: string; phone: string; productKey: string }) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  /** Re-fetches `user`/`business`/`role` from /api/auth/me - e.g. after a settings change (branding, name) that other parts of the UI (nav rail logo, brand accent color) need to pick up without a full page reload. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [business, setBusiness] = useState<WorkspaceBusiness | null>(null);
  const [role, setRole] = useState<BusinessRole | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api.getMe();
      setUser(me.user);
      setBusiness(me.business);
      setRole(me.role);
      setStatus('authenticated');
    } catch {
      setUser(null);
      setBusiness(null);
      setRole(null);
      try {
        const bootstrap = await api.getBootstrapStatus();
        setRegistrationOpen(bootstrap.registrationOpen);
      } catch {
        setRegistrationOpen(false);
      }
      setStatus('unauthenticated');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const result = await api.login(email, password);
      setUser(result.user);
      setBusiness(result.business);
      setRole(result.role);
      setStatus('authenticated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to sign in.');
      throw err;
    }
  }, []);

  const register = useCallback(async (input: { email: string; password: string; displayName: string }) => {
    setError(null);
    try {
      const result = await api.registerAccount(input);
      setUser(result.user);
      setBusiness(result.business);
      setRole(result.role);
      setStatus('authenticated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create your account.');
      throw err;
    }
  }, []);

  const registerTrial = useCallback(async (input: { name: string; email: string; phone: string; productKey: string }) => {
    await api.registerTrial(input);
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setBusiness(null);
      setRole(null);
      setStatus('unauthenticated');
      void refresh();
    }
  }, [refresh]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthState>(
    () => ({ status, user, business, role, registrationOpen, error, login, register, registerTrial, logout, clearError, refresh }),
    [status, user, business, role, registrationOpen, error, login, register, registerTrial, logout, clearError, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
