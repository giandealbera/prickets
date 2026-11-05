const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { puedeEmitirTipo } = require('../utils/nivelTipoEntrada');
const { nuevoCodigoQR } = require('../utils/qrCode');
const { checkSaleWindow } = require('../utils/saleWindow');
const { eventoOperable, cerrarEventosVencidos, fechaCorte } = require('../utils/eventStatus');
const { suscribir } = require('./newsletterController');
const { sendPush } = require('./pushController');
const { normalizeCity } = require('../utils/normalize');
const AR_CITIES = require('../data/argentine-cities');

// Notifica push a los dueños cuando una tanda cruza el 90% o se agota.
// Se llama post-commit; si VAPID no esta configurado, es no-op.
async function maybeNotifyQuota({ oldSold, newSold, totalQuota, ttName, eventId }) {
  try {
    const oldRatio = oldSold / totalQuota;
    const newRatio = newSold / totalQuota;
    const crossed90      = oldRatio < 0.9 && newRatio >= 0.9;
    const crossedSoldOut = oldRatio < 1   && newRatio >= 1;
    if (!crossed90 && !crossedSoldOut) return;
    const ev = (await db.query('SELECT name FROM events WHERE id = ?', [eventId])).rows[0];
    const owners = await db.query('SELECT user_id FROM event_owners WHERE event_id = ?', [eventId]);
    const payload = crossedSoldOut
      ? { title: 'Sold out', body: `Se agotó "${ttName}" en ${ev?.name || 'tu evento'}.`, url: `/evento/${eventId}` }
      : { title: 'Cupo bajo', body: `"${ttName}" llegó al 90% en ${ev?.name || 'tu evento'}.`, url: `/evento/${eventId}` };
    for (const o of owners.rows) sendPush(o.user_id, payload).catch(() => {});
  } catch { /* silencioso */ }
}

// Catalogo publico: lo que ve alguien que entra a comprar sin link de nadie.
//
// Filtraba solo por is_active, asi que mostraba TODO lo que alguna vez se
// creo. En produccion eso eran 20 eventos, 19 ya pasados y la mayoria basura
// de pruebas ("Fiesta Test Auditoria E2E" y companhia). El comprador abria la
// pagina y tenia que adivinar cual era la fiesta de verdad.
//
// Ahora sale lo mismo que considera vendible el resto del sistema: evento
// ACTIVE y fecha que no haya pasado mas alla de los dias de gracia (una
// fiesta del 15 sigue hasta las 6 AM del 16; ver eventStatus.js). El filtro
// por fecha ademas cubre el caso de que el cierre automatico todavia no haya
// corrido.
const getPublicEvents = async (req, res) => {
  try {
    // Pone al dia los que vencieron antes de leer.
    await cerrarEventosVencidos();
    const corte = fechaCorte();

    // Antes: N+1 — 1 query para eventos + 1 query por evento para ticket_types.
    // Ahora: 2 queries totales, agrupadas en JS. Mucho más rápido con muchos eventos.
    const [evResult, ttResult] = await Promise.all([
      db.query(
        `SELECT e.id, e.name, e.date, e.start_time
         FROM events e
         WHERE e.is_active = 1 AND e.status = 'ACTIVE' AND e.date >= ?
         ORDER BY e.date ASC`,
        [corte]
      ),
      db.query(
        `SELECT tt.id, tt.event_id, tt.name, tt.price,
                (tt.total_quota - tt.sold_count) AS available
         FROM ticket_types tt
         JOIN events e ON e.id = tt.event_id
         WHERE tt.is_active = 1 AND e.is_active = 1
           AND e.status = 'ACTIVE' AND e.date >= ?
           AND (tt.total_quota - tt.sold_count) > 0
         ORDER BY tt.price ASC`,
        [corte]
      ),
    ]);

    // Agrupar tipos por evento
    const ttByEvent = {};
    for (const tt of ttResult.rows) {
      if (!ttByEvent[tt.event_id]) ttByEvent[tt.event_id] = [];
      const { event_id, ...rest } = tt;
      ttByEvent[tt.event_id].push(rest);
    }

    const events = evResult.rows
      .filter(ev => ttByEvent[ev.id])
      .map(ev => ({ ...ev, ticket_types: ttByEvent[ev.id] }));

    res.json(events);
  } catch (err) {
    console.error('getPublicEvents error:', err.message);
    res.status(500).json({ error: 'Error al obtener eventos' });
  }
};

const getPromoterInfo = async (req, res) => {
  const { code } = req.params;
  try {
    const result = await db.query(
      `SELECT u.name, u.apellido, p.promo_code
       FROM promotors p
       JOIN users u ON u.id = p.user_id
       WHERE UPPER(p.promo_code) = UPPER(?) AND u.is_active = 1`,
      [code]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Link invalido' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
};

const createPublicTicket = async (req, res) => {
  // Normalizo el code a uppercase asi /comprar/CASA y /comprar/casa son
  // el mismo flow. Los promo codes son uppercase por convencion.
  const code = (req.params.code || '').toUpperCase();
  const { event_id, ticket_type_id, payment_method, attendees, cortesia } = req.body;
  // Cortesia solo se honra para el codigo CASA (interno del dueno)
  const isCortesia = cortesia === true && code === 'CASA';

  if (!event_id || !ticket_type_id)
    return res.status(400).json({ error: 'Faltan datos del evento' });

  // Cortesia (codigo CASA) queda exenta — el admin puede regalar entradas despues
  // de cerrada la venta. El resto se bloquea fuera de la ventana.
  // Lo que ninguna de las dos puede saltearse es el estado del evento: uno
  // finalizado o cancelado no recibe entradas nuevas.
  if (!isCortesia) {
    const window = await checkSaleWindow(event_id);
    if (!window.ok) return res.status(window.status).json({ error: window.message });
  } else {
    const estado = await eventoOperable(event_id);
    if (!estado.ok) return res.status(estado.status).json({ error: estado.message });
  }

  if (!Array.isArray(attendees) || attendees.length === 0)
    return res.status(400).json({ error: 'Cargá al menos una persona' });

  if (attendees.length > 10)
    return res.status(400).json({ error: 'Maximo 10 entradas por link' });

  // Validar nombre + apellido + DNI en cada attendee.
  // El chequeo de que `a` sea un objeto NO es de adorno: con attendees:[null]
  // esta linea tiraba TypeError, y como el handler es async la excepcion subia
  // como unhandledRejection y Node MATABA el proceso. Un solo pedido publico
  // dejaba sin sistema a todos: porteros sin escanear, compradores sin comprar.
  for (const a of attendees) {
    if (!a || typeof a !== 'object')
      return res.status(400).json({ error: 'Datos de persona inválidos' });
    if (!a.buyer_name || !a.buyer_apellido || !a.buyer_dni)
      return res.status(400).json({ error: 'Cada persona debe tener nombre, apellido y DNI' });
    if (String(a.buyer_name).length > 50 || String(a.buyer_apellido).length > 50)
      return res.status(400).json({ error: 'El nombre y apellido no deben superar los 50 caracteres' });
  }

  try {
    // Verificar que el promotor existe Y su usuario asociado está activo.
    // Sin el join a users un promotor desactivado seguía pudiendo vender por su link.
    const promoResult = await db.query(
      // u.role: hace falta para saber si ESE vendedor alcanza el nivel
      // minimo del tipo de entrada que se quiere comprar por su link.
      `SELECT p.id, p.user_id, u.role FROM promotors p
       JOIN users u ON u.id = p.user_id
       WHERE UPPER(p.promo_code) = UPPER(?) AND u.is_active = 1`,
      [code]
    );
    const promotor = promoResult.rows[0];
    if (!promotor) return res.status(404).json({ error: 'Link invalido' });

    // Permisos por tipo: si el ticket_type tiene una lista de sellers
    // autorizados y el promotor.user_id NO esta en ella, rechazamos.
    // Lista vacia = abierto a todos. CASA bypasea (admin vende cualquier
    // cosa). Esto cierra que un vendedor copie el promo_code de otro y
    // venda tipos para los que no estaba autorizado.
    if (code !== 'CASA') {
      // El que vende es el promotor del link, no quien hace el request (que
      // es un comprador anonimo). Por eso le pasamos SU rol y SU id.
      const permiso = await puedeEmitirTipo(
        { id: promotor.user_id, role: promotor.role },
        ticket_type_id,
        promotor.user_id
      );
      if (!permiso.ok) return res.status(403).json({ error: permiso.error });
    }

    const validMethod = isCortesia
      ? 'cortesia'
      : (['efectivo', 'transferencia'].includes(payment_method) ? payment_method : 'efectivo');
    const created = [];
    let finalPrice;
    let ttName;
    let ttSnapshot = null; // datos del tt para push post-commit

    // Toda la creacion va en una transaccion: revalidamos cupo DENTRO, insertamos
    // los tickets, y subimos sold_count atomicamente. Asi evitamos oversell con
    // requests concurrentes.
    await db.transaction(async (conn) => {
      const [ttRows] = await conn.execute(
        'SELECT * FROM ticket_types WHERE id = ? AND event_id = ? AND is_active = 1 FOR UPDATE',
        [ticket_type_id, event_id]
      );
      const tt = ttRows[0];
      if (!tt) throw new Error('TT_NOT_FOUND');
      if ((tt.total_quota - tt.sold_count) < attendees.length) {
        throw new Error(`NO_QUOTA:${tt.total_quota - tt.sold_count}`);
      }
      finalPrice = isCortesia ? 0 : tt.price;
      ttName = tt.name;

      for (const a of attendees) {
        const ticketId = uuidv4();
        const qrCode   = nuevoCodigoQR();
        await conn.execute(
          `INSERT INTO tickets
             (id, ticket_type_id, event_id, buyer_name, buyer_apellido, buyer_dni, buyer_edad, buyer_localidad, buyer_email,
              qr_code, payment_method, payment_ref, amount_paid, status, promotor_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ticketId, ticket_type_id, event_id, a.buyer_name, a.buyer_apellido, a.buyer_dni || null,
           a.buyer_edad || null, normalizeCity(a.buyer_localidad) || null, a.buyer_email || '',
           qrCode, validMethod, null, finalPrice, 'pagado', promotor.id]
        );
        created.push({
          id: ticketId, qr_code: qrCode,
          buyer_name: a.buyer_name, buyer_apellido: a.buyer_apellido,
          tipo_entrada: tt.name, amount_paid: finalPrice,
        });
      }

      await conn.execute(
        'UPDATE ticket_types SET sold_count = sold_count + ? WHERE id = ?',
        [attendees.length, ticket_type_id]
      );

      ttSnapshot = {
        oldSold:    tt.sold_count,
        newSold:    tt.sold_count + attendees.length,
        totalQuota: tt.total_quota,
        ttName:     tt.name,
        eventId:    event_id,
      };
    });

    res.status(201).json({
      tickets: created,
      total: created.length * parseFloat(finalPrice),
      payment_method: validMethod,
      cortesia: isCortesia,
    });

    // Newsletter: SOLO quien marco la casilla. Va despues de responder y sin
    // await por ticket, para no demorar la compra ni hacerla fallar si la
    // suscripcion se cae.
    for (const a of attendees) {
      if (a.acepta_descuentos && a.buyer_email) {
        suscribir({ email: a.buyer_email, nombre: a.buyer_name,
                    apellido: a.buyer_apellido, eventId: event_id }).catch(() => {});
      }
    }

    if (ttSnapshot) maybeNotifyQuota(ttSnapshot);
  } catch (err) {
    if (err.message === 'TT_NOT_FOUND')
      return res.status(400).json({ error: 'Tipo de entrada no disponible' });
    if (err.message?.startsWith('NO_QUOTA:'))
      return res.status(409).json({ error: `Solo quedan ${err.message.split(':')[1]} entradas disponibles` });
    console.error('createPublicTicket error:', err.message);
    res.status(500).json({ error: 'Error al crear entradas' });
  }
};

// GET /api/public/tickets-info?ids=ID1,ID2
// Devuelve info para que el comprador vea evento/tipo/cantidad cuando llega
// por un link de "pre-venta" (/comprar/CASA?tickets=...). Sin datos sensibles.
const getReservedTickets = async (req, res) => {
  const idsParam = (req.query.ids || '').toString().trim();
  if (!idsParam) return res.status(400).json({ error: 'ids requerido' });

  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0 || ids.length > 10)
    return res.status(400).json({ error: 'Cantidad de ids invalida' });

  try {
    const placeholders = ids.map(() => '?').join(',');
    const result = await db.query(
      `SELECT t.id, t.payment_method, t.payment_ref, t.event_id, t.ticket_type_id,
              t.buyer_name, t.buyer_apellido,
              tt.name AS tipo_entrada, tt.price,
              e.name AS evento_name, e.date AS evento_date
         FROM tickets t
         JOIN ticket_types tt ON tt.id = t.ticket_type_id
         JOIN events e ON e.id = t.event_id
        WHERE t.id IN (${placeholders})`,
      ids
    );

    const rows = result.rows || [];
    if (rows.length === 0) return res.status(404).json({ error: 'No se encontraron entradas' });

    // Validacion estricta: necesitamos TODOS los ids que pidio el cliente.
    // Antes solo chequeaba que rows fuese >0, asi 1 de 3 ids validos pasaba.
    if (rows.length !== ids.length)
      return res.status(404).json({ error: 'No se encontraron todas las entradas' });

    // Todos deben ser del mismo evento+tipo. Si payment_ref != 'RESERVADO'
    // es porque el comprador ya cargo sus datos: devolvemos un error
    // distinguible para que el front pueda ofrecer "recuperar QR".
    const sameEvent = rows.every(r =>
      r.event_id === rows[0].event_id &&
      r.ticket_type_id === rows[0].ticket_type_id
    );
    if (!sameEvent) return res.status(409).json({ error: 'Link invalido' });

    const alreadyCompleted = rows.every(r => r.payment_ref !== 'RESERVADO');
    if (alreadyCompleted) {
      return res.json({
        status: 'completed',
        event_id: rows[0].event_id,
        tickets: rows.map(r => ({
          id: r.id,
          qr_code: r.qr_code,
          buyer_name: r.buyer_name,
          buyer_apellido: r.buyer_apellido,
          amount_paid: r.amount_paid,
          payment_method: r.payment_method,
          tipo_entrada: r.tipo_entrada,
          evento: rows[0].evento_name,
          event_date: rows[0].evento_date,
        })),
      });
    }

    // Estado mixto (algunos cargados, otros no): NO es error. Pasa cuando el
    // comprador carga 1 de 5, refresca / cierra el tab / vuelve al dia
    // siguiente. Antes devolviamos 409 y el comprador quedaba bloqueado.
    // Ahora devolvemos SOLO los pendientes y el frontend retoma desde ahi.
    const pending = rows.filter(r => r.payment_ref === 'RESERVADO');
    const completedCount = rows.length - pending.length;

    res.json({
      event_id: rows[0].event_id,
      event_name: rows[0].evento_name,
      event_date: rows[0].evento_date,
      ticket_type_id: rows[0].ticket_type_id,
      ticket_type_name: rows[0].tipo_entrada,
      price: rows[0].price,
      payment_method: rows[0].payment_method,
      cortesia: rows[0].payment_method === 'cortesia',
      // Solo IDs pendientes — el frontend usa esto como la lista a cargar.
      ticket_ids: pending.map(r => r.id),
      // Cuantos ya estaban cargados antes de abrir el link esta vez.
      completed_count: completedCount,
      // Total original (pendientes + completados) — util para mostrar
      // "Continuando desde la persona 3 de 5".
      total_count: rows.length,
    });
  } catch (err) {
    console.error('getReservedTickets error:', err.message);
    res.status(500).json({ error: 'Error al consultar entradas' });
  }
};

// POST /api/public/tickets-complete/:code
// El comprador completa nombre/apellido en cada entrada reservada.
// Devuelve los QRs igual que createPublicTicket.
const completeReservedTickets = async (req, res) => {
  // Normalizo: /comprar/CASA == /comprar/casa.
  const code = (req.params.code || '').toUpperCase();
  const { ticket_ids, attendees } = req.body;

  if (!Array.isArray(ticket_ids) || ticket_ids.length === 0)
    return res.status(400).json({ error: 'ticket_ids requerido' });
  if (!Array.isArray(attendees) || attendees.length !== ticket_ids.length)
    return res.status(400).json({ error: 'attendees debe coincidir con ticket_ids' });

  // Mismo cuidado que en createPublicTicket: un elemento nulo aca tiraba
  // TypeError y, por ser handler async, se llevaba puesto el proceso entero.
  for (const a of attendees) {
    if (!a || typeof a !== 'object')
      return res.status(400).json({ error: 'Datos de persona inválidos' });
    if (!a.buyer_name || !a.buyer_apellido || !a.buyer_dni)
      return res.status(400).json({ error: 'Cada persona debe tener nombre, apellido y DNI' });
    if (String(a.buyer_name).length > 50 || String(a.buyer_apellido).length > 50)
      return res.status(400).json({ error: 'El nombre y apellido no deben superar los 50 caracteres' });
  }

  try {
    const placeholders = ticket_ids.map(() => '?').join(',');
    const result = await db.query(
      `SELECT t.id, t.payment_ref, t.event_id, t.ticket_type_id, t.qr_code,
              t.amount_paid, t.payment_method,
              tt.name AS tipo_entrada
         FROM tickets t
         JOIN ticket_types tt ON tt.id = t.ticket_type_id
         WHERE t.id IN (${placeholders})`,
      ticket_ids
    );
    const rows = result.rows || [];
    if (rows.length !== ticket_ids.length)
      return res.status(404).json({ error: 'Entradas no encontradas' });
    if (rows.some(r => r.payment_ref !== 'RESERVADO'))
      return res.status(409).json({ error: 'Estas entradas ya estan completas' });

    // Para CASA no requerimos validar promotor (admin generó la reserva).
    if (code !== 'CASA') {
      const promo = await db.query(
        `SELECT p.id FROM promotors p
          JOIN users u ON u.id = p.user_id
         WHERE UPPER(p.promo_code) = UPPER(?) AND u.is_active = 1`,
        [code]
      );
      if (!promo.rows[0]) return res.status(404).json({ error: 'Link invalido' });
    }

    const created = [];
    await db.transaction(async (conn) => {
      for (let i = 0; i < ticket_ids.length; i++) {
        const tid = ticket_ids[i];
        const a = attendees[i];
        await conn.execute(
          `UPDATE tickets
              SET buyer_name = ?, buyer_apellido = ?, buyer_dni = ?,
                  buyer_edad = ?, buyer_localidad = ?, buyer_email = ?,
                  payment_ref = ''
            WHERE id = ? AND payment_ref = 'RESERVADO'`,
          [a.buyer_name, a.buyer_apellido, a.buyer_dni || null,
           a.buyer_edad || null, normalizeCity(a.buyer_localidad) || null, a.buyer_email || '',
           tid]
        );
        const row = rows.find(r => r.id === tid);
        created.push({
          id: tid, qr_code: row.qr_code,
          buyer_name: a.buyer_name, buyer_apellido: a.buyer_apellido,
          amount_paid: row.amount_paid,
          payment_method: row.payment_method,
          tipo_entrada: row.tipo_entrada,
        });
      }
    });

    res.status(200).json({ tickets: created });

    // Newsletter: igual que en la compra directa, solo quien marco la casilla.
    const eventoDeLaReserva = rows[0]?.event_id;
    for (const a of attendees) {
      if (a.acepta_descuentos && a.buyer_email) {
        suscribir({ email: a.buyer_email, nombre: a.buyer_name,
                    apellido: a.buyer_apellido, eventId: eventoDeLaReserva }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('completeReservedTickets error:', err.message);
    res.status(500).json({ error: 'Error al completar entradas' });
  }
};

// POST /api/public/recover/:code — comprador busca sus tickets por nombre + apellido + DNI
const recoverTickets = async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const { nombre, apellido, dni } = req.body;

  if (!nombre || !apellido || !dni)
    return res.status(400).json({ error: 'Cargá tu nombre, apellido y DNI para recuperar tus entradas' });

  const cleanDni = String(dni || '').replace(/\D/g, '');
  if (!cleanDni || cleanDni.length < 6)
    return res.status(400).json({ error: 'Ingresá un DNI válido (mínimo 6 dígitos)' });

  try {
    let promotorWhere;
    let params;
    if (code === 'CASA') {
      const casa = await db.query("SELECT id FROM promotors WHERE promo_code = 'CASA'");
      const casaId = casa.rows[0]?.id || null;
      promotorWhere = casaId
        ? '(t.promotor_id IS NULL OR t.promotor_id = ?)'
        : 't.promotor_id IS NULL';
      params = casaId ? [casaId, nombre, apellido, cleanDni] : [nombre, apellido, cleanDni];
    } else {
      const promo = await db.query('SELECT id FROM promotors WHERE UPPER(promo_code) = UPPER(?)', [code]);
      if (!promo.rows[0]) return res.status(404).json({ error: 'Link invalido' });
      promotorWhere = 't.promotor_id = ?';
      params = [promo.rows[0].id, nombre, apellido, cleanDni];
    }

    const result = await db.query(
      `SELECT t.id, t.qr_code, t.buyer_name, t.buyer_apellido, t.buyer_dni, t.amount_paid, t.created_at, t.status,
              tt.name AS tipo_entrada, e.name AS evento, e.date AS event_date
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       WHERE ${promotorWhere}
         AND LOWER(TRIM(t.buyer_name))     = LOWER(TRIM(?))
         AND LOWER(TRIM(t.buyer_apellido)) = LOWER(TRIM(?))
         AND (
              REPLACE(REPLACE(COALESCE(t.buyer_dni, ''), '.', ''), ' ', '') = ?
              -- Entradas sin DNI (las emitidas antes de que fuera obligatorio):
              -- se siguen pudiendo recuperar con nombre + apellido para no
              -- dejar afuera a quien ya habia comprado. Las CORTESIAS quedan
              -- excluidas de esa excepcion a proposito: se emiten sin DNI y el
              -- organizador manda el QR directo, asi que con la excepcion
              -- puesta bastaba con saber el nombre del invitado para bajarse
              -- su QR. Si una cortesia tiene DNI cargado, se recupera con el.
              OR (COALESCE(t.buyer_dni, '') = '' AND COALESCE(t.payment_method, '') != 'cortesia')
             )
         AND t.status IN ('pagado','usado')
       ORDER BY t.created_at DESC
       LIMIT 20`,
      params
    );

    res.json({ tickets: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al recuperar entradas' });
  }
};

// GET /api/public/localidades?q=fir — autocomplete de ciudades para el
// formulario de carga del comprador.
//
// Combina 2 fuentes:
//   1) Ciudades YA cargadas en la BD (de tickets previos) — saltan arriba
//      ordenadas por cantidad (las mas usadas primero).
//   2) Catalogo estatico AR_CITIES (~200 ciudades argentinas con
//      provincia) — como red de seguridad para que el primer comprador
//      tambien vea sugerencias.
//
// Devuelve hasta 8 items: { value, label }
//   value = "Firmat, Santa Fe" — lo que se va a guardar en buyer_localidad
//   label = igual al value (la UI muestra value).
//
// Si una ciudad de tickets matchea con una del seed, se prioriza la del
// seed para tener la provincia.
//
// Es publico — sin auth — porque lo consume PublicBuy (link de comprador).
// No expone PII: solo nombres de ciudades agregados.
const getLocalidadesSuggestions = async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ items: [] });
  try {
    // 1) Dinamicas: ciudades de tickets ya cargados que matcheen.
    const r = await db.query(
      `SELECT MIN(buyer_localidad) AS city, COUNT(*) AS n
         FROM tickets
        WHERE buyer_localidad IS NOT NULL
          AND TRIM(buyer_localidad) != ''
          AND LOWER(buyer_localidad) LIKE LOWER(?)
        GROUP BY LOWER(TRIM(buyer_localidad))
        ORDER BY n DESC
        LIMIT 12`,
      [`${q}%`]
    );
    const dynamic = (r.rows || [])
      .map(row => (row.city || '').trim())
      .filter(Boolean);

    // 2) Estaticas del catalogo: prefix-match case-insensitive en ciudad
    // o provincia (asi "san" matchea "San Juan" y "Salta", "santa" matchea
    // "Santa Fe", etc).
    const qLower = q.toLowerCase();
    const staticMatches = AR_CITIES.filter(c =>
      c.city.toLowerCase().startsWith(qLower) ||
      c.province.toLowerCase().startsWith(qLower)
    );

    // Merge sin duplicados. La clave de deduplicacion es LOWER(city) —
    // asi "Firmat" del seed pisa a "FIRMAT" dinamico (preservamos la
    // provincia del seed). Mantenemos el orden: primero dinamicas (mas
    // relevantes para el evento), despues estaticas.
    const seen = new Set();
    const items = [];

    // Dinamicas primero — si encuentra la ciudad en el seed, le toma la
    // provincia; sino, la deja sin provincia (data vieja puede no tenerla).
    for (const cityName of dynamic) {
      const key = cityName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const found = AR_CITIES.find(c => c.city.toLowerCase() === key);
      const normalizedCity = normalizeCity(cityName);
      const province = found?.province || null;
      const label = province ? `${normalizedCity}, ${province}` : normalizedCity;
      items.push({ value: label, label });
      if (items.length >= 8) break;
    }
    // Estaticas para completar hasta 8.
    for (const c of staticMatches) {
      const key = c.city.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const label = `${c.city}, ${c.province}`;
      items.push({ value: label, label });
      if (items.length >= 8) break;
    }

    res.json({ items });
  } catch (err) {
    console.error('getLocalidadesSuggestions error:', err.message);
    res.json({ items: [] });
  }
};

module.exports = {
  getPublicEvents,
  getPromoterInfo,
  createPublicTicket,
  recoverTickets,
  getReservedTickets,
  completeReservedTickets,
  getLocalidadesSuggestions,
};
