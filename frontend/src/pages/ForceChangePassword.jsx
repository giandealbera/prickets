// Pantalla bloqueante para usuarios que tienen must_change_password=1.
// Aparece tras el primer login con la password que les dio el jefe/owner.
// No hay forma de salir de aca hasta que setean una password propia.
//
// Cuando termina, el backend devuelve must_change_password=0 en /auth/me y
// el ProtectedRoute deja de re-direccionar.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api/axios';
import toast from 'react-hot-toast';

const ForceChangePassword = () => {
  const { user, refreshUser, logout } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew]         = useState('');
  const [confirm, setConfirm]         = useState('');
  const [loading, setLoading]         = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (newPassword.length < 8) return toast.error('La nueva contraseña debe tener al menos 8 caracteres');
    if (newPassword !== confirm) return toast.error('Las contraseñas no coinciden');
    if (currentPassword && newPassword === currentPassword)
      return toast.error('La nueva debe ser distinta de la actual');
    setLoading(true);
    try {
      // currentPassword es opcional en flujo must_change_password (el JWT
      // ya prueba identidad). El backend acepta omitirlo en ese caso.
      const body = currentPassword ? { currentPassword, newPassword } : { newPassword };
      await api.post('/auth/change-password', body);
      toast.success('Contraseña actualizada');
      // Refrescamos el user para que must_change_password vuelva a 0 y el
      // ProtectedRoute nos deje pasar.
      if (refreshUser) await refreshUser();
      navigate('/eventos', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al cambiar la contraseña');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center px-4"
         style={{ background: 'linear-gradient(160deg, #07090E 0%, #0D1117 50%, #0A0F18 100%)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black tracking-tight" style={{ color: '#C9974D' }}>Prickets</h1>
          <p className="text-sm mt-1" style={{ color: '#4A5568' }}>Setea tu propia contraseña</p>
        </div>

        <form onSubmit={submit}
              className="rounded-2xl p-6 space-y-5"
              style={{ background: '#0D1117', border: '1px solid #1E2530' }}>
          <div className="rounded-lg p-3 text-sm"
               style={{ background: 'rgba(201,151,77,0.08)', border: '1px solid rgba(201,151,77,0.3)', color: '#C9974D' }}>
            Antes de seguir, cambiá la contraseña que te dieron. Esta queda solo tuya — nadie más la puede ver.
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6B7280' }}>
              Contraseña actual <span className="normal-case font-normal" style={{ color: '#4B5563' }}>(dejala vacía si entraste por link mágico)</span>
            </label>
            <input type="password" autoComplete="current-password"
                   className="input" value={currentPassword}
                   onChange={e => setCurrent(e.target.value)} />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6B7280' }}>
              Nueva contraseña
            </label>
            <input type="password" required minLength={8} autoComplete="new-password"
                   className="input" placeholder="Al menos 8 caracteres"
                   value={newPassword}
                   onChange={e => setNew(e.target.value)} />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6B7280' }}>
              Confirmar nueva contraseña
            </label>
            <input type="password" required autoComplete="new-password"
                   className="input" value={confirm}
                   onChange={e => setConfirm(e.target.value)} />
          </div>

          <button type="submit" disabled={loading}
                  className="w-full py-3 rounded-xl font-bold tracking-wider text-sm transition-all duration-150 disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg, #C9974D, #A87B35)', color: '#fff', boxShadow: '0 4px 24px rgba(201,151,77,0.25)' }}>
            {loading ? 'Guardando...' : 'Cambiar contraseña'}
          </button>

          <button type="button" onClick={() => { logout(); navigate('/login'); }}
                  className="w-full text-xs underline" style={{ color: '#6B7280' }}>
            Cerrar sesión
          </button>
        </form>

        {user && (
          <p className="text-center text-xs mt-6" style={{ color: '#2D3748' }}>
            {user.email}
          </p>
        )}
      </div>
    </div>
  );
};

export default ForceChangePassword;
