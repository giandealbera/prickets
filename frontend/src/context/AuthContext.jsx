import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import { getToken, setToken, clearToken } from '../lib/authToken';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);
  // Hay token guardado pero no pudimos confirmarlo porque el servidor no
  // contesto. No es lo mismo que no tener sesion: no hay que mandar al login.
  const [sinConexion, setSinConexion] = useState(false);

  // Al abrir la app confirmamos la sesion contra /auth/me.
  //
  // Antes, CUALQUIER error de esa llamada borraba el token. Un bache de señal
  // en la puerta, o el backend tardando en responder, y el portero quedaba
  // deslogueado teniendo que escribir la contraseña con la fila esperando.
  // Eso es el "la sesion no se mantiene iniciada".
  //
  // Ahora distinguimos dos cosas:
  //   - el servidor contesto que no (4xx): sesion muerta. El interceptor de
  //     axios ya borra el token y manda al login.
  //   - el servidor no contesto: reintentamos, y si igual no hay caso dejamos
  //     el token donde esta y avisamos que no hay conexion.
  const confirmarSesion = useCallback(async (señal = {}) => {
    const ESPERAS_MS = [0, 1000, 3000];
    for (const espera of ESPERAS_MS) {
      if (espera) await new Promise(r => setTimeout(r, espera));
      if (señal.cancelado) return;
      try {
        const r = await api.get('/auth/me');
        if (señal.cancelado) return;
        setUser(r.data);
        setSinConexion(false);
        setLoading(false);
        return;
      } catch (err) {
        const status = err?.response?.status;
        if (status && status < 500) {        // respuesta definitiva del server
          if (!señal.cancelado) { setSinConexion(false); setLoading(false); }
          return;
        }
      }
    }
    if (!señal.cancelado) { setSinConexion(true); setLoading(false); }
  }, []);

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    const señal = { cancelado: false };
    confirmarSesion(señal);
    return () => { señal.cancelado = true; };
  }, [confirmarSesion]);

  // Para el boton "Reintentar" de la pantalla sin conexion.
  const reintentarSesion = useCallback(() => {
    setLoading(true);
    return confirmarSesion({});
  }, [confirmarSesion]);

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
    setSinConexion(false);
    return res.data.user;
  }, []);

  const verifyTwoFactor = useCallback(async (partial_token, code) => {
    const res = await api.post('/auth/2fa/verify', { partial_token, code });
    setToken(res.data.token);
    setUser(res.data.user);
    setSinConexion(false);
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
    setSinConexion(false);
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
    () => ({ user, loading, sinConexion, reintentarSesion, login, logout, refreshUser, verifyTwoFactor }),
    [user, loading, sinConexion, reintentarSesion, login, logout, refreshUser, verifyTwoFactor]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
