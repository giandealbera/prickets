import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api/axios';

const ResetPassword = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  const [form, setForm]       = useState({ password: '', confirm: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [done, setDone]       = useState(false);
  const [showPass, setShowPass] = useState(false);
  // Estado del link: lo validamos al abrir la pantalla para no hacer que el
  // usuario elija y confirme una contraseña nueva y recien ahi se entere de
  // que el link estaba vencido.
  const [checking, setChecking] = useState(true);
  const [linkError, setLinkError] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    let cancelado = false;
    api.get(`/auth/reset-password/${token}`)
      .then(r => { if (!cancelado) setName(r.data?.name || ''); })
      .catch(err => {
        if (!cancelado) setLinkError(err.response?.data?.error || 'No pudimos validar el link.');
      })
      .finally(() => { if (!cancelado) setChecking(false); });
    return () => { cancelado = true; };
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres');
      return;
    }
    if (form.password !== form.confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password: form.password });
      setDone(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      // 400/410 = el link dejo de servir mientras completaba el formulario.
      // Lo mostramos como pantalla de link vencido, no como error del campo.
      const status = err.response?.status;
      const msg = err.response?.data?.error || 'No se pudo resetear la contraseña';
      if (status === 400 || status === 410) setLinkError(msg);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center px-4" style={{ background: 'linear-gradient(160deg, #07090E 0%, #0D1117 50%, #0A0F18 100%)' }}>
      <div className="w-full max-w-sm">

        <div className="text-center mb-10">
          <h1 className="text-3xl font-black tracking-tight" style={{ color: '#C9974D' }}>Prickets</h1>
          <p className="text-sm mt-1" style={{ color: '#4A5568' }}>Nueva contraseña</p>
        </div>

        <div className="rounded-2xl p-6 space-y-5" style={{ background: '#0D1117', border: '1px solid #1E2530' }}>
          {checking ? (
            <div className="text-center py-6">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 mx-auto mb-3"
                   style={{ borderColor: '#C9974D' }} />
              <p className="text-sm text-gray-400">Validando el link…</p>
            </div>
          ) : linkError ? (
            <div className="text-center py-4">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3"
                   style={{ background: 'rgba(185,28,28,0.10)', border: '1px solid rgba(185,28,28,0.35)' }}>
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="#FCA5A5" strokeWidth={1.75}
                     strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-white mb-2">Este link ya no sirve</h2>
              <p className="text-sm text-gray-400 leading-relaxed mb-5">{linkError}</p>
              <Link to="/olvide-password"
                    className="block w-full text-center py-3 rounded-xl font-semibold text-sm"
                    style={{ background: 'linear-gradient(135deg, #C9974D, #A87B35)', color: '#fff' }}>
                Pedir un link nuevo
              </Link>
              <Link to="/login" className="block mt-3 text-xs hover:underline" style={{ color: '#6B7280' }}>
                ← Volver a inicio de sesión
              </Link>
            </div>
          ) : done ? (
            <div className="text-center py-4">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3"
                   style={{ background: 'rgba(52,211,153,0.15)' }}>
                <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-white mb-2">Contraseña actualizada</h2>
              <p className="text-sm text-gray-400">Redirigiendo al login...</p>
            </div>
          ) : (
            <>
              <div>
                <h2 className="text-lg font-semibold text-white mb-1">
                  {name ? `Hola ${name}, elegí tu nueva contraseña` : 'Elegí tu nueva contraseña'}
                </h2>
                <p className="text-xs text-gray-500">
                  Mínimo 8 caracteres. Al guardarla se cierran todas tus sesiones abiertas.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-semibold uppercase tracking-widest" style={{ color: '#6B7280' }}>Nueva contraseña</label>
                  {/* Ver la clave evita el clasico "la escribi mal dos veces"
                      en el teclado del celular. */}
                  <button type="button" onClick={() => setShowPass(v => !v)}
                          className="text-[11px] hover:underline" style={{ color: '#6B7280' }}>
                    {showPass ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
                <input
                  type={showPass ? 'text' : 'password'}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="input"
                  placeholder="••••••••"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#6B7280' }}>Confirmar contraseña</label>
                <input
                  type={showPass ? 'text' : 'password'}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="input"
                  placeholder="••••••••"
                  value={form.confirm}
                  onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))}
                />
                {form.confirm && form.password !== form.confirm && (
                  <p className="text-[11px] mt-1.5 text-red-400">Las contraseñas no coinciden</p>
                )}
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button
                type="button"
                disabled={loading || !form.password || !form.confirm}
                onClick={handleSubmit}
                className="w-full py-3 rounded-xl font-bold tracking-wider text-sm transition-all duration-150 disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #C9974D, #A87B35)', color: '#fff', boxShadow: '0 4px 24px rgba(201,151,77,0.25)' }}
              >
                {loading ? 'Guardando...' : 'Actualizar contraseña'}
              </button>

              <div className="text-center pt-2">
                <Link to="/login" className="text-xs hover:underline" style={{ color: '#6B7280' }}>
                  ← Volver a inicio de sesión
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ResetPassword;
