import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ProtectedRoute = ({ children, allowedRoles }) => {
  const { user, loading, sinConexion, reintentarSesion } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-dvh">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-brand" />
      </div>
    );
  }

  // Hay sesion guardada pero el servidor no contesto. Mandar al login aca
  // seria mentir: la sesion no se cayo, se cayo la conexion. Y en la puerta
  // eso termina con el portero escribiendo la contraseña al pedo mientras la
  // fila espera. Le mostramos que reintente.
  if (!user && sinConexion) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center gap-4">
        <p className="text-lg font-semibold">Sin conexión</p>
        <p className="text-sm max-w-xs" style={{ color: '#8C948D' }}>
          No pudimos contactar al servidor. Tu sesión sigue abierta: cuando vuelva
          la señal, tocá reintentar.
        </p>
        <button onClick={reintentarSesion} className="btn-primary px-8 mt-2">
          Reintentar
        </button>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  // Si el usuario tiene que cambiar la password (recien creado por jefe/owner),
  // forzamos /cambiar-password. Asi el creador no conserva acceso a la cuenta.
  // Excepcion: la propia ruta /cambiar-password y /configuracion para que pueda
  // ver la pantalla.
  if (user.must_change_password && location.pathname !== '/cambiar-password') {
    return <Navigate to="/cambiar-password" replace />;
  }

  // Si el rol exige 2FA (env var en backend) y el user no lo tiene
  // habilitado, lo forzamos a /configuracion/2fa. La pantalla acepta el
  // modo "obligatorio": solo se sale activando 2FA o haciendo logout.
  if (user.tfa_required && location.pathname !== '/configuracion/2fa') {
    return <Navigate to="/configuracion/2fa?required=1" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/sin-acceso" replace />;
  }

  return children;
};

export default ProtectedRoute;
