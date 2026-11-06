/**
 * Normaliza una marca de tiempo de la base a ISO con zona explicita.
 *
 * Los dos motores devuelven cosas distintas para la misma columna:
 *
 *   PostgreSQL  -> un Date de JS, que al serializar sale "...Z". Correcto.
 *   SQLite      -> el string crudo "YYYY-MM-DD HH:MM:SS", en UTC pero SIN
 *                  marca de zona. El navegador lo lee como hora LOCAL.
 *
 * En Argentina eso son 3 horas de corrimiento. Medido en la pantalla de
 * puerta: una entrada recien escaneada figuraba usada 3 horas en el FUTURO,
 * y el "hace cuanto" daba -180 minutos.
 *
 * En produccion (Postgres) no pasa, asi que no es un bug que vea el usuario.
 * Pero hace que probar la puerta en desarrollo de resultados falsos, que es
 * casi peor: se persiguen fantasmas o se dan por buenas cosas que no lo son.
 *
 * De paso empareja los dos caminos del mismo endpoint, que devolvian formatos
 * distintos: el escaneo exitoso armaba un ISO a mano y el de "ya fue
 * utilizada" devolvia el string crudo de la base.
 */
function fechaISO(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) return isNaN(valor) ? null : valor.toISOString();

  const s = String(valor);
  // Ya viene con zona (ISO con Z o con +hh:mm): se respeta.
  if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return s;
  // "YYYY-MM-DD HH:MM:SS" o "YYYY-MM-DDTHH:MM:SS" sin zona: es UTC.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  if (m) return `${m[1]}T${m[2]}Z`;
  return s;  // formato inesperado: se devuelve tal cual, mejor que romper
}

module.exports = { fechaISO };
