const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { fechaISO } = require('../utils/fechas');
const { adminCanAccessEvent } = require('../utils/scope');

// Helper: ¿el usuario es dueño del evento? Admin solo dentro de SU arbol
// (anti cross-tenant, mismo criterio que ticketsController).
async function canManageEvent(user, event_id) {
  if (user.role === 'admin') return adminCanAccessEvent(user.id, event_id);
  if (user.role === 'owner') {
    const r = await db.query('SELECT 1 FROM event_owners WHERE event_id = ? AND user_id = ?', [event_id, user.id]);
    return r.rows.length > 0;
  }
  return false;
}

// Devuelve los tipos de entrada (id + name) que valida un token, según el
// modelo de 3 niveles: all_types=1 → todos los del evento; filas en
// scanner_token_types → solo esos; si no, el ticket_type_id único (legacy).
async function resolveTokenTypes(row) {
  if (Number(row.all_types) === 1) {
    const r = await db.query(
      'SELECT id, name FROM ticket_types WHERE event_id = ? ORDER BY created_at ASC',
      [row.event_id]
    );
    return { all: true, types: r.rows };
  }
  const j = await db.query(
    `SELECT tt.id, tt.name
       FROM scanner_token_types stt
       JOIN ticket_types tt ON tt.id = stt.ticket_type_id
      WHERE stt.token_id = ?`,
    [row.id]
  );
  if (j.rows.length > 0) return { all: false, types: j.rows };
  // Legacy: un solo tipo.
  const r = await db.query('SELECT id, name FROM ticket_types WHERE id = ?', [row.ticket_type_id]);
  return { all: false, types: r.rows };
}

// Texto para mostrar en la UI a partir de los tipos resueltos.
function typesLabel(resolved) {
  if (resolved.all) return 'Todos los tipos';
  return resolved.types.map(t => t.name).join(' + ');
}

// GET /api/scanner-tokens?event_id= — admin/owner lista tokens activos de un evento
const getTokens = async (req, res) => {
  const { event_id } = req.query;
  if (!event_id) return res.status(400).json({ error: 'event_id requerido' });
  if (!(await canManageEvent(req.user, event_id)))
    return res.status(403).json({ error: 'Sin acceso a este evento' });
  try {
    const result = await db.query(
      `SELECT st.*, tt.name AS ticket_type_name, e.name AS event_name
       FROM scanner_tokens st
       LEFT JOIN ticket_types tt ON tt.id = st.ticket_type_id
       JOIN events e ON e.id = st.event_id
       WHERE st.event_id = ? AND st.is_active = 1
       ORDER BY st.created_at DESC`,
      [event_id]
    );
    const rows = [];
    for (const row of result.rows) {
      const resolved = await resolveTokenTypes(row);
      rows.push({ ...row, type_names: typesLabel(resolved), all_types: Number(row.all_types) === 1 ? 1 : 0 });
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener tokens' });
  }
};

// POST /api/scanner-tokens — admin/owner genera un link para una o varias tandas
// Acepta: { event_id, ticket_type_id (legacy), ticket_type_ids: [], all_types, label }
const createToken = async (req, res) => {
  const { event_id, ticket_type_id, ticket_type_ids, all_types, label } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id es requerido' });
  if (!(await canManageEvent(req.user, event_id)))
    return res.status(403).json({ error: 'Sin acceso a este evento' });

  // Normalizo los tipos pedidos (array nuevo + single legacy), sin duplicados.
  const requested = [];
  if (Array.isArray(ticket_type_ids)) requested.push(...ticket_type_ids);
  if (ticket_type_id) requested.push(ticket_type_id);
  const chosenIds = [...new Set(requested.filter(Boolean))];
  const wantsAll = !!all_types;

  if (!wantsAll && chosenIds.length === 0)
    return res.status(400).json({ error: 'Elegí al menos un tipo de entrada o "Todos los tipos"' });

  try {
    // Tipos reales del evento — para validar y elegir el placeholder NOT NULL.
    const evTypes = await db.query(
      'SELECT id, name FROM ticket_types WHERE event_id = ? ORDER BY created_at ASC',
      [event_id]
    );
    if (evTypes.rows.length === 0)
      return res.status(400).json({ error: 'El evento no tiene tipos de entrada' });
    const validIds = new Set(evTypes.rows.map(t => t.id));

    let placeholder;        // ticket_type_id (NOT NULL) representativo
    let junction = [];      // filas extra solo si es subset multi-tipo
    if (wantsAll) {
      placeholder = evTypes.rows[0].id;
    } else {
      for (const id of chosenIds) {
        if (!validIds.has(id))
          return res.status(400).json({ error: 'Un tipo de entrada no pertenece a este evento' });
      }
      placeholder = chosenIds[0];
      if (chosenIds.length > 1) junction = chosenIds;
    }

    // Label automático si no lo mandan: "Puerta 1", "Puerta 2", ...
    //
    // Antes salian todos con el mismo nombre ("Todos los tipos"), asi que con
    // varios porteros la lista quedaba con cinco filas identicas y no habia
    // forma de saber cual mandarle a cada uno, ni cual desactivar si alguien
    // perdia el celular. Numerarlos es lo que hace usable tener 10 puertas.
    let finalLabel = label;
    if (!finalLabel) {
      // Siguiente numero libre: tomamos el mayor usado + 1, no la cantidad.
      // Asi desactivar la Puerta 4 no hace que la proxima tambien sea 4 y
      // queden dos puertas con el mismo nombre, que es justo lo que arruina
      // poder decir "revisá la Puerta 4".
      const previos = await db.query(
        'SELECT label FROM scanner_tokens WHERE event_id = ?',
        [event_id]
      );
      const usados = previos.rows
        .map(r => /^Puerta (\d+)/.exec(String(r.label || ''))?.[1])
        .filter(Boolean)
        .map(Number);
      const numero = usados.length ? Math.max(...usados) + 1 : 1;

      // Si el link valida solo algunos tipos, lo aclaramos al lado del
      // numero: el portero necesita saber cual es SU puerta, y el dueño
      // necesita saber que valida cada una.
      const tipos = wantsAll
        ? ''
        : chosenIds
            .map(id => evTypes.rows.find(t => t.id === id)?.name)
            .filter(Boolean)
            .join(' + ');
      finalLabel = tipos ? `Puerta ${numero} · ${tipos}` : `Puerta ${numero}`;
    }

    const id    = uuidv4();
    const token = uuidv4();
    await db.transaction(async (conn) => {
      await conn.query(
        'INSERT INTO scanner_tokens (id, token, event_id, ticket_type_id, all_types, label, created_by) VALUES (?,?,?,?,?,?,?)',
        [id, token, event_id, placeholder, wantsAll ? 1 : 0, finalLabel || null, req.user.id]
      );
      for (const ttId of junction) {
        await conn.query(
          'INSERT INTO scanner_token_types (token_id, ticket_type_id) VALUES (?,?)',
          [id, ttId]
        );
      }
    });

    const out = await db.query(
      `SELECT st.*, tt.name AS ticket_type_name, e.name AS event_name
       FROM scanner_tokens st
       LEFT JOIN ticket_types tt ON tt.id = st.ticket_type_id
       JOIN events e ON e.id = st.event_id
       WHERE st.id = ?`, [id]
    );
    const row = out.rows[0];
    const resolved = await resolveTokenTypes(row);
    res.status(201).json({ ...row, type_names: typesLabel(resolved), all_types: wantsAll ? 1 : 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear token' });
  }
};

// DELETE /api/scanner-tokens/:id — admin/owner desactiva un link
const deleteToken = async (req, res) => {
  try {
    const tok = await db.query('SELECT event_id FROM scanner_tokens WHERE id = ?', [req.params.id]);
    if (!tok.rows[0]) return res.status(404).json({ error: 'Token no encontrado' });
    if (!(await canManageEvent(req.user, tok.rows[0].event_id)))
      return res.status(403).json({ error: 'Sin acceso a este evento' });
    await db.query('UPDATE scanner_tokens SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Token desactivado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al desactivar token' });
  }
};

// GET /api/scan/:token — info del escáner (público, sin auth)
// Un token deja de servir 24h despues del evento: evita que un portero
// (o cualquiera con el link) siga marcando entradas como "usadas" dias
// despues. Es una baranda — el admin puede desactivar manualmente igual.
function tokenExpired(event_date) {
  if (!event_date) return false;
  const eventDay = new Date(`${event_date}T23:59:59`);
  const cutoff = new Date(eventDay.getTime() + 24 * 60 * 60 * 1000);
  return new Date() > cutoff;
}

const getScannerInfo = async (req, res) => {
  const { token } = req.params;
  try {
    const result = await db.query(
      `SELECT st.*, e.name AS event_name, e.date AS event_date,
              tt.name AS ticket_type_name, tt.price AS ticket_price
       FROM scanner_tokens st
       JOIN events e ON e.id = st.event_id
       LEFT JOIN ticket_types tt ON tt.id = st.ticket_type_id
       WHERE st.token = ? AND st.is_active = 1`,
      [token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Link inválido o desactivado' });
    const row = result.rows[0];
    if (tokenExpired(row.event_date))
      return res.status(410).json({ error: 'Link vencido: el evento ya finalizó' });
    const resolved = await resolveTokenTypes(row);
    res.json({
      event_name:        row.event_name,
      event_date:        row.event_date,
      ticket_type_name:  typesLabel(resolved),
      ticket_price:      row.ticket_price,
      label:             row.label,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener info del escáner' });
  }
};

const publicScan = async (req, res) => {
  const { token } = req.params;
  const { qr_code } = req.body;
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

    const [tokenResult, ticketResult] = await Promise.all([
      db.query(
        `SELECT st.*, tt.name AS ticket_type_name, e.name AS event_name, e.date AS event_date
         FROM scanner_tokens st
         JOIN events e ON e.id = st.event_id
         LEFT JOIN ticket_types tt ON tt.id = st.ticket_type_id
         WHERE st.token = ? AND st.is_active = 1`,
        [token]
      ),
      db.query(
        // sprev = la puerta por la que ya se habia escaneado. Es lo que
        // necesita ver el portero cuando le salta "ya fue utilizada": le
        // dice si fue un error de otra puerta o una entrada duplicada.
        `SELECT t.*, tt.name AS tipo_entrada, e.name AS evento,
                sprev.label AS puerta
         FROM tickets t
         JOIN ticket_types tt ON tt.id = t.ticket_type_id
         JOIN events e ON e.id = t.event_id
         LEFT JOIN scanner_tokens sprev ON sprev.id = t.scanned_token_id
         WHERE UPPER(TRIM(t.qr_code)) = UPPER(TRIM(?))`,
        [cleanCode]
      ),
    ]);

    if (!tokenResult.rows[0]) return res.status(403).json({ error: 'Link inválido o desactivado' });

    const scannerInfo = tokenResult.rows[0];
    if (tokenExpired(scannerInfo.event_date))
      return res.status(410).json({ valid: false, error: 'Link vencido: el evento ya finalizó' });

    // Tipos que este link acepta: null = todos los del evento.
    let allowedIds = null;
    if (Number(scannerInfo.all_types) !== 1) {
      const resolved = await resolveTokenTypes(scannerInfo);
      allowedIds = resolved.types.map(t => t.id);
    }

    const ticket = ticketResult.rows[0];
    if (!ticket) return res.status(404).json({ valid: false, error: 'QR no válido' });

    // Una sola normalizacion, apenas leemos la entrada: asi TODAS las
    // salidas de abajo devuelven la hora igual. Antes se hacia en cada
    // return y se escapaban caminos — el rechazo por tipo de entrada
    // seguia mandando el string crudo de SQLite, corrido 3 horas.
    if (ticket.scanned_at) ticket.scanned_at = fechaISO(ticket.scanned_at);

    if (ticket.event_id !== scannerInfo.event_id)
      return res.status(400).json({ valid: false, error: 'Este ticket es de otro evento', ticket });

    if (allowedIds && !allowedIds.includes(ticket.ticket_type_id))
      return res.status(400).json({
        valid: false,
        error: `Ticket tipo "${ticket.tipo_entrada}" — este escáner no acepta ese tipo`,
        ticket,
      });

    if (ticket.status === 'usado')
      return res.status(409).json({ valid: false, error: 'Esta entrada ya fue utilizada', ticket });

    // Mismo chequeo que en /tickets/scan: una reserva sin completar no es una
    // entrada valida, aunque su status sea 'pagado' y ya tenga qr_code.
    if (ticket.payment_ref === 'RESERVADO')
      return res.status(402).json({
        valid: false,
        error: 'Esta entrada está reservada y todavía no fue completada por el comprador',
        ticket,
      });

    if (ticket.status !== 'pagado')
      return res.status(402).json({ valid: false, error: `Estado inválido: ${ticket.status}`, ticket });

    // UPDATE condicional para evitar doble-uso en scans concurrentes (dos
    // porteros con el mismo link scaneando al mismo tiempo). Si otro ya
    // marco la entrada, affectedRows=0 y devolvemos 409.
    // Guardamos POR QUE PUERTA entro. scanned_by no sirve aca: apunta a la
    // tabla de usuarios y el portero no tiene cuenta, solo el link.
    const upd = await db.query(
      "UPDATE tickets SET status='usado', scanned_at=CURRENT_TIMESTAMP, scanned_token_id=? WHERE id=? AND status='pagado'",
      [scannerInfo.id, ticket.id]
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
    ticket.scanned_at = new Date().toISOString();

    res.json({ valid: true, message: 'Entrada valida. Bienvenido', ticket });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al escanear' });
  }
};

module.exports = { getTokens, createToken, deleteToken, getScannerInfo, publicScan };
