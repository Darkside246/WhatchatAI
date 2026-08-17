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
  logout: () => Promise<void>;
  clearError: () => void;
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
    () => ({ status, user, business, role, registrationOpen, error, login, register, logout, clearError }),
    [status, user, business, role, registrationOpen, error, login, register, logout, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
