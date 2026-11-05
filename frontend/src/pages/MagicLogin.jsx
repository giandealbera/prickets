import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { BACKEND_URL as BACKEND } from '../api/config';
import { setToken } from '../lib/authToken';

// Espejo del roleRedirect de Login.jsx para que un admin/owner que abre un
// magic link no termine en /promotor (que no tiene acceso) sin acceso.
const ROLE_REDIRECT = {
  admin:         '/admin',
  owner:         '/eventos',
  jefe_publicas: '/promotor',
  vendedor:      '/promotor',
};

const MagicLogin = () => {
  const { token } = useParams();
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${BACKEND}/auth/magic/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); return; }
        setToken(data.token);
        const dest = ROLE_REDIRECT[data.user?.role] || '/eventos';
        window.location.href = dest;
      })
      .catch(() => setError('No se pudo conectar al servidor'));
  }, [token]);

  if (error) return (
    <div className="min-h-dvh flex items-center justify-center p-6" style={{ background: '#07090E' }}>
      <div className="text-center">
        <p className="text-3xl font-black tracking-tight mb-6" style={{ color: '#C9974D' }}>Prickets</p>
        <p className="text-red-400 text-lg font-semibold">{error}</p>
        <p className="text-gray-500 text-sm mt-2">Este link es invalido o fue desactivado.</p>
        <Link to="/login" className="mt-4 inline-block text-brand underline text-sm">Ir al login</Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh flex items-center justify-center" style={{ background: '#07090E' }}>
      <div className="text-center">
        <p className="text-3xl font-black tracking-tight mb-6" style={{ color: '#C9974D' }}>Prickets</p>
        <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-brand mx-auto mb-4" />
        <p className="text-gray-400 text-sm">Iniciando sesion...</p>
      </div>
    </div>
  );
};

export default MagicLogin;
