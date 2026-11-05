import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Gestion de scroll en SPA. Comportamiento "como app nativa":
//
//   - Navegacion adelante (PUSH/REPLACE): scroll arranca en 0. La lista de
//     /eventos no debe abrir con scroll en el medio porque venis de un
//     detalle.
//   - Navegacion atras (POP, "back" del browser/gesture iOS): restaura el
//     scroll que tenia esa ruta cuando te fuiste. Antes la lista de tickets
//     vendidos te tiraba al top y perdias el lugar.
//
// El "back" del browser ya hace algo de esto solo en MPA; en SPA con
// `BrowserRouter` no, hay que hacerlo a mano. sessionStorage sobrevive a
// recargas del tab; se limpia al cerrar la pestaña.

const KEY = 'prickets:scroll';

const readMap = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return {}; }
};
const writeMap = (m) => {
  try { sessionStorage.setItem(KEY, JSON.stringify(m)); } catch { /* quota */ }
};

const ScrollManager = () => {
  const location = useLocation();
  const navType  = useNavigationType();         // 'PUSH' | 'REPLACE' | 'POP'
  const lastPath = useRef(location.pathname);

  // Guarda el scroll de la ruta saliente cada vez que cambia el pathname.
  useEffect(() => {
    const path = location.pathname;
    return () => {
      const m = readMap();
      m[lastPath.current] = window.scrollY;
      writeMap(m);
      lastPath.current = path;
    };
  }, [location.pathname]);

  // Aplica el scroll de entrada en la ruta nueva.
  useEffect(() => {
    if (navType === 'POP') {
      const m = readMap();
      const y = m[location.pathname];
      if (typeof y === 'number') {
        // requestAnimationFrame asegura que el DOM nuevo ya esta montado
        // (sino scrolleamos en el viewport viejo).
        requestAnimationFrame(() => window.scrollTo(0, y));
        return;
      }
    }
    // PUSH/REPLACE o POP sin memoria → arrancar arriba.
    window.scrollTo(0, 0);
  }, [location.pathname, navType]);

  return null;
};

export default ScrollManager;
