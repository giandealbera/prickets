import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import { getToken, setToken, clearToken } from '../lib/authToken';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (token) {
      api.get('/auth/me')
        .then(r => setUser(r.data))
        .catch(() => clearToken())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  // Memoizamos los handlers con useCallback. Sino, cada render del provider
  // genera funciones nuevas que cambian la identidad del value y
  // re-renderizan todo arbol que use useAuth() (Layout, Sidebar, BottomNav,
  // ProtectedRoute, MoreMenu, Login, etc).
  // recordarme: mantiene la sesion iniciada en ESTE dispositivo (30 dias en
  // vez de 8 horas). Se puede cortar desde "Sesiones activas" o cambiando la
  // contraseña, porque el servidor valida la sesion en cada pedido.
  const login = useCallback(async (email, password, recordarme = true) => {
    const res = await api.post('/auth/login', { email, password, recordarme });
    if (res.data.needs_2fa) {
      return { needs_2fa: true, partial_token: res.data.partial_token };
    }
    setToken(res.data.token);
    setUser(res.data.user);
    return res.data.user;
  }, []);

  const verifyTwoFactor = useCallback(async (partial_token, code) => {
    const res = await api.post('/auth/2fa/verify', { partial_token, code });
    setToken(res.data.token);
    setUser(res.data.user);
    return res.data.user;
  }, []);

  const logout = useCallback(() => {
    // Revocar la sesion en el servidor (fire-and-forget: si falla, el token
    // local igual se borra y la sesion muere en su exp natural). Header
    // explicito: el interceptor lee localStorage en un microtask y para ese
    // momento el token ya fue borrado.
    const token = getToken();
    if (token) {
      api.post('/sessions/logout', null, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    clearToken();
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const r = await api.get('/auth/me');
      setUser(r.data);
      return r.data;
    } catch {
      return null;
    }
  }, []);

  // useMemo del value: nueva identidad SOLO si cambian user/loading. Las
  // funciones son estables por useCallback. Esto corta el re-render
  // cascada cuando algun hijo cambia sin que cambie la sesion.
  const value = useMemo(
    () => ({ user, loading, login, logout, refreshUser, verifyTwoFactor }),
    [user, loading, login, logout, refreshUser, verifyTwoFactor]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
