import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { isStandalone, isIosSafari } from '../lib/share';

// Banner discreto que solo aparece en Safari iOS cuando la app NO esta
// instalada como PWA. Sugiere agregar al home screen para que la usen
// como app nativa (con su icono, pantalla completa, wake lock, etc).
//
// Se descarta por sesion (sessionStorage) — si el usuario lo cierra, no
// vuelve a salir hasta que recargue la pestania. Asi no se vuelve molesto.
const DISMISSED_KEY = 'prickets:install-tip-dismissed';

// Rutas donde NO mostramos el tip: el portero esta enfocado en escanear y
// el comprador hace un flujo de una sola vez — sumarle "instalá la app"
// es ruido. Lo mostramos solo en la app autenticada.
const HIDE_PATHS = [/^\/scan\//, /^\/comprar\//, /^\/login/, /^\/acceso\//, /^\/olvide/, /^\/reset/];

const InstallTip = () => {
  const [show, setShow] = useState(false);
  const location = useLocation();
  const hidden = HIDE_PATHS.some(re => re.test(location.pathname));

  useEffect(() => {
    if (hidden) return;
    // Solo en Safari iOS sin PWA instalada.
    if (!isIosSafari() || isStandalone()) return;
    try {
      if (sessionStorage.getItem(DISMISSED_KEY)) return;
    } catch { /* sessionStorage puede no estar disponible (privado) */ }
    // Pequeño delay para no aparecer simultaneo al primer paint.
    const t = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(t);
  }, [hidden]);

  // Si cambia la ruta hacia una "oculta", lo escondemos al toque.
  useEffect(() => { if (hidden) setShow(false); }, [hidden]);

  const dismiss = () => {
    setShow(false);
    try { sessionStorage.setItem(DISMISSED_KEY, '1'); } catch {}
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="install-tip"
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0,  opacity: 1 }}
          exit={{    y: 60, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          className="fixed left-3 right-3 z-[65] safe-area-x"
          style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0))' }}
        >
          <div className="flex items-center gap-3 rounded-2xl px-4 py-3 shadow-lg"
               style={{ background: '#0F141B', border: '1px solid #1E2530', backdropFilter: 'blur(10px)' }}>
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                 style={{ background: 'rgba(201,151,77,0.12)', color: '#C9974D' }}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                   strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 0L8 8m4-4l4 4" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white">Instalá la app</p>
              <p className="text-[11px] mt-0.5" style={{ color: '#9AA3B2' }}>
                Tocá <span style={{ color: '#C9974D' }}>Compartir</span> abajo y elegí <b>Agregar al inicio</b>.
              </p>
            </div>
            <button onClick={dismiss}
                    className="shrink-0 w-7 h-7 rounded-full text-sm font-medium"
                    style={{ color: '#6B7280' }}
                    aria-label="Cerrar">×</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default InstallTip;
