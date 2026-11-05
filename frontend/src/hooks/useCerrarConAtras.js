import { useEffect, useRef } from 'react';

/**
 * Hace que el boton "atras" del celular cierre un modal, en vez de salir
 * de la pantalla entera.
 *
 * En una app nativa, "atras" con algo abierto encima cierra eso abierto. En
 * una web, se va de la pagina. Ese salto —abris un modal, tocas atras y
 * terminas dos pantallas mas atras, perdiendo lo que estabas cargando— es de
 * los detalles que mas delatan que algo no es una app. En iOS pasa igual con
 * el gesto de deslizar desde el borde.
 *
 * Como funciona: al abrir, empuja una entrada al historial. El "atras"
 * consume esa entrada y dispara popstate, que usamos para cerrar. Si el
 * modal se cierra por otro camino (boton, Escape), sacamos la entrada que
 * habiamos puesto para no dejar basura en el historial.
 *
 * @param {boolean}  abierto  si el modal esta visible
 * @param {Function} cerrar   funcion que lo cierra
 */
export function useCerrarConAtras(abierto, cerrar) {
  // Guardamos la funcion en un ref para no re-suscribir el listener en cada
  // render si el componente la redefine inline.
  const cerrarRef = useRef(cerrar);
  cerrarRef.current = cerrar;

  // Marca si la entrada que se va a consumir la pusimos nosotros.
  const entradaPropia = useRef(false);

  useEffect(() => {
    if (!abierto) return;

    window.history.pushState({ modalPrickets: true }, '');
    entradaPropia.current = true;

    const alVolver = () => {
      // El navegador ya saco nuestra entrada al disparar este evento.
      entradaPropia.current = false;
      cerrarRef.current?.();
    };

    window.addEventListener('popstate', alVolver);

    return () => {
      window.removeEventListener('popstate', alVolver);
      // Cerro por boton o Escape: nuestra entrada sigue en el historial y hay
      // que sacarla, sino el primer "atras" del usuario no hace nada visible.
      if (entradaPropia.current) {
        entradaPropia.current = false;
        window.history.back();
      }
    };
  }, [abierto]);
}

export default useCerrarConAtras;
