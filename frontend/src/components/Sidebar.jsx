import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const navItems = {
  // Admin = SaaS operator. Solo ve cosas cross-tenant y agregadas. Lo
  // operativo de un evento (vender, escanear, cortesias, rendir) se
  // hace desde el panel del Dueño. Si necesita entrar por soporte, las
  // URLs siguen accesibles para admin pero no aparecen en el menu.
  admin: [
    { to: '/admin',           label: 'Dashboard'   },
    { to: '/eventos',         label: 'Eventos'     },
    { to: '/admin/usuarios',  label: 'Dueños'      },
    { to: '/admin/reportes',  label: 'Reportes'    },
    { to: '/admin/historial', label: 'Historial'   },
    { to: '/admin/bitacora',  label: 'Bitácora'    },
    { to: '/configuracion',   label: 'Configuracion' },
  ],
  jefe_publicas: [
    { to: '/eventos',  label: 'Eventos'  },
    { to: '/promotor', label: 'Mi Panel' },
  ],
  vendedor: [
    { to: '/eventos',  label: 'Eventos'  },
    { to: '/promotor', label: 'Mi Panel' },
  ],
  // Owner = cliente que compró el sistema. Tiene panel completo pero
  // SOLO ve datos de SUS eventos (event_owners).
  owner: [
    { to: '/eventos',           label: 'Mis Eventos'   },
    { to: '/caja',              label: 'Vender'        },
    { to: '/escaner',           label: 'Escaner'       },
    { to: '/admin/cortesias',   label: 'Cortesías'     },
    { to: '/admin/usuarios',    label: 'Mi Personal'   },
    { to: '/admin/promotores',  label: 'Mis Públicas'  },
    { to: '/admin/rendicion',   label: 'Rendición'     },
    { to: '/admin/control',     label: 'Control en vivo' },
    { to: '/admin/reportes',    label: 'Reportes'      },
    { to: '/admin/historial',   label: 'Historial'     },
    { to: '/admin/zonas',       label: 'Mis Zonas'     },
    { to: '/admin/proveedores', label: 'Proveedores'   },
    { to: '/admin/bitacora',    label: 'Bitácora'      },
    { to: '/configuracion',     label: 'Configuración' },
  ],
};

const ROLE_LABELS = {
  admin:         'Administrador',
  jefe_publicas: 'Jefe de Publicas',
  vendedor:      'Vendedor',
  owner:         'Dueño del evento',
};

const Sidebar = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const items = navItems[user?.role] || [];

  return (
    <aside className="w-56 min-h-dvh flex flex-col" style={{ background: '#171A19', borderRight: '1px solid #2B312E' }}>
      {/* Logo */}
      <div className="px-6 py-5" style={{ borderBottom: '1px solid #2B312E' }}>
        <span className="text-xl font-bold tracking-tight font-heading" style={{ color: '#E1E5E2' }}>Pri<span style={{ color: '#788C79' }}>ckets</span></span>
        <p className="text-xs mt-0.5" style={{ color: '#8C948D' }}>Sistema de Entradas</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/admin'}
            className={({ isActive }) =>
              `flex items-center px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-150 ${
                isActive
                  ? 'text-white'
                  : 'hover:text-gray-200'
              }`
            }
            style={({ isActive }) => isActive
              ? { background: '#202422', color: '#F1F4F2', borderLeft: '3px solid #5C6E5D', paddingLeft: '9px' }
              : { color: '#8C948D' }
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* User */}
      <div className="px-4 py-4" style={{ borderTop: '1px solid #2B312E' }}>
        <div className="text-sm font-semibold" style={{ color: '#E1E5E2' }}>{user?.name}</div>
        <div className="text-xs mt-0.5" style={{ color: '#8C948D' }}>{ROLE_LABELS[user?.role] || user?.role}</div>
        <button
          onClick={() => { logout(); navigate('/login'); }}
          className="mt-3 text-xs transition-colors"
          style={{ color: '#D47779' }}
          onMouseEnter={e => e.target.style.color = '#EF4444'}
          onMouseLeave={e => e.target.style.color = '#D47779'}
        >
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
