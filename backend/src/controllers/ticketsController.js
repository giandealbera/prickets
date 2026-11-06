const { v4: uuidv4 } = require('uuid');
const { nuevoCodigoQR } = require('../utils/qrCode');
const QRCode = require('qrcode');
const db = require('../config/database');
const { fechaISO } = require('../utils/fechas');
const { checkSaleWindow } = require('../utils/saleWindow');
const { eventoOperable } = require('../utils/eventStatus');
const { userCanAccessEvent } = require('../utils/scope');
const { puedeEmitirTipo } = require('../utils/nivelTipoEntrada');
const { normalizeCity } = require('../utils/normalize');
const { logAudit } = require('../utils/auditLog');
const { sendPush } = require('./pushController');

async function generateQR(ticketId) {
  const code    = nuevoCodigoQR();
  const qrData  = JSON.stringify({ code, ticket_id: ticketId });
  const qrBase64 = await QRCode.toDataURL(qrData, { width: 300 });
  return { code, qrBase64 };
}

// POST /api/tickets — venta manual
const create = async (req, res) => {
  const {
    event_id, ticket_type_id,
    buyer_name, buyer_apellido, buyer_dni, buyer_email, buyer_edad, buyer_localidad,
    payment_method, payment_ref, amount_paid,
    promotor_code,
  } = req.body;

  if (!event_id || !ticket_type_id || !buyer_name || !payment_method)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });

  if (buyer_name.length > 50 || (buyer_apellido && buyer_apellido.length > 50))
    return res.status(400).json({ error: 'El nombre y apellido no deben superar los 50 caracteres' });

  // Whitelist estricto. 'cortesia' tiene su propio endpoint admin-only
  // (POST /api/cortesias) — no se acepta por aca para evitar que cualquier
  // vendedor emita entradas gratis sin pasar por el flujo admin.
  const VALID_METHODS = ['efectivo', 'transferencia', 'mercadopago'];
  if (!VALID_METHODS.includes(payment_method))
    return res.status(400).json({ error: 'Método de pago inválido' });

  // payment_ref='RESERVADO' es un sentinel interno usado por pre-sell.
  // No permitir que se envie desde una venta manual normal: el cliente
  // podria confundir las reservas con tickets ya completos.
  if (payment_ref && payment_ref.toString().toUpperCase() === 'RESERVADO')
    return res.status(400).json({ error: 'payment_ref inválido' });

  // Acceso al evento. Faltaba: este endpoint tomaba el event_id del body y no
  // comprobaba nada, asi que un vendedor del dueño A podia vender entradas en
  // el evento del dueño B mandando su id a mano. Verificado antes del
  // arreglo: devolvia 201 y la venta quedaba contada en el evento ajeno.
  if (!await userCanAccessEvent(req.user, event_id))
    return res.status(403).json({ error: 'Sin acceso a este evento' });

  const window = await checkSaleWindow(event_id);
  if (!window.ok) return res.status(window.status).json({ error: window.message });

  // Nivel y lista de habilitados del tipo de entrada. Este camino NO lo
  // chequeaba: solo lo hacian pre-sell y la compra publica, asi que un
  // vendedor podia emitir desde aca un tipo que no tenia habilitado.
  {
    const permiso = await puedeEmitirTipo(req.user, ticket_type_id);
    if (!permiso.ok) return res.status(403).json({ error: permiso.error });
  }

  try {
    const ticketId = uuidv4();
    let ticketResult;

    await db.transaction(async (conn) => {
      // Verificar cupo con SELECT ... FOR UPDATE: en PG bloquea la fila de
      // ticket_types hasta que la TX commitea. Asi dos compras simultaneas
      // se serializan y no pueden ambas leer sold_count=98 y bypasear el
      // chequeo de cupo (oversell). En SQLite el translator strippea FOR
      // UPDATE; el WAL mode + transacciones IMMEDIATE ya nos dan el mismo
      // efecto serializado.
      // AND event_id: sin eso se podia vender un tipo de entrada de OTRO
      // evento. El ticket quedaba con el event_id que mando el cliente pero
      // descontando el cupo del evento del tipo: dos eventos con los numeros
      // mezclados. Verificado antes del arreglo: devolvia 201.
      const [ttRows] = await conn.execute(
        'SELECT * FROM ticket_types WHERE id = ? AND event_id = ? AND is_active = 1 FOR UPDATE',
        [ticket_type_id, event_id]
      );
      const tt = ttRows[0];
      if (!tt) throw new Error('TICKET_TYPE_NOT_FOUND');
      if (tt.sold_count >= tt.total_quota) throw new Error('NO_QUOTA');

      // Buscar promotor: si el vendedor es promotor se asigna solo, sino por código
      let promotorId = null;
      if (['jefe_publicas', 'vendedor'].includes(req.user?.role)) {
        const [pRows] = await conn.execute('SELECT id FROM promotors WHERE user_id = ?', [req.user.id]);
        if (pRows[0]) promotorId = pRows[0].id;
      } else if (promotor_code) {
        const [pRows] = await conn.execute('SELECT id FROM promotors WHERE UPPER(promo_code) = UPPER(?)', [promotor_code]);
        if (pRows[0]) promotorId = pRows[0].id;
      }

      const { code, qrBase64 } = await generateQR(ticketId);
      const isPaid = ['efectivo', 'transferencia'].includes(payment_method);
      const status = isPaid ? 'pagado' : 'pendiente';
      // Siempre usar el precio canonico del ticket_type. El cliente NO puede
      // enviar amount_paid arbitrario (antes podia mandar 1 y vender un ticket
      // de 5000 por 1).
      const price  = parseFloat(tt.price);

      await conn.execute(
        `INSERT INTO tickets
           (id, event_id, ticket_type_id, buyer_name, buyer_apellido, buyer_dni, buyer_email, buyer_edad, buyer_localidad,
            qr_code, payment_method, payment_ref, amount_paid, status, promotor_id, sold_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ticketId, event_id, ticket_type_id, buyer_name, buyer_apellido || null,
         buyer_dni || null,
         buyer_email || '', buyer_edad || null, normalizeCity(buyer_localidad) || null,
         code, payment_method, payment_ref || null,
         price, status, promotorId, req.user?.id || null]
      );

      if (isPaid) {
        await conn.execute(
          `INSERT INTO payments (id, ticket_id, method, amount, status, external_id)
           VALUES (?,?,?,?,?,?)`,
          [uuidv4(), ticketId, payment_method, price, 'aprobado', payment_ref || null]
        );
        await conn.execute(
          'UPDATE ticket_types SET sold_count = sold_count + 1 WHERE id = ?',
          [ticket_type_id]
        );
      }

      // Guardar qrBase64 para la respuesta
      ticketResult = { qrBase64 };
    });

    const result = await db.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    const ticket = result.rows[0];
    ticket.qr_image = ticketResult.qrBase64;
    res.status(201).json(ticket);
  } catch (err) {
    if (err.message === 'TICKET_TYPE_NOT_FOUND')
      return res.status(404).json({ error: 'Tipo de entrada no encontrado' });
    if (err.message === 'NO_QUOTA')
      return res.status(409).json({ error: 'Sin cupo disponible' });
    console.error(err);
    res.status(500).json({ error: 'Error al crear ticket' });
  }
};

// POST /api/tickets/pre-sell
// Reserva (vende ya) N entradas sin datos del comprador. Devuelve los IDs
// para armar el link que abre el flujo de carga de datos.
// Cuando el admin aprieta "Generar link" en /caja, la entrada
// queda contada como vendida (descuenta cupo) aunque el comprador
// todavia no haya llenado su nombre.
const preSell = async (req, res) => {
  const { event_id, ticket_type_id, qty, payment_method, cortesia } = req.body;

  if (!event_id || !ticket_type_id || !qty)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });

  const numQty = parseInt(qty, 10);
  if (isNaN(numQty) || numQty < 1 || numQty > 10)
    return res.status(400).json({ error: 'Cantidad invalida (maximo 10)' });

  const isCortesia = !!cortesia;
  // Cortesia: admin siempre; owner solo si el evento es suyo. El resto no.
  if (isCortesia) {
    if (req.user.role === 'admin') {
      /* ok */
    } else if (req.user.role === 'owner') {
      const own = await db.query('SELECT 1 FROM event_owners WHERE event_id = ? AND user_id = ?', [event_id, req.user.id]);
      if (!own.rows[0]) return res.status(403).json({ error: 'No sos dueño de este evento' });
    } else {
      return res.status(403).json({ error: 'Solo admin o dueño del evento puede generar cortesias' });
    }
  }

  // Acceso al evento, para TODOS los roles. Antes solo se comprobaba para el
  // owner, asi que un jefe o un vendedor podia pre-vender en el evento de
  // otro organizador mandando su event_id a mano (verificado: devolvia 201).
  if (!await userCanAccessEvent(req.user, event_id))
    return res.status(403).json({ error: 'Sin acceso a este evento' });

  // Permisos por tipo: si el ticket_type tiene una lista de sellers
  // autorizados y el jefe/vendedor NO esta en ella, rechazamos. Lista vacia =
  // abierto a todos. Mismo criterio que createPublicTicket: evita que un
  // vendedor reserve tipos para los que el dueño no lo habilito.
  {
    const permiso = await puedeEmitirTipo(req.user, ticket_type_id);
    if (!permiso.ok) return res.status(403).json({ error: permiso.error });
  }

  const VALID_METHODS = ['efectivo', 'transferencia'];
  if (!isCortesia && !VALID_METHODS.includes(payment_method))
    return res.status(400).json({ error: 'Metodo de pago invalido' });

  // Cortesia bypasea la ventana de venta (consistente con createPublicTicket
  // para code='CASA'): el admin puede regalar entradas fuera de la ventana.
  // Pero NO puede saltearse el estado del evento: uno finalizado o cancelado
  // no recibe entradas nuevas, ni siquiera regaladas, porque dejaria de ser
  // el registro fiel de lo que paso esa noche.
  if (!isCortesia) {
    const window = await checkSaleWindow(event_id);
    if (!window.ok) return res.status(window.status).json({ error: window.message });
  } else {
    const estado = await eventoOperable(event_id);
    if (!estado.ok) return res.status(estado.status).json({ error: estado.message });
  }

  try {
    const createdIds = [];
    // Datos del tt para enviar push de "cupo bajo / sold out" DESPUES de
    // commitear (no dentro de la transaccion).
    let ttSnapshot = null;

    await db.transaction(async (conn) => {
      // FOR UPDATE: bloqueo de fila en PG para evitar oversell concurrente.
      // SQLite ignora la clausula (translator la strippea).
      const [ttRows] = await conn.execute(
        'SELECT * FROM ticket_types WHERE id = ? AND event_id = ? AND is_active = 1 FOR UPDATE',
        [ticket_type_id, event_id]
      );
      const tt = ttRows[0];
      if (!tt) throw new Error('TICKET_TYPE_NOT_FOUND');

      const available = tt.total_quota - tt.sold_count;
      if (available < numQty) throw new Error('NO_QUOTA');

      // promotor_id: admin no tiene perfil de promotor, queda null.
      let promotorId = null;
      const [pRows] = await conn.execute('SELECT id FROM promotors WHERE user_id = ?', [req.user.id]);
      if (pRows[0]) promotorId = pRows[0].id;
      else if (['jefe_publicas', 'vendedor'].includes(req.user.role))
        throw new Error('PROMOTOR_NOT_FOUND');

      const fullPrice = parseFloat(tt.price);
      const price = isCortesia ? 0 : fullPrice;
      // El enum tickets.status no incluye 'cortesia' (mismo patron que
      // cortesiasController.js): se distingue por payment_method.
      const status = 'pagado';
      const validMethod = isCortesia ? 'cortesia' : payment_method;

      for (let i = 0; i < numQty; i++) {
        const ticketId = uuidv4();
        const { code } = await generateQR(ticketId);

        await conn.execute(
          `INSERT INTO tickets
             (id, event_id, ticket_type_id, buyer_name, buyer_apellido, buyer_email,
              qr_code, payment_method, payment_ref, amount_paid, status, promotor_id, sold_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ticketId, event_id, ticket_type_id, 'Pendiente', 'Pendiente', '',
           code, validMethod, 'RESERVADO', price, status, promotorId, req.user.id]
        );

        // Para cortesias no creamos registro en payments (no hubo cobro).
        if (!isCortesia) {
          await conn.execute(
            `INSERT INTO payments (id, ticket_id, method, amount, status, external_id)
             VALUES (?,?,?,?,?,?)`,
            [uuidv4(), ticketId, validMethod, price, 'aprobado', null]
          );
        }

        createdIds.push(ticketId);
      }

      await conn.execute(
        'UPDATE ticket_types SET sold_count = sold_count + ? WHERE id = ?',
        [numQty, ticket_type_id]
      );

      // Stash datos para el push post-commit. No podemos llamar sendPush
      // aca adentro porque la transaccion no esta cerrada todavia.
      ttSnapshot = { tt, numQty, event_id };
    });

    res.status(201).json({ tickets: createdIds });

    // Push post-commit: aviso al dueño cuando la tanda cruza el 90% o se
    // agota. Fire-and-forget; si no hay VAPID configurado es no-op.
    if (ttSnapshot) {
      (async () => {
        try {
          const { tt, numQty, event_id } = ttSnapshot;
          const newSold = tt.sold_count + numQty;
          const oldRatio = tt.sold_count / tt.total_quota;
          const newRatio = newSold / tt.total_quota;
          const crossed90 = oldRatio < 0.9 && newRatio >= 0.9;
          const crossedSoldOut = oldRatio < 1 && newRatio >= 1;
          if (!crossed90 && !crossedSoldOut) return;

          const ev = (await db.query('SELECT name FROM events WHERE id = ?', [event_id])).rows[0];
          const owners = await db.query('SELECT user_id FROM event_owners WHERE event_id = ?', [event_id]);
          const payload = crossedSoldOut
            ? { title: 'Sold out', body: `Se agotó "${tt.name}" en ${ev?.name || 'tu evento'}.`, url: `/evento/${event_id}` }
            : { title: 'Cupo bajo', body: `"${tt.name}" llegó al 90% en ${ev?.name || 'tu evento'}.`, url: `/evento/${event_id}` };
          for (const o of owners.rows) {
            sendPush(o.user_id, payload).catch(() => {});
          }
        } catch { /* silencioso */ }
      })();
    }
  } catch (err) {
    if (err.message === 'TICKET_TYPE_NOT_FOUND')
      return res.status(404).json({ error: 'Tipo de entrada no encontrado' });
    if (err.message === 'NO_QUOTA')
      return res.status(409).json({ error: 'Sin cupo disponible suficiente' });
    if (err.message === 'PROMOTOR_NOT_FOUND')
      return res.status(403).json({ error: 'No tenés un perfil de pública asociado' });
    console.error(err);
    res.status(500).json({ error: 'Error al pre-vender tickets' });
  }
};

// POST /api/tickets/scan
const scan = async (req, res) => {
  const { qr_code, ticket_type_id } = req.body;
  if (!qr_code) return res.status(400).json({ error: 'qr_code requerido' });

  try {
    let rawCode = qr_code;
    let rawId = null;

    if (typeof rawCode === 'string' && rawCode.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawCode);
        if (parsed && typeof parsed === 'object') {
          rawCode = parsed.code || parsed.qr_code || parsed.id || rawCode;
          rawId = parsed.ticket_id || parsed.id || null;
        }
      } catch { /* string simple */ }
    } else if (typeof rawCode === 'object' && rawCode !== null) {
      rawId = rawCode.ticket_id || rawCode.id || null;
      rawCode = rawCode.code || rawCode.qr_code || rawCode.id || JSON.stringify(rawCode);
    }

    const cleanCode = String(rawCode || '').toUpperCase().trim();

    const result = await db.query(
      `SELECT t.*, tt.name AS tipo_entrada, e.name AS evento, e.date, e.start_time
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       WHERE UPPER(TRIM(t.qr_code)) = UPPER(TRIM(?))`, [cleanCode]
    );

    const ticket = result.rows[0];
    if (!ticket) return res.status(404).json({ error: 'QR no válido', valid: false });

    // Una sola normalizacion, apenas leemos la entrada: asi TODAS las salidas
    // de abajo devuelven la hora igual. Antes se hacia en cada return y se
    // escapaban caminos, que mandaban el string crudo de SQLite corrido 3h.
    if (ticket.scanned_at) ticket.scanned_at = fechaISO(ticket.scanned_at);

    // Scope por rol: el owner solo puede escanear entradas de SUS eventos.
    // Sin esto, habilitar owner en la ruta le habria dado el poder de marcar
    // como usada cualquier entrada del sistema, de cualquier tenant.
    if (req.user?.role === 'owner') {
      const own = await db.query(
        'SELECT 1 FROM event_owners WHERE event_id = ? AND user_id = ?',
        [ticket.event_id, req.user.id]
      );
      if (!own.rows[0])
        return res.status(403).json({ valid: false, error: 'Esta entrada es de un evento que no es tuyo' });
    }

    // Filtro por tipo de entrada si se especificó
    if (ticket_type_id && ticket.ticket_type_id !== ticket_type_id) {
      return res.status(403).json({
        valid: false,
        error: `Tipo incorrecto: esta entrada es "${ticket.tipo_entrada}"`,
        ticket,
      });
    }

    if (ticket.status === 'usado')
      return res.status(409).json({ valid: false, error: 'Esta entrada ya fue utilizada',
        scanned_at: ticket.scanned_at, ticket });

    // Una reserva todavia no vendida NO es una entrada. Nace con
    // status='pagado' (para que descuente cupo) y con su qr_code ya armado,
    // asi que sin este chequeo se podia escanear en la puerta antes de que
    // nadie la comprara: entraba alguien con el nombre "Pendiente Pendiente"
    // y despues el comprador real llegaba con SU entrada y se la rechazaban
    // por "ya fue utilizada". Reproducido antes del arreglo.
    if (ticket.payment_ref === 'RESERVADO')
      return res.status(402).json({
        valid: false,
        error: 'Esta entrada está reservada y todavía no fue completada por el comprador',
        ticket,
      });

    if (ticket.status !== 'pagado')
      return res.status(402).json({ valid: false, error: `Estado: ${ticket.status}`, ticket });

    // UPDATE condicional: si dos porteros scanean el mismo QR a la vez, solo
    // uno gana (el que marca 'pagado'->'usado'). El otro ve affectedRows=0
    // y obtiene el mismo 409 que un re-escaneo normal.
    const upd = await db.query(
      "UPDATE tickets SET status='usado', scanned_at=CURRENT_TIMESTAMP, scanned_by=? WHERE id=? AND status='pagado'",
      [req.user.id, ticket.id]
    );
    if (!upd.affectedRows) {
      // Perdimos la carrera: otro portero marco la entrada entre nuestro
      // SELECT y nuestro UPDATE. El `ticket` que tenemos en memoria es de
      // ANTES de ese update, asi que scanned_at y puerta vienen vacios — y
      // son justo los dos datos que el portero necesita para decidir si deja
      // pasar. Lo releemos.
      const fresco = await db.query(
        `SELECT t.scanned_at, s.label AS puerta
           FROM tickets t
           LEFT JOIN scanner_tokens s ON s.id = t.scanned_token_id
          WHERE t.id = ?`, [ticket.id]
      );
      const f = fresco.rows[0];
      return res.status(409).json({
        valid: false,
        error: 'Esta entrada ya fue utilizada',
        ticket: { ...ticket, status: 'usado', scanned_at: fechaISO(f?.scanned_at), puerta: f?.puerta ?? null },
      });
    }

    ticket.status     = 'usado';
    ticket.scanned_at = new Date();
    res.json({ valid: true, message: 'Entrada válida. ¡Bienvenido!', ticket });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al escanear QR' });
  }
};

const getOne = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT t.*, tt.name AS tipo_entrada, tt.price,
              e.name AS evento, e.date, e.start_time,
              -- Por que puerta entro. Con varios porteros es el dato que
              -- responde un reclamo de "figura usada y yo no entre".
              st.label AS puerta,
              TRIM(sb.name || ' ' || COALESCE(sb.apellido, '')) AS escaneado_por
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       LEFT JOIN scanner_tokens st ON st.id = t.scanned_token_id
       LEFT JOIN users sb ON sb.id = t.scanned_by
       WHERE t.id = ?`, [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ticket no encontrado' });
    // Owner solo puede ver tickets de SUS eventos (anti-IDOR).
    if (req.user?.role === 'owner') {
      const own = await db.query('SELECT 1 FROM event_owners WHERE event_id = ? AND user_id = ?', [result.rows[0].event_id, req.user.id]);
      if (!own.rows[0]) return res.status(403).json({ error: 'Sin acceso a este ticket' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener ticket' });
  }
};

const getAll = async (req, res) => {
  const { event_id, status, search } = req.query;
  let where = [];
  let params = [];

  // Owner: solo puede ver tickets de sus eventos asignados
  if (req.user?.role === 'owner') {
    // Si especificó un event_id concreto, verificar que le pertenece
    if (event_id) {
      const ok = await db.query(
        'SELECT 1 FROM event_owners WHERE user_id = ? AND event_id = ?',
        [req.user.id, event_id]
      );
      if (!ok.rows[0]) return res.status(403).json({ error: 'Sin acceso a este evento' });
    } else {
      // Sin event_id: restringir a todos sus eventos
      where.push('t.event_id IN (SELECT event_id FROM event_owners WHERE user_id = ?)');
      params.push(req.user.id);
    }
  }

  // Admin: solo puede ver tickets de eventos de SU arbol (anti cross-tenant
  // entre admins). Sin esto, admin_A leia listado de tickets de admin_B.
  if (req.user?.role === 'admin') {
    where.push(`t.event_id IN (
      SELECT e.id FROM events e
      WHERE e.created_by = ?
         OR e.id IN (SELECT eo.event_id FROM event_owners eo
                     JOIN users u ON u.id = eo.user_id
                     WHERE u.created_by = ?)
    )`);
    params.push(req.user.id, req.user.id);
  }

  if (event_id) { where.push('t.event_id = ?'); params.push(event_id); }
  if (status)   { where.push('t.status = ?');   params.push(status); }
  if (search)   {
    // Incluye nombre y apellido de quien generó el QR para poder buscar una
    // entrada por el vendedor/cajero que la cargó.
    // LOWER en ambos lados: LIKE es case-sensitive en Postgres (case-
    // insensitive en SQLite). Asi unificamos buscando case-insensitive en
    // ambos motores sin tener que usar ILIKE (que es PG-only).
    where.push('(LOWER(t.buyer_name) LIKE LOWER(?) OR LOWER(t.buyer_apellido) LIKE LOWER(?) OR LOWER(t.buyer_email) LIKE LOWER(?) OR LOWER(t.buyer_localidad) LIKE LOWER(?) OR LOWER(t.qr_code) LIKE LOWER(?) OR LOWER(su.name) LIKE LOWER(?) OR LOWER(su.apellido) LIKE LOWER(?))');
    const q = `%${search}%`;
    params.push(q, q, q, q, q, q, q);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const result = await db.query(
      `SELECT t.*, tt.name AS tipo_entrada, e.name AS evento, e.date,
              pu.name AS vendedor_nombre, p.promo_code AS vendedor_code,
              TRIM(su.name || ' ' || COALESCE(su.apellido, '')) AS generado_por,
              st.label AS puerta
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       LEFT JOIN promotors p ON p.id = t.promotor_id
       LEFT JOIN users pu ON pu.id = p.user_id
       LEFT JOIN users su ON su.id = t.sold_by
       LEFT JOIN scanner_tokens st ON st.id = t.scanned_token_id
       ${whereClause}
       ORDER BY t.created_at DESC LIMIT 5000`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener tickets' });
  }
};

const getQR = async (req, res) => {
  try {
    const result = await db.query('SELECT qr_code, event_id FROM tickets WHERE id = ?', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Ticket no encontrado' });
    // Owner solo puede generar QR de tickets de SUS eventos (anti-IDOR).
    if (req.user?.role === 'owner') {
      const own = await db.query('SELECT 1 FROM event_owners WHERE event_id = ? AND user_id = ?', [result.rows[0].event_id, req.user.id]);
      if (!own.rows[0]) return res.status(403).json({ error: 'Sin acceso a este ticket' });
    }
    const qrData   = JSON.stringify({ code: result.rows[0].qr_code, ticket_id: req.params.id });
    const qrBase64 = await QRCode.toDataURL(qrData, { width: 300 });
    res.json({ qr_image: qrBase64 });
  } catch (err) {
    res.status(500).json({ error: 'Error al generar QR' });
  }
};

// DELETE /api/tickets/:id — admin y owner (owner solo de sus eventos)
const remove = async (req, res) => {
  try {
    const t = await db.query('SELECT event_id, ticket_type_id, status FROM tickets WHERE id = ?', [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Ticket no encontrado' });
    const eventId      = t.rows[0].event_id;
    const ticketTypeId = t.rows[0].ticket_type_id;
    const wasValid     = ['pagado', 'usado'].includes(t.rows[0].status);

    // Scope por rol (anti-IDOR / anti cross-tenant):
    //  - owner: solo borra tickets de eventos donde figura como dueño.
    //  - admin: solo borra tickets de eventos de SU arbol (mismo criterio
    //    que getAll), evita que un admin borre tickets de otro tenant.
    if (req.user?.role === 'owner') {
      const own = await db.query('SELECT 1 FROM event_owners WHERE event_id = ? AND user_id = ?', [eventId, req.user.id]);
      if (!own.rows[0]) return res.status(403).json({ error: 'Sin acceso a este ticket' });
    } else if (req.user?.role === 'admin') {
      const inTree = await db.query(
        `SELECT 1 FROM events e
          WHERE e.id = ?
            AND (e.created_by = ?
                 OR e.id IN (SELECT eo.event_id FROM event_owners eo
                             JOIN users u ON u.id = eo.user_id
                             WHERE u.created_by = ?))`,
        [eventId, req.user.id, req.user.id]
      );
      if (!inTree.rows[0]) return res.status(403).json({ error: 'Sin acceso a este ticket' });
    }

    // Atomico: payments + ticket + sold_count en la misma transaccion.
    // Sin esto, si el delete del ticket fallaba el cupo nunca se liberaba;
    // y si el update fallaba quedaba inconsistente entre ambos.
    await db.transaction(async (conn) => {
      await conn.execute('DELETE FROM payments WHERE ticket_id = ?', [req.params.id]);
      await conn.execute('DELETE FROM tickets WHERE id = ?', [req.params.id]);
      if (wasValid) {
        // CASE WHEN ... portable: SQLite acepta MAX(a,b) escalar pero Postgres
        // no (alli MAX es solo agregada → tiraba "function does not exist").
        await conn.execute(
          'UPDATE ticket_types SET sold_count = CASE WHEN sold_count > 0 THEN sold_count - 1 ELSE 0 END WHERE id = ?',
          [ticketTypeId]
        );
      }
    });

    logAudit(req, 'TICKET_DELETE', { resourceType: 'ticket', resourceId: req.params.id });
    res.json({ message: 'Ticket eliminado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar ticket' });
  }
};

module.exports = { create, preSell, scan, getOne, getAll, getQR, remove };
