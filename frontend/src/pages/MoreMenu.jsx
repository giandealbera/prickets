import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { APP_BUILD, APP_VERSION } from '../lib/version';
import Layout from '../components/Layout';

const SvgIcon = ({ path }) => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
    <path strokeLinecap="round" strokeLinejoin="round" d={path} />
  </svg>
);

const ICONS = {
  users:    'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m9-4a4 4 0 11-8 0 4 4 0 018 0zm6-3a3 3 0 11-6 0 3 3 0 016 0z',
  megaphone:'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z',
  money:    'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  chart:    'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  receipt:  'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  info:     'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  ticket:   'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z',
};

const MenuItem = ({ iconKey, label, desc, onClick }) => (
  <button
    onClick={onClick}
    className="w-full card flex items-center gap-4 hover:border-[#38403C] transition-all active:scale-[0.98] text-left"
    style={{ background: '#171A19', border: '1px solid #2B312E' }}
  >
    <span style={{ color: '#788C79' }}><SvgIcon path={ICONS[iconKey]} /></span>
    <div className="flex-1 min-w-0">
      <p className="font-medium text-sm font-heading" style={{ color: '#E1E5E2' }}>{label}</p>
      {desc && <p className="text-xs mt-0.5" style={{ color: '#8C948D' }}>{desc}</p>}
    </div>
    <span style={{ color: '#5B635E' }}>›</span>
  </button>
);

const MoreMenu = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const ROLE_DISPLAY = {
    admin:         'Administrador',
    owner:         'Dueño',
    jefe_publicas: 'Jefe de públicas',
    vendedor:      'Vendedor',
  };

  return (
    <Layout>
      <div className="px-4 lg:px-8 py-6 max-w-2xl mx-auto">
        <h1 className="text-xl font-bold font-heading tracking-tight mb-6" style={{ color: '#E1E5E2' }}>Más opciones</h1>

        {/* Profile card */}
        <div className="card flex items-center gap-4 mb-6" style={{ background: '#171A19', border: '1px solid #2B312E' }}>
          <div className="w-12 h-12 rounded-md flex items-center justify-center text-base font-semibold"
               style={{ background: '#202422', color: '#E1E5E2', border: '1px solid #2B312E' }}>
            {user?.name?.charAt(0)?.toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold truncate" style={{ color: '#E1E5E2' }}>{user?.name}</p>
            <p className="text-xs truncate" style={{ color: '#8C948D' }}>{user?.email}</p>
            <span className="inline-block text-[10px] uppercase tracking-wider mt-1 px-2 py-0.5 rounded font-medium"
                  style={{ background: '#202422', color: '#B59E7D', border: '1px solid #2B312E' }}>
              {ROLE_DISPLAY[user?.role] || user?.role}
            </span>
          </div>
        </div>

        {/* Menu items */}
        <div className="space-y-2">
          {user?.role === 'admin' && (
            <>
              <MenuItem iconKey="users"     label="Dueños del sistema"    desc="Gestionar clientes que usan el sistema" onClick={() => navigate('/admin/usuarios')} />
              <MenuItem iconKey="chart"     label="Dashboard general"     desc="Vista global cross-tenant" onClick={() => navigate('/admin')} />
              <MenuItem iconKey="money"     label="Reportes globales"     desc="Métricas del sistema" onClick={() => navigate('/admin/reportes')} />
              <MenuItem iconKey="chart"     label="Historial de eventos"  desc="Todos los eventos del sistema" onClick={() => navigate('/admin/historial')} />
              <MenuItem iconKey="ticket"    label="Reiniciar eventos"     desc="Borrar tickets y rendiciones por evento (acción peligrosa)" onClick={() => navigate('/admin/reset-eventos')} />
              <MenuItem iconKey="receipt"   label="Bitácora"              desc="Registro de acciones sensibles del sistema" onClick={() => navigate('/admin/bitacora')} />
            </>
          )}
          {user?.role === 'owner' && (
            <>
              <MenuItem iconKey="ticket"    label="Cortesías"             desc="Entradas regaladas a invitados" onClick={() => navigate('/admin/cortesias')} />
              <MenuItem iconKey="users"     label="Mi Personal"           desc="Jefes y vendedores de tu equipo" onClick={() => navigate('/admin/usuarios')} />
              <MenuItem iconKey="megaphone" label="Mis Públicas"          desc="Ventas y comisiones de tus públicas" onClick={() => navigate('/admin/promotores')} />
              <MenuItem iconKey="receipt"   label="Rendición"             desc="Registrar pagos de tus públicas" onClick={() => navigate('/admin/rendicion')} />
              <MenuItem iconKey="chart"     label="Control en vivo"       desc="Ingresos en tiempo real" onClick={() => navigate('/admin/control')} />
              <MenuItem iconKey="chart"     label="Mi Historial"          desc="Tus eventos pasados" onClick={() => navigate('/admin/historial')} />
              <MenuItem iconKey="megaphone" label="Lista de descuentos"    desc="Compradores que quieren recibir preventas" onClick={() => navigate('/admin/newsletter')} />
              <MenuItem iconKey="users"     label="Mis Zonas"             desc="Agrupar vendedores por zona" onClick={() => navigate('/admin/zonas')} />
              <MenuItem iconKey="users"     label="Mis Proveedores"       desc="Contactos y datos de pago" onClick={() => navigate('/admin/proveedores')} />
              <MenuItem iconKey="receipt"   label="Bitácora"              desc="Quién hizo qué cuándo en tu cuenta" onClick={() => navigate('/admin/bitacora')} />
            </>
          )}
          {(user?.role === 'jefe_publicas' || user?.role === 'vendedor') && (
            <>
              <MenuItem iconKey="ticket"    label="Vender entradas"       desc="Elegí el evento y generá desde adentro" onClick={() => navigate('/eventos')} />
              <MenuItem iconKey="chart"     label="Mi Panel de ventas"    desc="Ver tus ventas acumuladas y comisiones" onClick={() => navigate('/promotor')} />
              <MenuItem iconKey="ticket"    label="Mis Eventos"           desc="Ver los eventos asignados" onClick={() => navigate('/eventos')} />
            </>
          )}

          <div className="pt-4 border-t mt-4" style={{ borderColor: '#2B312E' }}>
            <MenuItem iconKey="users" label="Configuración" desc="Cambiar tu contraseña y ver tus datos" onClick={() => navigate('/configuracion')} />
            <MenuItem iconKey="info"  label="Verificación en dos pasos" desc="Activar 2FA para proteger tu cuenta" onClick={() => navigate('/configuracion/2fa')} />
            <MenuItem iconKey="info"  label="Sesiones activas" desc="Dispositivos donde estás logueado" onClick={() => navigate('/configuracion/sesiones')} />
            {/* Mostramos el build: si el telefono quedo con una version
                vieja cacheada, se ve aca sin tener que adivinar. */}
            <MenuItem iconKey="info"  label="Acerca de Prickets"
                      desc={`${APP_VERSION} · ${APP_BUILD}`} onClick={() => {}} />
          </div>
        </div>

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="w-full mt-8 py-3 rounded-md font-medium text-sm transition-colors active:scale-[0.98]"
          style={{ background: '#2B1D1E', border: '1px solid #45292B', color: '#D47779' }}
        >
          Cerrar sesión
        </button>
      </div>
    </Layout>
  );
};

export default MoreMenu;
