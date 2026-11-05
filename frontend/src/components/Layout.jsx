import { useAuth } from '../context/AuthContext';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';
import EventQuickReturn from './EventQuickReturn';

const Layout = ({ children }) => {
  const { user } = useAuth();

  return (
    // min-h-dvh respeta el viewport real de iOS Safari (que cambia cuando
    // muestra/oculta la barra de URL). Antes con min-h-dvh el header
    // quedaba tapado al hacer scroll hacia abajo.
    <div className="flex min-h-dvh" style={{ background: '#111312' }}>
      {/* Sidebar desktop */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Main content. pb-24 deja espacio para el BottomNav fijo + safe-area.
          min-w-0 es imprescindible: `main` es un item flex y por defecto no
          puede achicarse por debajo de su contenido (min-width:auto). Sin eso
          una tabla ancha estiraba `main` a 865px en una pantalla de 375 y
          arrastraba TODA la pagina a scrollear de costado; ademas los
          contenedores con overflow-x-auto nunca llegaban a scrollear por
          dentro, porque crecian junto con el padre en vez de recortar. */}
      <main className="flex-1 min-w-0 pb-24 lg:pb-0">
        {/* Header mobile sticky */}
        <header className="lg:hidden sticky top-0 z-30 backdrop-blur-lg pt-safe" style={{ background: 'rgba(23,26,25,0.98)', borderBottom: '1px solid #2B312E' }}>
          <div className="px-4 py-3 flex items-center justify-between safe-area-x">
            <div>
              <span className="text-xl font-bold font-heading select-none" style={{ color: '#E1E5E2' }}>Pri<span style={{ color: '#788C79' }}>ckets</span></span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm truncate max-w-[120px]" style={{ color: '#8C948D' }}>{user?.name}</span>
              <div className="w-8 h-8 rounded-md flex items-center justify-center text-sm font-semibold shrink-0" style={{ background: '#202422', border: '1px solid #2B312E', color: '#E1E5E2' }}>
                {user?.name?.charAt(0)?.toUpperCase()}
              </div>
            </div>
          </div>
        </header>

        {children}
      </main>

      {/* Acceso directo flotante al home del evento activo (solo mobile,
          se auto-oculta cuando ya estas dentro del evento). */}
      <EventQuickReturn />

      {/* Bottom nav mobile. safe-area-bottom ya esta dentro del componente. */}
      <div className="lg:hidden">
        <BottomNav />
      </div>
    </div>
  );
};

export default Layout;
