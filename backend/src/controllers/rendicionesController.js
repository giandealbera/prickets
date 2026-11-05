const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { adminCanAccessUser } = require('../utils/scope');

// Fila "Caja" del listado de rendiciones.
//
// Todo lo que emite el admin o el dueño desde la caja queda fuera del listado
// de publicas: el admin arrastra el promotor interno CASA y el dueño no tiene
// ficha de promotor, asi que sus entradas van con promotor_id en nulo. Las dos
// cosas las filtra la consulta de abajo (role != 'admin', promo_code != CASA).
// Resultado: esa plata no aparecia en ningun lado y el total de la noche no
// cerraba. Verificado: 3 entradas de $5.000 generadas por el admin daban
// $15.000 invisibles.
//
// No es una publica: nadie rinde esta plata porque ya esta en la casa. Por eso
// la fila va sin comision y sin saldo pendiente, y no se puede abrir el
// detalle ni registrar un pago contra ella. Es un renglon de lectura.
//
// Las cortesias se cuentan aparte: son $0 por definicion e infladas dentro de
// "vendidas" hacian ver 200 ventas donde no hubo un peso.
async function filaCaja(req, event_id) {
  const params = [];

  // Alcance por evento, el mismo que usa GET /events.
  let scope;
  if (req.user.role === 'owner') {
    scope = 'AND e.id IN (SELECT event_id FROM event_owners WHERE user_id = ?)';
    params.push(req.user.id);
  } else {
    scope = `AND (
      e.created_by = ?
      OR e.id IN (
        SELECT eo.event_id FROM event_owners eo
        JOIN users u ON u.id = eo.user_id
        WHERE u.created_by = ?
      )
    )`;
    params.push(req.user.id, req.user.id);
  }

  let eventFilter = '';
  if (event_id) {
    eventFilter = 'AND t.event_id = ?';
    params.push(event_id);
  }

  const r = await db.query(
    `SELECT COUNT(CASE WHEN t.payment_method != 'cortesia' THEN 1 END) AS vendidas,
            COALESCE(SUM(CASE WHEN t.payment_method != 'cortesia' THEN t.amount_paid ELSE 0 END), 0) AS recaudado,
            COUNT(CASE WHEN t.payment_method = 'cortesia' THEN 1 END) AS cortesias
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       LEFT JOIN promotors p ON p.id = t.promotor_id
       LEFT JOIN users pu ON pu.id = p.user_id
      WHERE t.status IN ('pagado','usado')
        AND (p.id IS NULL OR p.promo_code = 'CASA' OR pu.role NOT IN ('jefe_publicas','vendedor'))
        ${scope} ${eventFilter}`,
    params
  );

  const row = r.rows[0] || {};
  const vendidas  = parseInt(row.vendidas  || 0, 10);
  const cortesias = parseInt(row.cortesias || 0, 10);
  if (!vendidas && !cortesias) return null;  // sin movimiento, no ensuciamos la lista

  return {
    promotor_id: 'caja',   // centinela: no existe en la tabla promotors
    es_caja: true,
    user_id: null,
    name: 'Caja',
    apellido: '',
    celular: null, localidad: null, email: null,
    promo_code: 'CASA',
    commission: 0, leader_commission: 0,
    zona_id: null, zona_name: null, leader_name: null,
    role: 'caja',
    total_vendidas: vendidas,
    total_recaudado: parseFloat(row.recaudado || 0),
    cortesias,
    comision_promotor: 0,
    debe_enviar: 0,
    ya_rindio: 0,
    saldo_pendiente: 0,
  };
}

// GET /api/rendiciones — lista de publicas con saldo
// Devuelve todas las publicas con: vendido, comision, debe enviar, ya rindio, saldo pendiente
const listPublicas = async (req, res) => {
  const { search, event_id } = req.query;
  try {
    const params = [];
    let ticketJoinClause = 'LEFT JOIN tickets t ON t.promotor_id = p.id';
    let yaRindioClause   = '(SELECT COALESCE(SUM(amount),0) FROM rendiciones WHERE promotor_id = p.id)';
    if (event_id) {
      ticketJoinClause = 'LEFT JOIN tickets t ON t.promotor_id = p.id AND t.event_id = ?';
      yaRindioClause   = '(SELECT COALESCE(SUM(amount),0) FROM rendiciones WHERE promotor_id = p.id AND event_id = ?)';
      params.push(event_id); // ? #1 en ticketJoinClause
      params.push(event_id); // ? #2 en yaRindioClause (SELECT list)
    }

    let searchClause = '';
    if (search) {
      searchClause = `AND (LOWER(u.name) LIKE LOWER(?) OR LOWER(u.apellido) LIKE LOWER(?) OR LOWER(p.promo_code) LIKE LOWER(?))`;
      const q = `%${search}%`;
      params.push(q, q, q); // ? #3, #4, #5 en WHERE clause
    }

    // Scope multi-tenant.
    //   owner: solo su staff (el que creo el, o el que creo su jefe).
    //   admin: solo su arbol —los owners que cargo, el staff de esos owners y
    //     el staff de esos jefes—. Sin esta rama, el listado le mostraba a un
    //     admin las publicas de los clientes de otro admin, con sus ventas y
    //     saldos.
    let ownerScopeClause = '';
    if (req.user.role === 'owner') {
      ownerScopeClause = 'AND (u.created_by = ? OR u.created_by IN (SELECT id FROM users WHERE created_by = ?))';
      params.push(req.user.id, req.user.id);
    } else if (req.user.role === 'admin') {
      ownerScopeClause = `AND (
        u.created_by = ?
        OR u.created_by IN (SELECT id FROM users WHERE created_by = ?)
        OR u.created_by IN (
          SELECT id FROM users WHERE created_by IN (SELECT id FROM users WHERE created_by = ?)
        )
      )`;
      params.push(req.user.id, req.user.id, req.user.id);
    }

    const result = await db.query(
      `SELECT p.id AS promotor_id,
              u.id AS user_id, u.name, u.apellido, u.celular, u.localidad, u.email,
              p.promo_code, p.commission, p.leader_commission, p.zona_id,
              z.name AS zona_name,
              lu.name AS leader_name,
              u.role,
              COUNT(CASE WHEN t.status IN ('pagado','usado') THEN t.id END) AS total_vendidas,
              COALESCE(SUM(CASE WHEN t.status IN ('pagado','usado') THEN t.amount_paid ELSE 0 END), 0) AS total_recaudado,
              (COUNT(CASE WHEN t.status IN ('pagado','usado') THEN t.id END) * p.commission) AS comision_promotor,
              COALESCE(SUM(CASE WHEN t.status IN ('pagado','usado') THEN t.amount_paid ELSE 0 END), 0)
                - (COUNT(CASE WHEN t.status IN ('pagado','usado') THEN t.id END) * p.commission) AS debe_enviar,
              ${yaRindioClause} AS ya_rindio
       FROM promotors p
       JOIN users u ON u.id = p.user_id AND u.is_active = 1
       LEFT JOIN zonas z ON z.id = p.zona_id
       LEFT JOIN users lu ON lu.id = p.leader_id
       ${ticketJoinClause}
       WHERE u.role != 'admin' AND p.promo_code != 'CASA' ${searchClause}
       ${ownerScopeClause}
       GROUP BY p.id, u.id, z.id, lu.id
       ORDER BY u.name ASC`,
      params
    );

    const rows = result.rows.map(r => ({
      ...r,
      saldo_pendiente: (r.debe_enviar || 0) - (r.ya_rindio || 0),
    }));

    // La caja va primera: es la plata que ya esta en la casa y es lo que
    // hacia que el total de la noche no cerrara. Si hay busqueda solo aparece
    // cuando el texto apunta a ella, para no meter ruido entre los resultados.
    const buscaCaja = !search || 'caja'.includes(search.trim().toLowerCase());
    if (buscaCaja) {
      const caja = await filaCaja(req, event_id);
      if (caja) rows.unshift(caja);
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener rendiciones' });
  }
};

// ¿Este usuario puede ver/modificar esta pública?
//
// El owner ya estaba acotado a su staff. El ADMIN no: el helper devolvia true
// para cualquier rol que no fuera owner, asi que un admin podia listar, abrir,
// registrar y borrar pagos de las publicas de OTRO admin. Verificado: admin B
// le registraba y borraba pagos a una publica del arbol de admin A.
// Ahora el admin queda acotado a su propio arbol, igual que ya pasa con
// entradas, eventos y links de portero.
async function puedeAccederPromotor(req, promotorId) {
  const rol = req.user?.role;
  const r = await db.query(
    `SELECT p.user_id, u.created_by AS lvl1, lvl2.created_by AS lvl2
       FROM promotors p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN users lvl2 ON lvl2.id = u.created_by
      WHERE p.id = ?`,
    [promotorId]
  );
  const row = r.rows[0];
  if (!row) return false;
  if (rol === 'owner') return row.lvl1 === req.user.id || row.lvl2 === req.user.id;
  if (rol === 'admin') return adminCanAccessUser(req.user.id, row.user_id);
  return false;
}

// GET /api/rendiciones/:promotorId — detalle de un publica
const getPublicaDetail = async (req, res) => {
  const { promotorId } = req.params;
  try {
    if (!(await puedeAccederPromotor(req, promotorId)))
      return res.status(403).json({ error: 'Sin acceso a esta pública' });
    // perfil
    const profileResult = await db.query(
      `SELECT p.id AS promotor_id,
              u.id AS user_id, u.name, u.apellido, u.celular, u.localidad, u.email,
              u.role, u.created_at,
              p.promo_code, p.commission, p.leader_commission,
              lu.id AS leader_id, lu.name AS leader_name
       FROM promotors p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN users lu ON lu.id = p.leader_id
       WHERE p.id = ?`,
      [promotorId]
    );
    const perfil = profileResult.rows[0];
    if (!perfil) return res.status(404).json({ error: 'Publica no encontrada' });

    // resumen por evento (incluye ya pagado por ese evento)
    const byEvent = await db.query(
      `SELECT e.id AS event_id, e.name AS evento, e.date,
              COUNT(CASE WHEN t.status IN ('pagado','usado') THEN t.id END) AS vendidas,
              COALESCE(SUM(CASE WHEN t.status IN ('pagado','usado') THEN t.amount_paid ELSE 0 END), 0) AS recaudado,
              COALESCE(SUM(CASE WHEN t.status IN ('pagado','usado') THEN t.amount_paid ELSE 0 END), 0)
                - (COUNT(CASE WHEN t.status IN ('pagado','usado') THEN t.id END) * ?) AS a_enviar,
              COALESCE(
                (SELECT SUM(r.amount) FROM rendiciones r
                 WHERE r.promotor_id = ? AND r.event_id = e.id), 0
              ) AS pagado_evento
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE t.promotor_id = ?
       GROUP BY e.id ORDER BY e.date DESC`,
      [perfil.commission, promotorId, promotorId]
    );

    // totales
    const totalsResult = await db.query(
      `SELECT COUNT(CASE WHEN t.status IN ('pagado','usado') THEN t.id END) AS total_vendidas,
              COALESCE(SUM(CASE WHEN t.status IN ('pagado','usado') THEN t.amount_paid ELSE 0 END), 0) AS total_recaudado
       FROM tickets t WHERE t.promotor_id = ?`,
      [promotorId]
    );
    const totals = totalsResult.rows[0];
    const comision_promotor = (totals.total_vendidas || 0) * perfil.commission;
    const debe_enviar = (totals.total_recaudado || 0) - comision_promotor;

    // rendiciones registradas
    const pagosResult = await db.query(
      `SELECT r.id, r.amount, r.note, r.created_at, e.name AS evento,
              cu.name AS created_by_name
       FROM rendiciones r
       LEFT JOIN events e ON e.id = r.event_id
       LEFT JOIN users cu ON cu.id = r.created_by
       WHERE r.promotor_id = ?
       ORDER BY r.created_at DESC`,
      [promotorId]
    );
    const ya_rindio = pagosResult.rows.reduce((acc, p) => acc + parseFloat(p.amount || 0), 0);

    // ultimas ventas
    const recent = await db.query(
      `SELECT t.id, t.buyer_name, t.buyer_apellido, t.amount_paid, t.status, t.created_at,
              e.name AS evento, tt.name AS tipo_entrada
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       WHERE t.promotor_id = ?
       ORDER BY t.created_at DESC LIMIT 50`,
      [promotorId]
    );

    res.json({
      perfil,
      totals: {
        total_vendidas: totals.total_vendidas || 0,
        total_recaudado: totals.total_recaudado || 0,
        comision_promotor,
        debe_enviar,
        ya_rindio,
        saldo_pendiente: debe_enviar - ya_rindio,
      },
      by_event: byEvent.rows,
      pagos: pagosResult.rows,
      recent: recent.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener detalle' });
  }
};

// POST /api/rendiciones — registrar pago
// Valida que el monto no exceda el saldo pendiente (global o por evento)
// para evitar errores tipo "registré 50.000 cuando solo debe 10.000".
const registrarPago = async (req, res) => {
  const { promotor_id, amount, note, event_id } = req.body;
  if (!promotor_id || !amount) return res.status(400).json({ error: 'Faltan datos' });
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0)
    return res.status(400).json({ error: 'El monto debe ser un numero mayor a 0' });

  try {
    if (!(await puedeAccederPromotor(req, promotor_id)))
      return res.status(403).json({ error: 'Sin acceso a esta pública' });
    // Calcular el saldo pendiente actual (global o filtrado por evento).
    // Reusa la misma logica que getPublicaDetail.
    const eventFilter = event_id ? 'AND t.event_id = ?' : '';
    const eventRendicionFilter = event_id ? 'AND event_id = ?' : '';
    const rendicionParams = event_id ? [promotor_id, event_id] : [promotor_id];

    const totals = (await db.query(
      `SELECT
         COUNT(CASE WHEN t.status IN ('pagado','usado') THEN t.id END) AS total_vendidas,
         COALESCE(SUM(CASE WHEN t.status IN ('pagado','usado') THEN t.amount_paid ELSE 0 END), 0) AS total_recaudado
       FROM tickets t
       WHERE t.promotor_id = ? ${eventFilter}`,
      event_id ? [promotor_id, event_id] : [promotor_id]
    )).rows[0];

    const promoResult = await db.query('SELECT commission FROM promotors WHERE id = ?', [promotor_id]);
    const commission = parseFloat(promoResult.rows[0]?.commission || 0);
    const debeEnviar = parseFloat(totals.total_recaudado || 0) - (parseInt(totals.total_vendidas || 0) * commission);

    const yaRindioResult = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS ya_rindio FROM rendiciones
       WHERE promotor_id = ? ${eventRendicionFilter}`,
      rendicionParams
    );
    const yaRindio = parseFloat(yaRindioResult.rows[0]?.ya_rindio || 0);
    const saldoPendiente = debeEnviar - yaRindio;

    // Tolerancia de $0.01 para evitar problemas de floating-point
    if (amountNum > saldoPendiente + 0.01) {
      return res.status(400).json({
        error: `El monto excede el saldo pendiente ($${saldoPendiente.toFixed(2)}). Si querés registrar un pago mayor, agregalo en notas o creá una nota de credito.`,
        saldo_pendiente: saldoPendiente,
      });
    }

    const id = uuidv4();
    await db.query(
      `INSERT INTO rendiciones (id, promotor_id, amount, note, event_id, created_by)
       VALUES (?,?,?,?,?,?)`,
      [id, promotor_id, amountNum, note || null, event_id || null, req.user.id]
    );
    res.status(201).json({ id, promotor_id, amount: amountNum, note, event_id, saldo_restante: saldoPendiente - amountNum });
  } catch (err) {
    console.error('registrarPago error:', err.message);
    res.status(500).json({ error: 'Error al registrar pago' });
  }
};

// DELETE /api/rendiciones/:id — borrar un pago
const eliminarPago = async (req, res) => {
  try {
    const r = await db.query('SELECT promotor_id FROM rendiciones WHERE id = ?', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Pago no encontrado' });
    if (!(await puedeAccederPromotor(req, r.rows[0].promotor_id)))
      return res.status(403).json({ error: 'Sin acceso a esta pública' });
    await db.query('DELETE FROM rendiciones WHERE id = ?', [req.params.id]);
    res.json({ message: 'Pago eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar pago' });
  }
};

module.exports = { listPublicas, getPublicaDetail, registrarPago, eliminarPago };
