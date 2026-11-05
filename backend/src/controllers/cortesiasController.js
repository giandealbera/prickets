const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { nuevoCodigoQR } = require('../utils/qrCode');
const { normalizeCity } = require('../utils/normalize');
const { eventoOperable } = require('../utils/eventStatus');

// POST /api/cortesias — admin genera N entradas de cortesia
// body: { event_id, ticket_type_id,
//         attendees: [{buyer_name, buyer_apellido, buyer_edad?, buyer_localidad?, buyer_email?}] }
const createCortesias = async (req, res) => {
  const { event_id, ticket_type_id, attendees } = req.body;

  if (!event_id || !ticket_type_id)
    return res.status(400).json({ error: 'Faltan datos del evento' });

  if (!Array.isArray(attendees) || attendees.length === 0)
    return res.status(400).json({ error: 'Cargá al menos una persona' });

  if (attendees.length > 50)
    return res.status(400).json({ error: 'Maximo 50 cortesias por vez' });

  // Igual que en el flujo publico: un invitado nulo tiraba TypeError y, por
  // ser handler async, mataba el proceso en vez de devolver un 400.
  for (const a of attendees) {
    if (!a || typeof a !== 'object')
      return res.status(400).json({ error: 'Datos de invitado inválidos' });
    if (!a.buyer_name || !a.buyer_apellido)
      return res.status(400).json({ error: 'Cada cortesia debe tener nombre y apellido' });
    if (String(a.buyer_name).length > 50 || String(a.buyer_apellido).length > 50)
      return res.status(400).json({ error: 'El nombre y apellido no deben superar los 50 caracteres' });
  }

  // Un evento finalizado o cancelado no recibe entradas nuevas, ni regaladas:
  // dejaria de ser el registro fiel de lo que paso esa noche.
  const estadoEv = await eventoOperable(event_id);
  if (!estadoEv.ok) return res.status(estadoEv.status).json({ error: estadoEv.message });

  // Owner solo puede emitir cortesias para SUS eventos.
  if (req.user.role === 'owner') {
    const own = await db.query('SELECT 1 FROM event_owners WHERE event_id = ? AND user_id = ?', [event_id, req.user.id]);
    if (!own.rows[0]) return res.status(403).json({ error: 'No sos dueño de este evento' });
  }

  try {
    // Buscar promotor CASA para asignar las cortesias
    const promo = await db.query("SELECT id FROM promotors WHERE promo_code = 'CASA'");
    const promotorId = promo.rows[0]?.id || null;

    const created = [];

    // Toda la emision va en una transaccion: revalidamos cupo DENTRO con
    // la fila locked, insertamos los tickets y subimos sold_count atomico.
    // Sin esto, dos admins emitiendo cortesias al mismo tiempo pueden ambos
    // ver cupo libre y oversold el evento.
    await db.transaction(async (conn) => {
      const [ttRows] = await conn.execute(
        'SELECT * FROM ticket_types WHERE id = ? AND event_id = ? FOR UPDATE',
        [ticket_type_id, event_id]
      );
      const tt = ttRows[0];
      if (!tt) throw new Error('TT_NOT_FOUND');
      const available = tt.total_quota - tt.sold_count;
      if (available < attendees.length) throw new Error(`NO_QUOTA:${available}`);

      for (const a of attendees) {
        const ticketId = uuidv4();
        const qrCode   = nuevoCodigoQR();
        await conn.execute(
          `INSERT INTO tickets
             (id, ticket_type_id, event_id, buyer_name, buyer_apellido, buyer_dni, buyer_edad, buyer_localidad, buyer_email,
              qr_code, payment_method, payment_ref, amount_paid, status, promotor_id, sold_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ticketId, ticket_type_id, event_id, a.buyer_name, a.buyer_apellido,
           a.buyer_dni || null,
           a.buyer_edad || null, normalizeCity(a.buyer_localidad) || null, a.buyer_email || '',
           qrCode, 'cortesia', 'CORTESIA', 0, 'pagado', promotorId, req.user.id]
        );
        created.push({
          id: ticketId, qr_code: qrCode,
          buyer_name: a.buyer_name, buyer_apellido: a.buyer_apellido,
          tipo_entrada: tt.name,
        });
      }

      await conn.execute(
        'UPDATE ticket_types SET sold_count = sold_count + ? WHERE id = ?',
        [attendees.length, ticket_type_id]
      );
    });

    res.status(201).json({ tickets: created });
  } catch (err) {
    if (err.message === 'TT_NOT_FOUND')
      return res.status(400).json({ error: 'Tipo de entrada no encontrado' });
    if (err.message?.startsWith('NO_QUOTA:'))
      return res.status(409).json({ error: `Solo quedan ${err.message.split(':')[1]} entradas disponibles` });
    console.error(err);
    res.status(500).json({ error: 'Error al crear cortesias' });
  }
};

module.exports = { createCortesias };
