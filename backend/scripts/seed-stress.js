/**
 * Stress test: carga 2000 tickets fake en un evento de prueba.
 * Uso: node scripts/seed-stress.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { v4: uuidv4 } = require('uuid');
const db = require('../src/config/database');
const { nuevoCodigoQR } = require('../src/utils/qrCode');

const NOMBRES = ['Juan', 'Pedro', 'Maria', 'Lucia', 'Sofia', 'Mateo', 'Tomas', 'Valentina', 'Lautaro', 'Camila',
                 'Agustin', 'Martina', 'Joaquin', 'Olivia', 'Bautista', 'Catalina', 'Benjamin', 'Emma', 'Santiago',
                 'Mia', 'Felipe', 'Isabella', 'Nicolas', 'Antonella', 'Maximo', 'Julieta', 'Thiago', 'Renata',
                 'Ignacio', 'Florencia'];

const APELLIDOS = ['Garcia', 'Rodriguez', 'Lopez', 'Martinez', 'Gonzalez', 'Perez', 'Sanchez', 'Romero', 'Diaz',
                   'Torres', 'Flores', 'Vargas', 'Castro', 'Ramos', 'Acosta', 'Medina', 'Rojas', 'Suarez',
                   'Mendez', 'Cabrera', 'Silva', 'Aguilar', 'Herrera', 'Molina', 'Vega', 'Reyes', 'Bravo',
                   'Ortiz', 'Cordoba', 'Salinas'];

const LOCALIDADES = ['San Juan', 'Mendoza', 'Cordoba', 'Rosario', 'Buenos Aires', 'La Plata', 'Salta', 'Tucuman',
                     'Neuquen', 'Bariloche', 'Rivadavia', 'Pocito', 'Chimbas', 'Rawson', 'Caucete', 'Albardon'];

const PAY_METHODS = ['efectivo', 'efectivo', 'efectivo', 'transferencia', 'transferencia', 'cortesia']; // bias
const STATUSES    = ['pagado', 'pagado', 'pagado', 'pagado', 'pagado', 'pagado', 'pagado', 'usado', 'usado', 'usado']; // 70/30

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function run() {
  console.log('Inicializando DB...');
  await db.initDb();

  const evNombre = 'Stress Test 2000';
  const ttNombre = 'General';
  const qty      = 2000;

  // 1. Buscar o crear evento
  let evRow = await db.query("SELECT id FROM events WHERE name = ?", [evNombre]);
  let eventId;
  if (evRow.rows[0]) {
    eventId = evRow.rows[0].id;
    console.log(`Evento existente: ${eventId}`);
  } else {
    eventId = uuidv4();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().substring(0, 10);
    await db.query(
      "INSERT INTO events (id, name, date, start_time, is_active) VALUES (?,?,?,?,1)",
      [eventId, evNombre, tomorrow, '22:00']
    );
    console.log(`Evento creado: ${eventId}`);
  }

  // 2. Buscar o crear ticket_type
  let ttRow = await db.query("SELECT id, sold_count FROM ticket_types WHERE event_id = ? AND name = ?", [eventId, ttNombre]);
  let ticketTypeId;
  let currentSold = 0;
  if (ttRow.rows[0]) {
    ticketTypeId = ttRow.rows[0].id;
    currentSold  = ttRow.rows[0].sold_count;
    // Garantizar cupo suficiente
    await db.query("UPDATE ticket_types SET total_quota = ? WHERE id = ?", [currentSold + qty + 100, ticketTypeId]);
    console.log(`Tipo existente: ${ticketTypeId} (sold=${currentSold})`);
  } else {
    ticketTypeId = uuidv4();
    await db.query(
      "INSERT INTO ticket_types (id, event_id, name, price, total_quota, sold_count, is_active) VALUES (?,?,?,?,?,?,1)",
      [ticketTypeId, eventId, ttNombre, 1000, qty + 500, 0]
    );
    console.log(`Tipo creado: ${ticketTypeId}`);
  }

  // 3. Buscar promotor CASA
  const casaRow = await db.query("SELECT id FROM promotors WHERE promo_code = 'CASA'");
  const promotorId = casaRow.rows[0]?.id;
  if (!promotorId) { console.error('No existe el promotor CASA. Arranca el server una vez para correr el seed.'); process.exit(1); }

  // 4. Insertar 2000 tickets en una transacción (mucho más rápido)
  console.log(`Insertando ${qty} tickets en una transaccion...`);
  const t0 = Date.now();

  await db.transaction(async (conn) => {
    for (let i = 0; i < qty; i++) {
      const id     = uuidv4();
      const qrCode = nuevoCodigoQR();
      const nombre   = pick(NOMBRES);
      const apellido = pick(APELLIDOS);
      const localidad = pick(LOCALIDADES);
      const edad     = rand(18, 50);
      const email    = Math.random() > 0.4 ? `${nombre.toLowerCase()}.${apellido.toLowerCase()}${i}@test.com` : '';
      const payment  = pick(PAY_METHODS);
      const status   = pick(STATUSES);
      const price    = payment === 'cortesia' ? 0 : 1000;
      const scannedAt = status === 'usado'
        ? new Date(Date.now() - rand(0, 7200000)).toISOString().replace('T', ' ').substring(0, 19)
        : null;

      await conn.execute(
        `INSERT INTO tickets
           (id, ticket_type_id, event_id, buyer_name, buyer_apellido, buyer_edad, buyer_localidad, buyer_email,
            qr_code, payment_method, payment_ref, amount_paid, status, promotor_id, scanned_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, ticketTypeId, eventId, nombre, apellido, String(edad), localidad, email,
         qrCode, payment, payment === 'cortesia' ? 'CORTESIA' : '', price, status, promotorId, scannedAt]
      );

      if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${qty}...`);
    }

    await conn.execute("UPDATE ticket_types SET sold_count = sold_count + ? WHERE id = ?", [qty, ticketTypeId]);
  });

  const elapsed = Date.now() - t0;
  console.log(`\n✓ OK: ${qty} tickets insertados en ${elapsed}ms (${Math.round(qty / (elapsed / 1000))}/s)`);
  console.log(`Evento: ${evNombre}  ·  Tipo: ${ttNombre}`);
  console.log('Login admin/admin123 y entra a /admin/control para verlos.');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
