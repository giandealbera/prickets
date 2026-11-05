import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { APP_BUILD, APP_VERSION } from '../lib/version';
import toast from 'react-hot-toast';

const roleRedirect = {
  admin:         '/admin',
  jefe_publicas: '/promotor',
  vendedor:      '/promotor',
  owner:         '/eventos',
};

const Login = () => {
  const { login, verifyTwoFactor } = useAuth();
  const navigate  = useNavigate();
  const [form, setForm]       = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  // Mantener la sesion en este dispositivo. Viene marcado: la mayoria entra
  // desde su propio telefono y tener que escribir la clave cada 8 horas, en
  // plena noche de evento, es un estorbo. Quien use un equipo compartido lo
  // destilda.
  const [recordarme, setRecordarme] = useState(true);

  // Segundo paso del login cuando el user tiene 2FA. Si tfaState es null,
  // mostramos email+password. Si es un objeto { partial_token }, mostramos
  // el input del codigo.
  const [tfaState, setTfaState] = useState(null);
  const [tfaCode, setTfaCode]   = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await login(form.email, form.password, recordarme);
      if (result?.needs_2fa) {
        setTfaState({ partial_token: result.partial_token });
        toast('Ingresá el código de 2FA', { icon: '🔐' });
        return;
      }
      toast.success(`Bienvenido, ${result.name}`);
      navigate(roleRedirect[result.role] || '/admin');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Credenciales incorrectas');
    } finally {
      setLoading(false);
    }
  };

  const handleTfaSubmit = async (e) => {
    e.preventDefault();
    if (!tfaCode) return;
    setLoading(true);
    try {
      const user = await verifyTwoFactor(tfaState.partial_token, tfaCode);
      toast.success(`Bienvenido, ${user.name}`);
      navigate(roleRedirect[user.role] || '/admin');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Código incorrecto');
    } finally {
      setLoading(false);
    }
  };

  const cancelTfa = () => {
    setTfaState(null);
    setTfaCode('');
  };

  return (
    <div className="min-h-dvh flex items-center justify-center px-4" style={{ background: '#111312' }}>
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-lg mb-3"
               style={{ background: '#171A19', border: '1px solid #2B312E' }}>
            <svg className="w-7 h-7" style={{ color: '#5C6E5D' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight font-heading" style={{ color: '#E1E5E2' }}>
            Pri<span style={{ color: '#788C79' }}>ckets</span>
          </h1>
          <p className="text-xs mt-1" style={{ color: '#8C948D' }}>Sistema de Entradas</p>
        </div>

        {/* Paso 1: email + password. Paso 2 (2FA): codigo de Authenticator. */}
        {!tfaState ? (
          <form
            onSubmit={handleSubmit}
            className="card space-y-5"
            style={{ background: '#171A19', border: '1px solid #2B312E' }}
          >
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider mb-2" style={{ color: '#8C948D' }}>Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                autoCapitalize="off"
                spellCheck="false"
                enterKeyHint="next"
                className="input"
                placeholder="tuemail@ejemplo.com"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              />
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wider mb-2" style={{ color: '#8C948D' }}>Contraseña</label>
              <input
                type="password"
                required
                autoComplete="current-password"
                enterKeyHint="go"
                className="input"
                placeholder="••••••••"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              />
            </div>

            {/* Sesion larga en este dispositivo. El servidor valida la sesion
                en cada pedido, asi que se puede cortar desde "Sesiones
                activas" o cambiando la contraseña. */}
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 mt-0.5 accent-[#5C6E5D] shrink-0"
                checked={recordarme}
                onChange={e => setRecordarme(e.target.checked)}
              />
              <span>
                <span className="block text-sm" style={{ color: '#D5DBD7' }}>
                  Mantener sesión iniciada
                </span>
                <span className="block text-[11px] leading-snug mt-0.5" style={{ color: '#6B7280' }}>
                  No te vuelve a pedir la contraseña en este dispositivo.
                  Destildalo si es un teléfono o computadora compartida.
                </span>
              </span>
            </label>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-3 text-sm font-semibold tracking-wide"
            >
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>

            <div className="text-center pt-1">
              <Link
                to="/olvide-password"
                className="text-xs hover:underline transition-colors"
                style={{ color: '#8C948D' }}
                onMouseEnter={e => e.target.style.color = '#E1E5E2'}
                onMouseLeave={e => e.target.style.color = '#8C948D'}
              >
                Olvidé mi contraseña
              </Link>
            </div>
          </form>
        ) : (
          <form
            onSubmit={handleTfaSubmit}
            className="card space-y-5"
            style={{ background: '#171A19', border: '1px solid #2B312E' }}
          >
            <div className="text-center">
              <p className="text-2xl mb-2">🔐</p>
              <p className="text-sm font-semibold font-heading">Verificación en dos pasos</p>
              <p className="text-xs mt-1" style={{ color: '#8C948D' }}>
                Ingresá el código de 6 dígitos de tu app de autenticación.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wider mb-2" style={{ color: '#8C948D' }}>
                Código
              </label>
              <input
                type="text"
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9 ]*"
                enterKeyHint="go"
                className="input text-center text-lg font-mono tracking-widest"
                placeholder="000000"
                maxLength={9}
                value={tfaCode}
                onChange={e => setTfaCode(e.target.value)}
              />
              <p className="text-[10px] mt-2 text-center" style={{ color: '#5B635E' }}>
                Si perdiste el dispositivo, podés usar uno de tus códigos de recuperación (formato XXXX-XXXX).
              </p>
            </div>

            <button
              type="submit"
              disabled={loading || !tfaCode}
              className="btn-primary w-full py-3 text-sm font-semibold tracking-wide"
            >
              {loading ? 'Verificando...' : 'Verificar'}
            </button>

            <button
              type="button"
              onClick={cancelTfa}
              className="w-full text-xs underline" style={{ color: '#8C948D' }}
            >
              Volver al login
            </button>
          </form>
        )}

        {/* El sello de build permite ver de un vistazo si el telefono esta
            corriendo la version nueva o una cacheada. */}
        <p className="text-center text-xs mt-6" style={{ color: '#3A413D' }}>
          Prickets {APP_VERSION}
          <span className="block mt-0.5 font-mono" style={{ fontSize: '10px', color: '#2F3733' }}>
            {APP_BUILD}
          </span>
        </p>
      </div>
    </div>
  );
};

export default Login;
