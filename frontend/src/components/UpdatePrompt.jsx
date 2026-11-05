import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

// Cada cuanto le preguntamos al servidor si hay un deploy nuevo. Un tablero
// abierto toda la noche nunca navega, asi que sin esto no se entera hasta que
// alguien recarga a mano.
const REVISAR_CADA_MS = 60 * 1000;

/**
 * Aviso de version nueva.
 *
 * La app es una PWA: guarda sus archivos en el telefono para andar sin señal.
 * Antes la actualizacion se aplicaba sola pero sin avisar, y la pantalla
 * abierta seguia con el codigo viejo. Eso hizo que persiguieramos varias
 * veces bugs que ya estaban arreglados, sin manera de saber que version
 * estaba corriendo el celular.
 *
 * Ahora: cuando hay una version nueva aparece esta barra y se aplica al
 * tocarla. No bloquea la pantalla — un portero puede seguir escaneando y
 * actualizar cuando le quede comodo.
 */
const UpdatePrompt = () => {
  const [hayNueva,  setHayNueva]  = useState(false);
  const [aplicando, setAplicando] = useState(false);
  // registerSW devuelve la funcion que aplica la actualizacion. La guardamos
  // envuelta porque useState interpreta una funcion como actualizador.
  const [aplicar, setAplicar] = useState(null);

  useEffect(() => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() { setHayNueva(true); },
      onRegisteredSW(_url, registro) {
        if (!registro) return;
        setInterval(() => { registro.update().catch(() => { /* sin red */ }); }, REVISAR_CADA_MS);
      },
    });
    setAplicar(() => updateSW);
  }, []);

  if (!hayNueva) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 z-50 px-4 pointer-events-none"
      // Arriba del BottomNav en mobile, con respeto por la safe-area.
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)' }}
    >
      <div
        className="mx-auto max-w-md rounded-xl px-4 py-3 flex items-center gap-3 pointer-events-auto"
        style={{ background: '#202422', border: '1px solid #3A443C', boxShadow: '0 8px 30px rgba(0,0,0,0.45)' }}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: '#E1E5E2' }}>
            Hay una versión nueva
          </p>
          <p className="text-xs" style={{ color: '#8C948D' }}>
            Actualizá para tener los últimos cambios.
          </p>
        </div>
        <button
          type="button"
          disabled={aplicando}
          onClick={async () => {
            setAplicando(true);

            // El plan B de abajo recargaba SIEMPRE a los 1,5s, y esa recarga
            // le pisaba el handshake al service worker: la pagina volvia a
            // cargar desde la cache vieja, el worker nuevo seguia en espera y
            // el cartel reaparecia. Tocar "Actualizar" no actualizaba nunca.
            // Verificado en produccion: habia un worker instalado en estado
            // "waiting" y mandarle SKIP_WAITING a mano si actualizaba.
            //
            // Ahora el plan B solo corre si el camino normal no llego a
            // ningun lado, y le damos tiempo de sobra.
            let tomoElControl = false;
            const marcar = () => { tomoElControl = true; };
            navigator.serviceWorker?.addEventListener?.('controllerchange', marcar);

            // Camino normal: le avisa al worker en espera que tome el control.
            // Cuando lo toma, la pagina se recarga sola.
            try { await aplicar?.(true); } catch { /* seguimos al plan B */ }

            // Plan B: no habia worker en espera, o la pestaña todavia no esta
            // bajo el control de ninguno (pasa en la primera visita). Ahi el
            // aviso no le llega a nadie y el boton quedaria colgado en
            // "Actualizando...". Lo que importa es que el usuario termine en
            // la version nueva, no el mecanismo.
            setTimeout(() => {
              if (!tomoElControl) window.location.reload();
            }, 6000);
          }}
          className="shrink-0 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
          style={{ background: '#5C6E5D', color: '#F1F4F2', border: '1px solid #6E826F' }}
        >
          {aplicando ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>
    </div>
  );
};

export default UpdatePrompt;
