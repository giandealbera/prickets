/**
 * Ciclo de vida del evento, en un solo lugar.
 *
 *   DRAFT     — en preparacion. No se vende ni se escanea.
 *   ACTIVE    — en curso: se vende y se escanea.
 *   FINISHED  — termino. Queda como fotografia historica: se consulta todo
 *               (ventas, escaneos, rendiciones, deudas) pero no se opera.
 *   CANCELLED — se dio de baja sin realizarse.
 *
 * Regla de cierre automatico: un evento ACTIVE pasa a FINISHED cuando ya paso
 * su fecha. Es lo unico que decide el sistema solo; el resto son acciones
 * explicitas del dueño. Si mañana se quiere otra regla (por hora de fin, o
 * solo manual), se cambia `yaPaso` y listo.
 */
const db = require('../config/database');

const ESTADOS = ['DRAFT', 'ACTIVE', 'FINISHED', 'CANCELLED'];

// Estados en los que el evento sigue siendo operable (vender, escanear,
// editar). FINISHED y CANCELLED son de solo lectura.
const OPERABLES = ['DRAFT', 'ACTIVE'];

const esEstadoValido = (s) => ESTADOS.includes(s);
const esOperable = (s) => OPERABLES.includes(s || 'ACTIVE');

// Cuantos dias despues de la fecha del evento lo damos por terminado solo.
//
// OJO con bajarlo a 0: una fiesta del 15 que sigue hasta las 6 de la mañana
// del 16 quedaria "finalizada" a las 00:00, EN PLENA ENTRADA DE GENTE, y con
// eso se cortarian las ventas en la puerta. Por eso el cierre automatico es
// deliberadamente tardio: recien al segundo dia. Para cerrarlo antes esta el
// boton de finalizar, que es una decision explicita del dueño.
const DIAS_PARA_CIERRE_AUTOMATICO = 2;

// events.date es TEXT 'YYYY-MM-DD'. Comparamos como texto, que ordena igual
// que la fecha y funciona en SQLite y en Postgres sin castear.
function fechaCorte() {
  const d = new Date();
  d.setDate(d.getDate() - DIAS_PARA_CIERRE_AUTOMATICO);
  return d.toISOString().slice(0, 10);
}

function yaPaso(fechaEvento) {
  if (!fechaEvento) return false;
  return String(fechaEvento).slice(0, 10) < fechaCorte();
}

/**
 * Cierra los eventos ACTIVE cuyo dia ya paso.
 *
 * Se llama al listar eventos en vez de con una tarea programada: el sistema
 * no tiene scheduler y agregarlo por esto seria mucho aparato. El costo es un
 * UPDATE que, pasado el primer listado del dia, no afecta ninguna fila.
 *
 * Devuelve cuantos cerro.
 */
async function cerrarEventosVencidos() {
  try {
    const r = await db.query(
      `UPDATE events
          SET status = 'FINISHED', finished_at = CURRENT_TIMESTAMP
        WHERE status = 'ACTIVE' AND date < ?`,
      [fechaCorte()]
    );
    return r.affectedRows || 0;
  } catch (err) {
    // Que falle el cierre automatico no puede romper el listado.
    console.error('cerrarEventosVencidos error:', err.message);
    return 0;
  }
}

/**
 * Estado a mostrar para un evento. Si esta ACTIVE pero su fecha ya paso, se
 * informa como FINISHED aunque el UPDATE todavia no haya corrido, para que la
 * pantalla nunca muestre como "en curso" algo de la semana pasada.
 */
function estadoEfectivo(evento) {
  const s = evento?.status || 'ACTIVE';
  if (s === 'ACTIVE' && yaPaso(evento?.date)) return 'FINISHED';
  return s;
}

/**
 * Chequeo de "¿este evento acepta operaciones?" para los caminos que NO pasan
 * por checkSaleWindow. El principal son las cortesias: saltean la ventana de
 * venta a proposito (el dueño puede regalar entradas fuera de horario), pero
 * un evento ya cerrado no puede recibir entradas nuevas — dejaria de ser la
 * fotografia de lo que paso.
 *
 * Devuelve { ok: true, evento } o { ok: false, status, message }.
 */
async function eventoOperable(eventId) {
  const r = await db.query('SELECT id, name, date, status FROM events WHERE id = ?', [eventId]);
  const ev = r.rows[0];
  if (!ev) return { ok: false, status: 404, message: 'Evento no encontrado' };
  const estado = estadoEfectivo(ev);
  if (estado === 'FINISHED')
    return { ok: false, status: 409, message: 'El evento ya finalizó: no se pueden emitir más entradas' };
  if (estado === 'CANCELLED')
    return { ok: false, status: 409, message: 'El evento fue cancelado' };
  return { ok: true, evento: ev };
}

module.exports = {
  ESTADOS,
  fechaCorte,
  eventoOperable,
  OPERABLES,
  esEstadoValido,
  esOperable,
  yaPaso,
  cerrarEventosVencidos,
  estadoEfectivo,
};
