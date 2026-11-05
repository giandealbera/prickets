import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/axios';

// Recuperar acceso: dos modos.
//
// 1) Email (el de toda la vida): pedis email, te llega un link al mail
//    siempre que RESEND_API_KEY este configurado en backend.
// 2) Celular + apellido: para gente que no tiene email o no se acuerda
//    cual cargo. El backend matchea celular + apellido. Si encuentra el
//    user, devuelve el link de acceso directamente para tocar — sin pasar
//    por email. Se usa el mismo magic_token de 1h que el flow email.
//
// El default es "Celular" porque es mas comun en el publico del piloto.
// Email queda como alternativa para los que lo tienen activo.

const ForgotPassword = () => {
  const [mode, setMode]       = useState('phone');  // 'phone' | 'email'
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  // Email flow
  const [email, setEmail]     = useState('');
  const [emailSent, setEmailSent] = useState(false);

  // Phone flow
  const [celular,  setCelular]  = useState('');
  const [apellido, setApellido] = useState('');
  const [phoneResult, setPhoneResult] = useState(null); // { user_name, magic_path }

  const navigate = useNavigate();

  // Cuando el backend avisa que el envio de mails no esta disponible
  // (RESEND_API_KEY sin configurar o proveedor caido) mostramos un cartel
  // que explica que hacer, en vez del "te enviamos un link" de siempre —
  // que dejaba al usuario esperando un mail que nunca iba a llegar.
  const [mailDown, setMailDown] = useState(false);

  // Cuenta regresiva para reenviar. El backend permite 3 pedidos cada 15
  // minutos por IP: sin este freno, dos toques impacientes se comen el cupo
  // y el proximo intento rebota.
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submitEmail = async (e) => {
    e?.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.post('/auth/forgot-password', { email });
      setEmailSent(true);
      setCooldown(45);
    } catch (err) {
      if (err.response?.data?.code === 'MAIL_NOT_CONFIGURED') {
        setMailDown(true);
      } else {
        setError(err.response?.data?.error || 'Error al enviar. Probá de nuevo.');
      }
    } finally {
      setLoading(false);
    }
  };

  const submitPhone = async (e) => {
    e?.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await api.post('/auth/forgot-password-phone', { celular, apellido });
      if (r.data?.ok && r.data?.magic_path) {
        setPhoneResult(r.data);
      } else {
        setError(r.data?.error || 'No encontramos esa combinación.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Error al consultar. Probá de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setPhoneResult(null);
    setEmailSent(false);
    setMailDown(false);
  };

  return (
    <div className="min-h-dvh flex items-center justify-center px-4"
         style={{ background: 'linear-gradient(160deg, #07090E 0%, #0D1117 50%, #0A0F18 100%)' }}>
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <h1 className="text-3xl font-black tracking-tight" style={{ color: '#C9974D' }}>Prickets</h1>
          <p className="text-sm mt-1" style={{ color: '#4A5568' }}>Recuperar acceso</p>
        </div>

        <div className="rounded-2xl p-6 space-y-5"
             style={{ background: '#0D1117', border: '1px solid #1E2530' }}>

          {/* CASO: encontramos al user por celular — mostramos boton de entrada. */}
          {phoneResult ? (
            <>
              <div className="text-center py-2">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3"
                     style={{ background: 'rgba(201,151,77,0.12)', border: '1px solid rgba(201,151,77,0.3)' }}>
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="#C9974D" strokeWidth={1.75}
                       strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-white mb-1">Hola {phoneResult.user_name}</h2>
                <p className="text-sm text-gray-400 leading-relaxed">
                  Te encontramos. Tocá el botón y vas a entrar al sistema para que pongas una nueva contraseña.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate(phoneResult.magic_path)}
                className="block w-full text-center py-3 rounded-xl font-semibold text-sm transition-all"
                style={{ background: 'linear-gradient(135deg, #C9974D, #A87B35)', color: '#fff', boxShadow: '0 4px 24px rgba(201,151,77,0.25)' }}
              >
                Entrar y cambiar contraseña
              </button>
              <p className="text-[11px] text-center" style={{ color: '#6B7280' }}>
                Este link vale 1 hora y es de un solo uso.
              </p>
            </>
          ) : mailDown ? (
            <>
              <div className="text-center py-2">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3"
                     style={{ background: 'rgba(202,138,4,0.12)', border: '1px solid rgba(202,138,4,0.35)' }}>
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="#FCD34D" strokeWidth={1.75}
                       strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">El envío por email no está disponible</h2>
                <p className="text-sm text-gray-400 leading-relaxed">
                  No te lo dejamos pendiente: el mail no iba a llegar. Recuperá tu acceso
                  con celular + apellido, o pedile a un administrador que te genere un acceso directo.
                </p>
              </div>
              <button
                type="button"
                onClick={() => switchMode('phone')}
                className="w-full py-3 rounded-xl font-semibold text-sm"
                style={{ background: 'linear-gradient(135deg, #C9974D, #A87B35)', color: '#fff', boxShadow: '0 4px 24px rgba(201,151,77,0.25)' }}
              >
                Recuperar con celular
              </button>
              <Link to="/login"
                    className="block w-full text-center text-xs hover:underline"
                    style={{ color: '#6B7280' }}>
                ← Volver a inicio de sesión
              </Link>
            </>
          ) : emailSent ? (
            <>
              <div className="text-center py-4">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3"
                     style={{ background: 'rgba(52,211,153,0.15)' }}>
                  <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24"
                       stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">Pedido enviado</h2>
                <p className="text-sm text-gray-400 leading-relaxed">
                  Si el email <span className="text-gray-200">{email}</span> está registrado, te enviamos un link. Vale 1 hora.
                </p>
                <p className="text-xs text-gray-500 mt-3">
                  Revisá tu casilla y la carpeta de spam.
                </p>
              </div>

              {error && <p className="text-sm text-red-400 text-center">{error}</p>}

              <button
                type="button"
                disabled={cooldown > 0 || loading}
                onClick={() => submitEmail()}
                className="w-full py-2.5 rounded-xl text-sm font-medium disabled:opacity-40"
                style={{ background: '#161B24', border: '1px solid #1E2530', color: '#E8EAF0' }}
              >
                {loading ? 'Reenviando…'
                  : cooldown > 0 ? `Reenviar en ${cooldown}s`
                  : 'No me llegó, reenviar'}
              </button>
              <button
                type="button"
                onClick={() => switchMode('phone')}
                className="w-full py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#161B24', border: '1px solid #1E2530', color: '#E8EAF0' }}
              >
                Probar con celular
              </button>
              <Link to="/login"
                    className="block w-full text-center text-xs hover:underline"
                    style={{ color: '#6B7280' }}>
                ← Volver a inicio de sesión
              </Link>
            </>
          ) : (
            <>
              <div>
                <h2 className="text-lg font-semibold text-white mb-1">¿Olvidaste tu contraseña?</h2>
                <p className="text-xs text-gray-500">
                  Recuperá tu acceso por celular (más rápido) o por email.
                </p>
              </div>

              {/* Tabs */}
              <div className="grid grid-cols-2 gap-1 p-1 rounded-xl"
                   style={{ background: '#161B24', border: '1px solid #1E2530' }}>
                <button type="button" onClick={() => switchMode('phone')}
                  className="py-2 rounded-lg text-xs font-semibold transition-colors"
                  style={mode === 'phone'
                    ? { background: '#C9974D', color: '#0B0F14' }
                    : { color: '#9AA3B2' }}>
                  Celular
                </button>
                <button type="button" onClick={() => switchMode('email')}
                  className="py-2 rounded-lg text-xs font-semibold transition-colors"
                  style={mode === 'email'
                    ? { background: '#C9974D', color: '#0B0F14' }
                    : { color: '#9AA3B2' }}>
                  Email
                </button>
              </div>

              {mode === 'phone' ? (
                <form onSubmit={submitPhone} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-widest mb-2"
                           style={{ color: '#6B7280' }}>
                      Celular
                    </label>
                    <input
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      enterKeyHint="next"
                      required
                      className="input"
                      placeholder="11 5555 5555"
                      value={celular}
                      onChange={e => setCelular(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-widest mb-2"
                           style={{ color: '#6B7280' }}>
                      Apellido
                    </label>
                    <input
                      type="text"
                      autoComplete="family-name"
                      enterKeyHint="done"
                      required
                      className="input"
                      placeholder="García"
                      value={apellido}
                      onChange={e => setApellido(e.target.value)}
                    />
                    <p className="text-[11px] mt-1.5" style={{ color: '#4B5563' }}>
                      Mismos datos con los que te cargaron al sistema.
                    </p>
                  </div>

                  {error && <p className="text-sm text-red-400">{error}</p>}

                  <button
                    type="submit"
                    disabled={loading || !celular || !apellido}
                    className="w-full py-3 rounded-xl font-bold tracking-wider text-sm disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg, #C9974D, #A87B35)', color: '#fff', boxShadow: '0 4px 24px rgba(201,151,77,0.25)' }}
                  >
                    {loading ? 'Buscando…' : 'Recuperar acceso'}
                  </button>
                </form>
              ) : (
                <form onSubmit={submitEmail} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-widest mb-2"
                           style={{ color: '#6B7280' }}>
                      Email
                    </label>
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      inputMode="email"
                      autoCapitalize="off"
                      spellCheck="false"
                      enterKeyHint="done"
                      className="input"
                      placeholder="tuemail@ejemplo.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                    />
                  </div>

                  {error && <p className="text-sm text-red-400">{error}</p>}

                  <button
                    type="submit"
                    disabled={loading || !email}
                    className="w-full py-3 rounded-xl font-bold tracking-wider text-sm disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg, #C9974D, #A87B35)', color: '#fff', boxShadow: '0 4px 24px rgba(201,151,77,0.25)' }}
                  >
                    {loading ? 'Enviando…' : 'Enviar link al email'}
                  </button>
                </form>
              )}

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

export default ForgotPassword;
