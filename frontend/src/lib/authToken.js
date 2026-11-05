/**
 * Donde se guarda el token de sesion.
 *
 * La clave paso de 'gianqr_token' a 'prickets_token' con el cambio de nombre.
 * Cambiarla a secas habria deslogueado de golpe a todo el que tuviera sesion
 * abierta —vendedores y porteros incluidos, en plena venta—, porque el token
 * vive en el navegador de cada uno. Por eso, la primera vez que se lee con la
 * clave nueva vacia, se rescata lo que haya en la vieja.
 *
 * El rescate se puede borrar cuando ya no queden sesiones de antes del cambio:
 * duran 30 dias como maximo (JWT_EXPIRES_IN_REMEMBER), asi que pasado ese
 * plazo desde el deploy esto es codigo muerto.
 *
 * Todo va envuelto en try/catch: en una ventana privada o con el storage
 * bloqueado, localStorage tira excepcion. Preferimos que la app muestre el
 * login a que quede en blanco.
 */
const CLAVE       = 'prickets_token';
const CLAVE_VIEJA = 'gianqr_token';

export function getToken() {
  try {
    const actual = localStorage.getItem(CLAVE);
    if (actual) return actual;

    const viejo = localStorage.getItem(CLAVE_VIEJA);
    if (viejo) {
      localStorage.setItem(CLAVE, viejo);
      localStorage.removeItem(CLAVE_VIEJA);
      return viejo;
    }
    return null;
  } catch {
    return null;
  }
}

export function setToken(token) {
  try { localStorage.setItem(CLAVE, token); } catch { /* storage bloqueado */ }
}

export function clearToken() {
  try {
    localStorage.removeItem(CLAVE);
    localStorage.removeItem(CLAVE_VIEJA);
  } catch { /* storage bloqueado */ }
}
