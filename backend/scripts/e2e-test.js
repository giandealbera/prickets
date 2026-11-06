/**
 * E2E test de TODAS las funciones del backend contra un servidor local
 * con base SQLite temporal (no toca la base de desarrollo).
 *
 * Uso:
 *   1) Levantar el server de prueba:
 *        PORT=4100 DB_PATH=<tmp>/prickets-e2e.sqlite NODE_ENV=development node server.js
 *   2) Correr:
 *        E2E_URL=http://127.0.0.1:4100/api E2E_DB=<tmp>/prickets-e2e.sqlite node scripts/e2e-test.js
 *
 * El script imprime PASS/FAIL por check y sale con codigo 1 si algo fallo.
 */
const path = require('path');
const { authenticator } = require('otplib');
authenticator.options = { step: 30, window: 1 };

const BASE = process.env.E2E_URL || 'http://127.0.0.1:4100/api';

// Fecha/hora LOCAL sin marca de zona: es exactamente lo que manda un
// <input type="datetime-local">, que es como el frontend carga la ventana de
// venta. Antes esto usaba toISOString(), o sea UTC, y contra Postgres el
// driver devolvia esa hora leida como local: la ventana quedaba corrida 3
// horas y las ventas aparecian cerradas. Ningun cliente real manda UTC aca.
const fechaLocal = (offsetMs = 0) => {
  const d = new Date(Date.now() + offsetMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const DB_FILE = process.env.E2E_DB || path.join(__dirname, '../tmp-e2e/prickets-e2e.sqlite');

const ADMIN_EMAIL = 'gianfrancodealbera@gmail.com';
const ADMIN_PASS  = '43955952Gd';

// ---------------------------------------------------------------------------
// Infra de test
// ---------------------------------------------------------------------------
const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ->  ' + detail}`);
}

async function req(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* respuesta sin JSON */ }
  return { status: res.status, data };
}

function check(name, cond, detail) {
  record(name, !!cond, detail || 'condicion falsa');
}

// Acceso directo a la base de prueba para verificar estado interno
// (payments.method, normalizacion, reset_token).
let dbh = null;
// Acceso directo a la base, para verificar cosas que la API no expone a
// proposito (por ejemplo que reset_token se guarde hasheado).
//
// Habla los dos motores. Antes abria SQLite y nada mas, asi que corriendo la
// suite contra Postgres —que es lo que usa produccion— estas verificaciones
// devolvian undefined y daban falla sin que hubiera ningun bug. Peor: los
// bugs que SI son de Postgres quedaban tapados entre el ruido.
const PG = !!process.env.DATABASE_URL;
let pgPool = null;

async function pgQuery(sql, params) {
  if (!pgPool) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    });
  }
  // Mismos placeholders que usan los controllers: ? -> $1, $2, ...
  let n = 0;
  const texto = sql.replace(/\?/g, () => `$${++n}`);
  return pgPool.query(texto, params);
}

async function dbGet(sql, params = []) {
  if (PG) return (await pgQuery(sql, params)).rows[0];
  if (!dbh) {
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    dbh = await open({ filename: DB_FILE, driver: sqlite3.Database });
  }
  return dbh.get(sql, params);
}

async function dbRun(sql, params = []) {
  if (PG) return pgQuery(sql, params);
  if (!dbh) {
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    dbh = await open({ filename: DB_FILE, driver: sqlite3.Database });
  }
  return dbh.run(sql, params);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// DNI de prueba. Desde que es obligatorio en el flujo publico, cada
// comprador necesita el suyo, y el recupero del QR se hace con el.
const dni = (n) => String(30000000 + n);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
(async () => {
  // ---------- Salud ----------
  {
    const r = await req('GET', '/health');
    check('health: GET /health', r.status === 200 && r.data?.status === 'ok', JSON.stringify(r));
  }

  // ---------- Auth admin ----------
  let admin;
  {
    const bad = await req('POST', '/auth/login', { body: { email: ADMIN_EMAIL, password: 'incorrecta123' } });
    check('auth: login con password mala -> 401', bad.status === 401, `status=${bad.status}`);

    const r = await req('POST', '/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASS } });
    check('auth: login admin', r.status === 200 && r.data?.token, JSON.stringify(r.data));
    admin = r.data?.token;

    const me = await req('GET', '/auth/me', { token: admin });
    check('auth: GET /me admin', me.status === 200 && me.data?.role === 'admin', JSON.stringify(me.data));

    const noTok = await req('GET', '/auth/me');
    check('auth: /me sin token -> 401', noTok.status === 401, `status=${noTok.status}`);

    const badTok = await req('GET', '/auth/me', { token: 'basura.invalida.xxx' });
    check('auth: /me token invalido -> 403', badTok.status === 403, `status=${badTok.status}`);
  }

  // ---------- Zonas ----------
  let zonaId;
  {
    const c = await req('POST', '/zonas', { token: admin, body: { name: 'Zona Test' } });
    check('zonas: crear', c.status === 201 || c.status === 200, JSON.stringify(c));
    zonaId = c.data?.id;

    const l = await req('GET', '/zonas', { token: admin });
    check('zonas: listar', l.status === 200 && Array.isArray(l.data) && l.data.some(z => z.id === zonaId), JSON.stringify(l.data));

    const u = await req('PUT', `/zonas/${zonaId}`, { token: admin, body: { name: 'Zona Test 2' } });
    check('zonas: actualizar', u.status === 200, JSON.stringify(u));
  }

  // ---------- Proveedores ----------
  let provId;
  {
    const c = await req('POST', '/proveedores', { token: admin, body: { nombre: 'Prov', apellido: 'Uno', alias_cbu: 'alias.cbu' } });
    check('proveedores: crear', c.status === 201 || c.status === 200, JSON.stringify(c));
    provId = c.data?.id;

    const u = await req('PUT', `/proveedores/${provId}`, { token: admin, body: { nombre: 'Prov2' } });
    check('proveedores: actualizar', u.status === 200, JSON.stringify(u));

    const l = await req('GET', '/proveedores', { token: admin });
    check('proveedores: listar', l.status === 200 && Array.isArray(l.data), JSON.stringify(l.status));

    const d = await req('DELETE', `/proveedores/${provId}`, { token: admin });
    check('proveedores: borrar', d.status === 200, JSON.stringify(d));
  }

  // ---------- Usuarios: owner + staff ----------
  let ownerId, ownerTok, jefeId, jefeTok, vendId, vendCode, jefeCode;
  {
    const c = await req('POST', '/users', {
      token: admin,
      body: { name: 'Olga', apellido: 'Owner', email: 'owner@test.com', password: 'clave12345', role: 'owner', celular: '11 5555-0001' },
    });
    check('users: admin crea owner', c.status === 201, JSON.stringify(c.data));
    ownerId = c.data?.id;

    // Login owner: viene con must_change_password=1
    const lo = await req('POST', '/auth/login', { body: { email: 'owner@test.com', password: 'clave12345' } });
    check('users: login owner', lo.status === 200 && lo.data?.user?.must_change_password === true, JSON.stringify(lo.data?.user));
    ownerTok = lo.data?.token;

    // Esperar a que cambie el segundo: el iat del JWT es en segundos y el
    // middleware invalida solo tokens con iat ESTRICTAMENTE anterior al
    // cambio de clave. Si login y cambio caen en el mismo segundo, el
    // token viejo sobrevive (tradeoff correcto para no matar el token
    // nuevo emitido justo despues del cambio).
    await sleep(1100);

    // Cambio de clave sin currentPassword (permitido por must_change_password)
    const cp = await req('POST', '/auth/change-password', { token: ownerTok, body: { newPassword: 'claveOwner1' } });
    check('users: owner setea su clave (must_change)', cp.status === 200, JSON.stringify(cp));

    // El token viejo del owner quedo invalidado por password_changed_at
    const oldMe = await req('GET', '/auth/me', { token: ownerTok });
    check('auth: token previo al cambio de clave -> 403', oldMe.status === 403, `status=${oldMe.status}`);

    const lo2 = await req('POST', '/auth/login', { body: { email: 'owner@test.com', password: 'claveOwner1' } });
    check('users: re-login owner con clave nueva', lo2.status === 200, JSON.stringify(lo2.status));
    ownerTok = lo2.data?.token;

    // Owner crea jefe y vendedor
    const cj = await req('POST', '/users', {
      token: ownerTok,
      body: { name: 'Juan', apellido: 'Jefe', email: 'jefe@test.com', password: 'clave12345', role: 'jefe_publicas', zona_id: zonaId },
    });
    check('users: owner crea jefe_publicas', cj.status === 201 && cj.data?.promo_code, JSON.stringify(cj.data));
    jefeId = cj.data?.id;
    jefeCode = cj.data?.promo_code;

    const cv = await req('POST', '/users', {
      token: ownerTok,
      body: { name: 'Vicky', apellido: 'Vende', email: 'vend@test.com', password: 'clave12345', role: 'vendedor', celular: '+54 9 11 5555-0002' },
    });
    check('users: owner crea vendedor', cv.status === 201 && cv.data?.promo_code, JSON.stringify(cv.data));
    vendId = cv.data?.id;
    vendCode = cv.data?.promo_code;

    // Owner no puede crear otro owner
    const cx = await req('POST', '/users', {
      token: ownerTok,
      body: { name: 'X', email: 'x@test.com', password: 'clave12345', role: 'owner' },
    });
    check('users: owner NO puede crear owner -> 403', cx.status === 403, `status=${cx.status}`);

    // Listados con scope
    const la = await req('GET', '/users', { token: admin });
    check('users: admin lista SUS owners', la.status === 200 && la.data.some(u => u.id === ownerId) && !la.data.some(u => u.id === jefeId), JSON.stringify(la.data?.map(u => u.role)));

    const lo3 = await req('GET', '/users', { token: ownerTok });
    check('users: owner lista SU staff', lo3.status === 200 && lo3.data.some(u => u.id === jefeId) && lo3.data.some(u => u.id === vendId), JSON.stringify(lo3.data?.length));

    // Jefe entra con su clave (must_change) y arma equipo
    const lj = await req('POST', '/auth/login', { body: { email: 'jefe@test.com', password: 'clave12345' } });
    jefeTok = lj.data?.token;
    check('users: login jefe', lj.status === 200, JSON.stringify(lj.status));

    const tm = await req('POST', '/users/team', {
      token: jefeTok,
      body: { name: 'Tito', apellido: 'Team', email: 'tito@test.com', password: 'clave12345' },
    });
    check('team: jefe crea vendedor de equipo', tm.status === 201 && tm.data?.magic_token, JSON.stringify(tm.data));
    const titoMagic = tm.data?.magic_token;

    const myTeam = await req('GET', '/users/my-team', { token: jefeTok });
    check('team: jefe lista su equipo', myTeam.status === 200 && myTeam.data?.some?.(m => m.email === 'tito@test.com'), JSON.stringify(myTeam.data));

    // Magic login del vendedor de equipo: una sola vez
    const m1 = await req('GET', `/auth/magic/${titoMagic}`);
    check('magic: primer uso loguea', m1.status === 200 && m1.data?.token, JSON.stringify(m1.status));
    const m2 = await req('GET', `/auth/magic/${titoMagic}`);
    check('magic: segundo uso -> 404', m2.status === 404, `status=${m2.status}`);
  }

  // ---------- Eventos ----------
  let eventId, ttGeneralId, ttVipId, otherEventId, otherTtId;
  {
    const now = new Date();
    const in30d = new Date(now.getTime() + 30 * 86400000);
    const evBody = {
      name: 'Fiesta Test', description: 'evento e2e',
      date: in30d.toISOString().slice(0, 10), start_time: '23:30', end_time: '06:00',
      sale_start_at: fechaLocal(-3600000),
      sale_end_at: in30d.toISOString(),
    };
    const c = await req('POST', '/events', { token: ownerTok, body: { ...evBody, ticket_types: [ { name: 'General', price: 5000, total_quota: 20 }, { name: 'VIP', price: 10000, total_quota: 5 } ] } });
    check('events: owner crea evento con tipos', c.status === 201 && c.data?.id, JSON.stringify(c.data));
    eventId = c.data?.id;

    const tts = await req('GET', `/events/${eventId}/ticket-types`, { token: ownerTok });
    check('events: listar ticket-types', tts.status === 200 && tts.data?.length === 2, JSON.stringify(tts.data));
    ttGeneralId = tts.data?.find(t => t.name === 'General')?.id;
    ttVipId     = tts.data?.find(t => t.name === 'VIP')?.id;

    // Admin (arbol del owner) puede ver el evento
    const g = await req('GET', `/events/${eventId}`, { token: admin });
    check('events: admin del arbol ve el evento', g.status === 200, `status=${g.status}`);

    // Evento de OTRO admin (fuera del arbol) para tests anti cross-tenant
    const c2 = await req('POST', '/events', { token: admin, body: { ...evBody, name: 'Evento Admin', ticket_types: [{ name: 'Unica', price: 1000, total_quota: 10 }] } });
    check('events: admin crea evento propio', c2.status === 201, JSON.stringify(c2.status));
    otherEventId = c2.data?.id;
    const tts2 = await req('GET', `/events/${otherEventId}/ticket-types`, { token: admin });
    otherTtId = tts2.data?.[0]?.id;

    // Owner NO ve el evento del admin
    const gx = await req('GET', `/events/${otherEventId}`, { token: ownerTok });
    check('events: owner NO ve evento ajeno -> 403', gx.status === 403, `status=${gx.status}`);

    // Update de evento y de ticket type
    const u = await req('PUT', `/events/${eventId}`, { token: ownerTok, body: { description: 'editado' } });
    check('events: update', u.status === 200, JSON.stringify(u.status));

    const ut = await req('PUT', `/events/${eventId}/ticket-types/${ttGeneralId}`, { token: ownerTok, body: { add_quota: 5, price: 5500 } });
    check('events: update ticket-type (cupo+precio)', ut.status === 200 && Number(ut.data?.total_quota) === 25 && Number(ut.data?.price) === 5500, JSON.stringify(ut.data));

    const tg = await req('PATCH', `/events/${eventId}/ticket-types/${ttVipId}/toggle`, { token: ownerTok });
    check('events: toggle ticket-type', tg.status === 200, JSON.stringify(tg.status));
    const tg2 = await req('PATCH', `/events/${eventId}/ticket-types/${ttVipId}/toggle`, { token: ownerTok });
    check('events: re-toggle ticket-type', tg2.status === 200, JSON.stringify(tg2.status));

    // Owners del evento (solo admin)
    const ow = await req('GET', `/events/${eventId}/owners`, { token: admin });
    check('events: admin lista owners', ow.status === 200 && ow.data?.some?.(o => o.user_id === ownerId || o.id === ownerId), JSON.stringify(ow.data));
  }

  // ---------- Sellers por tipo ----------
  {
    const s = await req('PUT', `/events/${eventId}/ticket-types/${ttVipId}/sellers`, { token: ownerTok, body: { user_ids: [jefeId] } });
    check('sellers: restringir VIP al jefe', s.status === 200, JSON.stringify(s));

    const g = await req('GET', `/events/${eventId}/ticket-types/${ttVipId}/sellers`, { token: ownerTok });
    check('sellers: listar autorizados', g.status === 200 && g.data?.length === 1 && g.data[0].user_id === jefeId, JSON.stringify(g.data));

    // Vendedor (no autorizado) intenta vender VIP por link publico -> 403
    const pv = await req('POST', `/public/tickets/${vendCode}`, {
      body: { event_id: eventId, ticket_type_id: ttVipId, payment_method: 'efectivo', attendees: [{ buyer_name: 'No', buyer_apellido: 'Puede', buyer_dni: dni(10) }] },
    });
    check('sellers: vendedor no autorizado -> 403', pv.status === 403, `status=${pv.status}`);

    // Jefe autorizado si puede
    const pj = await req('POST', `/public/tickets/${jefeCode}`, {
      body: { event_id: eventId, ticket_type_id: ttVipId, payment_method: 'efectivo', attendees: [{ buyer_name: 'Vip', buyer_apellido: 'Uno', buyer_dni: dni(11) }] },
    });
    check('sellers: jefe autorizado vende VIP', pj.status === 201 && pj.data?.tickets?.length === 1, JSON.stringify(pj.data));

    // Abrir de nuevo (lista vacia = todos)
    const s2 = await req('PUT', `/events/${eventId}/ticket-types/${ttVipId}/sellers`, { token: ownerTok, body: { user_ids: [] } });
    check('sellers: reabrir a todos', s2.status === 200, JSON.stringify(s2.status));
  }

  // ---------- Venta manual ----------
  let manualTicketId, manualTicket2Id;
  {
    const c = await req('POST', '/tickets', {
      token: admin,
      body: { event_id: eventId, ticket_type_id: ttGeneralId, buyer_name: 'Mano', buyer_apellido: 'Uno', payment_method: 'efectivo', buyer_localidad: 'firmat' },
    });
    check('tickets: venta manual efectivo', c.status === 201 && c.data?.qr_code, JSON.stringify(c.data?.id));
    manualTicketId = c.data?.id;

    // Fix: localidad normalizada al guardar
    const row = await dbGet('SELECT buyer_localidad FROM tickets WHERE id = ?', [manualTicketId]);
    check('tickets: localidad normalizada (firmat -> Firmat)', row?.buyer_localidad === 'Firmat', JSON.stringify(row));

    // Fix: payments.method respeta el metodo real
    const c2 = await req('POST', '/tickets', {
      token: admin,
      body: { event_id: eventId, ticket_type_id: ttGeneralId, buyer_name: 'Mano', buyer_apellido: 'Dos', payment_method: 'transferencia' },
    });
    check('tickets: venta manual transferencia', c2.status === 201, JSON.stringify(c2.status));
    manualTicket2Id = c2.data?.id;
    const pay = await dbGet('SELECT method FROM payments WHERE ticket_id = ?', [manualTicket2Id]);
    check('tickets: payments.method = transferencia (fix)', pay?.method === 'transferencia', JSON.stringify(pay));

    // Metodo invalido
    const bad = await req('POST', '/tickets', {
      token: admin,
      body: { event_id: eventId, ticket_type_id: ttGeneralId, buyer_name: 'X', payment_method: 'cripto' },
    });
    check('tickets: metodo invalido -> 400', bad.status === 400, `status=${bad.status}`);

    // amount_paid siempre el precio canonico
    const t = await req('GET', `/tickets/${manualTicketId}`, { token: admin });
    check('tickets: getOne con precio canonico', t.status === 200 && Number(t.data?.amount_paid) === 5500, JSON.stringify(t.data?.amount_paid));

    const qr = await req('GET', `/tickets/${manualTicketId}/qr`, { token: admin });
    check('tickets: getQR', qr.status === 200 && qr.data?.qr_image?.startsWith('data:image'), JSON.stringify(qr.status));

    const all = await req('GET', `/tickets?event_id=${eventId}`, { token: admin });
    check('tickets: getAll por evento', all.status === 200 && all.data?.length >= 3, JSON.stringify(all.data?.length));

    // Owner ajeno no accede al ticket (IDOR)
    const tk2 = await req('GET', `/tickets?event_id=${otherEventId}`, { token: ownerTok });
    check('tickets: owner ajeno -> 403 (anti-IDOR)', tk2.status === 403, `status=${tk2.status}`);
  }

  // ---------- Pre-sell + completar reserva ----------
  let preIds = [];
  {
    const p = await req('POST', '/tickets/pre-sell', {
      token: admin,
      body: { event_id: eventId, ticket_type_id: ttGeneralId, qty: 3, payment_method: 'efectivo' },
    });
    check('pre-sell: reservar 3', p.status === 201 && p.data?.tickets?.length === 3, JSON.stringify(p.data));
    preIds = p.data?.tickets || [];

    const info = await req('GET', `/public/tickets-info?ids=${preIds.join(',')}`);
    check('pre-sell: tickets-info pendientes', info.status === 200 && info.data?.ticket_ids?.length === 3, JSON.stringify(info.data));

    // Completar 2 de 3
    const comp = await req('POST', '/public/tickets-complete/CASA', {
      body: {
        ticket_ids: preIds.slice(0, 2),
        attendees: [
          { buyer_name: 'Res', buyer_apellido: 'Uno', buyer_dni: dni(20), buyer_localidad: 'venado tuerto' },
          { buyer_name: 'Res', buyer_apellido: 'Dos', buyer_dni: dni(21) },
        ],
      },
    });
    check('pre-sell: completar 2 de 3', comp.status === 200 && comp.data?.tickets?.length === 2, JSON.stringify(comp.data));

    // Estado mixto: info devuelve solo el pendiente
    const info2 = await req('GET', `/public/tickets-info?ids=${preIds.join(',')}`);
    check('pre-sell: estado mixto devuelve 1 pendiente', info2.status === 200 && info2.data?.ticket_ids?.length === 1 && info2.data?.completed_count === 2, JSON.stringify(info2.data));

    // Completar el ultimo
    const comp2 = await req('POST', '/public/tickets-complete/CASA', {
      body: { ticket_ids: [info2.data.ticket_ids[0]], attendees: [{ buyer_name: 'Res', buyer_apellido: 'Tres', buyer_dni: dni(22) }] },
    });
    check('pre-sell: completar el ultimo', comp2.status === 200, JSON.stringify(comp2.status));

    // Con todas cargadas, el link sigue sirviendo y devuelve los QR: el
    // comprador puede reabrirlo o refrescar y ver sus entradas, en vez del
    // 410 con "ya fueron cargadas" que mostraba antes.
    const info3 = await req('GET', `/public/tickets-info?ids=${preIds.join(',')}`);
    check('pre-sell: todo completo -> el link devuelve los QR',
          info3.status === 200 && info3.data?.status === 'completed' && info3.data?.tickets?.length === 3,
          JSON.stringify(info3.data));
  }

  // ---------- Compra publica ----------
  let pubTickets = [];
  {
    const promo = await req('GET', `/public/promotor/${vendCode.toLowerCase()}`);
    check('public: info promotor (case-insensitive)', promo.status === 200 && promo.data?.promo_code === vendCode, JSON.stringify(promo.data));

    const evs = await req('GET', '/public/events');
    check('public: eventos activos con cupo', evs.status === 200 && evs.data?.some?.(e => e.id === eventId), JSON.stringify(evs.data?.length));

    // --- El catalogo publico no muestra basura -------------------------
    // Filtraba solo por is_active: en produccion el comprador veia 20
    // eventos, 19 ya pasados y la mayoria fixtures de prueba. Tenia que
    // adivinar cual era la fiesta de verdad.
    {
      const hace30   = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const dentro30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

      const viejo = await req('POST', '/events', { token: admin, body: {
        name: 'Fiesta del mes pasado', date: hace30, start_time: '23:00',
        ticket_types: [{ name: 'General', price: 1000, total_quota: 50 }] } });
      const cancelado = await req('POST', '/events', { token: admin, body: {
        name: 'Fiesta cancelada', date: dentro30, start_time: '23:00',
        ticket_types: [{ name: 'General', price: 1000, total_quota: 50 }] } });
      await req('PUT', `/events/${cancelado.data?.id}`, { token: admin, body: { status: 'CANCELLED' } });

      const cat = await req('GET', '/public/events');
      const ids = (cat.data || []).map(e => e.id);
      check('public: no lista eventos ya pasados',
            !ids.includes(viejo.data?.id), `aparecio ${viejo.data?.id}`);
      check('public: no lista eventos cancelados',
            !ids.includes(cancelado.data?.id), `aparecio ${cancelado.data?.id}`);
      check('public: el evento vigente sigue estando',
            ids.includes(eventId), `falta ${eventId}`);
    }

    const buy = await req('POST', `/public/tickets/${vendCode}`, {
      body: {
        event_id: eventId, ticket_type_id: ttGeneralId, payment_method: 'transferencia',
        attendees: [
          { buyer_name: 'Compra', buyer_apellido: 'Uno', buyer_dni: dni(1), buyer_edad: '25', buyer_localidad: 'rosario' },
          { buyer_name: 'Compra', buyer_apellido: 'Dos', buyer_dni: dni(2), buyer_email: 'dos@mail.com' },
        ],
      },
    });
    check('public: compra 2 entradas por link', buy.status === 201 && buy.data?.tickets?.length === 2, JSON.stringify(buy.data));
    pubTickets = buy.data?.tickets || [];

    // Sin cupo: pedir mas de lo disponible en VIP (quota 5, 1 vendida)
    const noQ = await req('POST', `/public/tickets/${vendCode}`, {
      body: {
        event_id: eventId, ticket_type_id: ttVipId, payment_method: 'efectivo',
        attendees: Array.from({ length: 5 }, (_, i) => ({ buyer_name: 'Q', buyer_apellido: `N${i}`, buyer_dni: dni(30 + i) })),
      },
    });
    check('public: oversell -> 409', noQ.status === 409, `status=${noQ.status}`);

    // Codigo inexistente
    const nf = await req('POST', '/public/tickets/NOEXISTE99', {
      body: { event_id: eventId, ticket_type_id: ttGeneralId, attendees: [{ buyer_name: 'A', buyer_apellido: 'B', buyer_dni: dni(40) }] },
    });
    check('public: codigo invalido -> 404', nf.status === 404, `status=${nf.status}`);

    // Recover: nombre + apellido + DNI. El DNI es la clave que impide que un
    // tercero se baje el QR de otro sabiendo solo como se llama.
    const rec = await req('POST', `/public/recover/${vendCode}`, { body: { nombre: 'compra', apellido: 'uno', dni: dni(1) } });
    check('public: recover encuentra el QR con el DNI correcto', rec.status === 200 && rec.data?.tickets?.length === 1, JSON.stringify(rec.data));

    const rec2 = await req('POST', `/public/recover/${vendCode}`, { body: { nombre: 'Compra', apellido: 'Uno', dni: '99999999' } });
    check('public: recover con DNI equivocado no devuelve nada', rec2.status === 200 && rec2.data?.tickets?.length === 0, JSON.stringify(rec2.data));

    const rec3 = await req('POST', `/public/recover/${vendCode}`, { body: { nombre: 'Compra', apellido: 'Dos' } });
    check('public: recover sin DNI -> 400', rec3.status === 400, `status=${rec3.status}`);

    // Autocomplete localidades
    const loc = await req('GET', '/public/localidades?q=ros');
    check('public: localidades sugiere Rosario', loc.status === 200 && loc.data?.items?.some?.(i => i.value.startsWith('Rosario')), JSON.stringify(loc.data));
  }

  // ---------- Ventana de venta ----------
  {
    const stop = await req('POST', `/events/${eventId}/stop-sales`, { token: ownerTok });
    check('saleWindow: stop-sales', stop.status === 200, JSON.stringify(stop.status));

    const buy = await req('POST', `/public/tickets/${vendCode}`, {
      body: { event_id: eventId, ticket_type_id: ttGeneralId, payment_method: 'efectivo', attendees: [{ buyer_name: 'Cerrado', buyer_apellido: 'X', buyer_dni: dni(41) }] },
    });
    check('saleWindow: compra con venta cortada -> 400', buy.status === 400, `status=${buy.status}`);

    const resume = await req('POST', `/events/${eventId}/resume-sales`, { token: ownerTok });
    check('saleWindow: resume-sales', resume.status === 200, JSON.stringify(resume.status));
  }

  // ---------- Cortesias ----------
  let cortesiaTicket;
  {
    const c = await req('POST', '/cortesias', {
      token: ownerTok,
      body: { event_id: eventId, ticket_type_id: ttGeneralId, attendees: [{ buyer_name: 'Gratis', buyer_apellido: 'Uno' }] },
    });
    check('cortesias: owner emite 1', c.status === 201 && c.data?.tickets?.length === 1, JSON.stringify(c.data));
    cortesiaTicket = c.data?.tickets?.[0];

    const row = await dbGet('SELECT payment_method, amount_paid, status FROM tickets WHERE id = ?', [cortesiaTicket?.id]);
    check('cortesias: metodo=cortesia, monto=0, pagado', row?.payment_method === 'cortesia' && Number(row?.amount_paid) === 0 && row?.status === 'pagado', JSON.stringify(row));

    // Owner no puede emitir para evento ajeno
    const cx = await req('POST', '/cortesias', {
      token: ownerTok,
      body: { event_id: otherEventId, ticket_type_id: otherTtId, attendees: [{ buyer_name: 'No', buyer_apellido: 'Va' }] },
    });
    check('cortesias: evento ajeno -> 403', cx.status === 403, `status=${cx.status}`);
  }

  // ---------- Escaneo admin ----------
  {
    const qr = pubTickets[0]?.qr_code;
    const s1 = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: qr } });
    check('scan admin: entrada valida', s1.status === 200 && s1.data?.valid === true, JSON.stringify(s1.data));

    const s2 = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: qr } });
    check('scan admin: re-escaneo -> 409', s2.status === 409 && s2.data?.valid === false, JSON.stringify(s2.status));

    const s3 = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: 'PRICKETS-NOEXISTE' } });
    check('scan admin: QR inexistente -> 404', s3.status === 404, `status=${s3.status}`);

    // Filtro por tipo: escanear un General con filtro VIP -> 403
    const s4 = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: pubTickets[1]?.qr_code, ticket_type_id: ttVipId } });
    check('scan admin: tipo incorrecto -> 403', s4.status === 403, `status=${s4.status}`);

    // El owner SI puede escanear desde el panel, pero solo en SUS eventos.
    // Antes la ruta exigia rol admin y al owner cada lectura le devolvia
    // "Se requiere rol: admin" aunque la pantalla se le mostrara.
    // Usamos la entrada YA escaneada arriba: alcanza para ver que el rechazo
    // viene del estado del ticket (409) y no del rol, sin consumir una
    // entrada que necesitan los tests del escaner publico.
    const s5 = await req('POST', '/tickets/scan', { token: ownerTok, body: { qr_code: qr } });
    check('scan admin: el owner del evento ya no recibe "se requiere rol"',
          s5.status === 409 && !/se requiere rol/i.test(s5.data?.error || ''),
          `status=${s5.status} ${JSON.stringify(s5.data?.error)}`);
  }

  // ---------- Scanner tokens + escaneo publico ----------
  {
    const c = await req('POST', '/scanner-tokens', { token: ownerTok, body: { event_id: eventId, all_types: true, label: 'Puerta 1' } });
    check('scanner: owner crea link todos-los-tipos', c.status === 201 && c.data?.token, JSON.stringify(c.data));
    const tok = c.data?.token;

    const info = await req('GET', `/scan/${tok}`);
    check('scanner: info publica del link', info.status === 200 && info.data?.event_name === 'Fiesta Test', JSON.stringify(info.data));

    const s1 = await req('POST', `/scan/${tok}`, { body: { qr_code: pubTickets[1]?.qr_code } });
    check('scanner publico: entrada valida', s1.status === 200 && s1.data?.valid === true, JSON.stringify(s1.data));

    const s2 = await req('POST', `/scan/${tok}`, { body: { qr_code: pubTickets[1]?.qr_code } });
    check('scanner publico: re-escaneo -> 409', s2.status === 409, `status=${s2.status}`);

    // Link de tipo restringido: solo VIP
    const cv = await req('POST', '/scanner-tokens', { token: ownerTok, body: { event_id: eventId, ticket_type_ids: [ttVipId], label: 'Puerta VIP' } });
    const tokVip = cv.data?.token;
    const s3 = await req('POST', `/scan/${tokVip}`, { body: { qr_code: cortesiaTicket?.qr_code } });
    check('scanner publico: tipo no aceptado -> 400', s3.status === 400, `status=${s3.status}`);

    // Ticket de otro evento
    const s4 = await req('POST', `/scan/${tok}`, { body: { qr_code: 'PRICKETS-XXXXXXXX' } });
    check('scanner publico: QR inexistente -> 404', s4.status === 404, `status=${s4.status}`);

    // Listado + scope: owner ve los suyos, admin del arbol tambien
    const l = await req('GET', `/scanner-tokens?event_id=${eventId}`, { token: ownerTok });
    check('scanner: owner lista sus links', l.status === 200 && l.data?.length >= 2, JSON.stringify(l.data?.length));
    const la = await req('GET', `/scanner-tokens?event_id=${eventId}`, { token: admin });
    check('scanner: admin del arbol lista links (scope nuevo)', la.status === 200, `status=${la.status}`);

    // Desactivar link
    const d = await req('DELETE', `/scanner-tokens/${cv.data?.id}`, { token: ownerTok });
    check('scanner: desactivar link', d.status === 200, JSON.stringify(d.status));
    const s5 = await req('POST', `/scan/${tokVip}`, { body: { qr_code: cortesiaTicket?.qr_code } });
    check('scanner: link desactivado -> 403', s5.status === 403, `status=${s5.status}`);
  }

  // ---------- Rendiciones ----------
  {
    const l = await req('GET', '/rendiciones', { token: ownerTok });
    check('rendiciones: listado publicas', l.status === 200, `status=${l.status}`);

    // Detalle del vendedor con ventas
    const vendPromo = await dbGet('SELECT id FROM promotors WHERE user_id = ?', [vendId]);
    const det = await req('GET', `/rendiciones/${vendPromo?.id}`, { token: ownerTok });
    check('rendiciones: detalle de publica', det.status === 200, `status=${det.status}`);

    const pago = await req('POST', '/rendiciones', { token: ownerTok, body: { promotor_id: vendPromo?.id, amount: 5000, note: 'rinde e2e', event_id: eventId } });
    check('rendiciones: registrar pago', pago.status === 201 || pago.status === 200, JSON.stringify(pago.data));
    const pagoId = pago.data?.id;

    const del = await req('DELETE', `/rendiciones/${pagoId}`, { token: ownerTok });
    check('rendiciones: eliminar pago', del.status === 200, JSON.stringify(del.status));

    // --- La caja aparece en el listado -------------------------------
    // Lo que emite el admin o el dueño quedaba afuera (promotor CASA o
    // promotor_id nulo) y esa plata no se veia en ningun lado: el total de
    // la noche no cerraba. Ahora va como una fila mas, arriba de todo.
    {
      // Evento propio para este bloque: con cupo de sobra los numeros de la
      // caja son exactos y no dependen de lo que vendieron los checks de
      // arriba.
      const dentroDe30 = new Date(Date.now() + 30 * 86400000);
      const evCaja = await req('POST', '/events', { token: ownerTok, body: {
        name: 'Evento Caja', date: dentroDe30.toISOString().slice(0, 10), start_time: '23:30',
        sale_start_at: fechaLocal(-3600000), sale_end_at: dentroDe30.toISOString(),
        ticket_types: [{ name: 'General', price: 5000, total_quota: 200 }] } });
      const evCajaId = evCaja.data?.id;
      const ttCaja = (await req('GET', `/events/${evCajaId}/ticket-types`, { token: ownerTok })).data?.[0]?.id;
      check('caja: evento de prueba creado', !!evCajaId && !!ttCaja, JSON.stringify(evCaja.data));

      const url = `/rendiciones?event_id=${evCajaId}`;

      // Sin movimiento no ensuciamos el listado con una fila en cero.
      const vacio = await req('GET', url, { token: ownerTok });
      check('caja: sin ventas no aparece', !(vacio.data || []).some(p => p.es_caja),
            `filas=${(vacio.data || []).map(p => p.name).join(', ')}`);

      // El admin genera 2 entradas de $5.000 desde la caja.
      const pre = await req('POST', '/tickets/pre-sell', { token: admin, body: {
        event_id: evCajaId, ticket_type_id: ttCaja, qty: 2, payment_method: 'efectivo' } });
      check('caja: el admin genera 2 entradas', pre.status === 201, JSON.stringify(pre.data));

      const lista = await req('GET', url, { token: ownerTok });
      const caja = (lista.data || []).find(p => p.es_caja);
      check('caja: aparece en el listado de rendiciones', !!caja,
            `filas=${(lista.data || []).map(p => p.name).join(', ')}`);
      check('caja: va primera', lista.data?.[0]?.es_caja === true,
            `primera=${lista.data?.[0]?.name}`);
      check('caja: cuenta las 2 entradas del admin', Number(caja?.total_vendidas) === 2,
            `vendidas=${caja?.total_vendidas}`);
      check('caja: suma los $10.000', parseFloat(caja?.total_recaudado) === 10000,
            `recaudado=${caja?.total_recaudado}`);
      // No es una publica: nadie rinde esta plata, ya esta en la casa.
      check('caja: no queda como deuda', Number(caja?.saldo_pendiente) === 0,
            `saldo=${caja?.saldo_pendiente}`);

      // El dueño no tiene ficha de promotor: sus entradas van con
      // promotor_id nulo y tambien se perdian.
      const preOwner = await req('POST', '/tickets/pre-sell', { token: ownerTok, body: {
        event_id: evCajaId, ticket_type_id: ttCaja, qty: 1, payment_method: 'efectivo' } });
      check('caja: el dueño genera 1 entrada', preOwner.status === 201, JSON.stringify(preOwner.data));
      const cajaO = ((await req('GET', url, { token: ownerTok })).data || []).find(p => p.es_caja);
      check('caja: tambien cuenta lo del dueño', Number(cajaO?.total_vendidas) === 3,
            `vendidas=${cajaO?.total_vendidas}`);
      check('caja: y su plata', parseFloat(cajaO?.total_recaudado) === 15000,
            `recaudado=${cajaO?.total_recaudado}`);

      // Las cortesias son $0: se cuentan aparte para no inflar "vendidas".
      const cort = await req('POST', '/cortesias', { token: admin, body: {
        event_id: evCajaId, ticket_type_id: ttCaja,
        attendees: [{ buyer_name: 'Corte', buyer_apellido: 'Sia' }] } });
      check('caja: cortesia creada', cort.status === 201 || cort.status === 200, JSON.stringify(cort.data));
      const caja2 = ((await req('GET', url, { token: ownerTok })).data || []).find(p => p.es_caja);
      check('caja: la cortesia se cuenta aparte', Number(caja2?.cortesias) === 1,
            `cortesias=${caja2?.cortesias}`);
      check('caja: la cortesia no infla las vendidas', Number(caja2?.total_vendidas) === 3,
            `vendidas=${caja2?.total_vendidas}`);
      check('caja: la cortesia no suma plata', parseFloat(caja2?.total_recaudado) === 15000,
            `recaudado=${caja2?.total_recaudado}`);

      // No se puede abrir ni cobrarle a la caja: no es una persona.
      const detCaja = await req('GET', '/rendiciones/caja', { token: ownerTok });
      check('caja: no tiene detalle -> 403/404', [403, 404].includes(detCaja.status),
            `status=${detCaja.status}`);
      const pagoCaja = await req('POST', '/rendiciones', { token: ownerTok, body: {
        promotor_id: 'caja', amount: 100, event_id: evCajaId } });
      check('caja: no se le puede registrar un pago', pagoCaja.status === 403,
            `status=${pagoCaja.status}`);

      // Con busqueda de una persona no tiene que ensuciar los resultados.
      const busq = await req('GET', '/rendiciones?search=zzzz', { token: ownerTok });
      check('caja: no aparece al buscar a otro', !(busq.data || []).some(p => p.es_caja),
            `filas=${busq.data?.length}`);
    }
  }

  // ---------- CORS: www y el dominio pelado ----------
  // FRONTEND_URL lista los origins permitidos. www y el apex son el mismo
  // sitio pero origins distintos, y olvidarse uno rompe la app en silencio:
  // el navegador no distingue CORS de falta de red, asi que se ve como "sin
  // conexion". Paso en produccion. El server agrega el par automaticamente.
  {
    const pedirConOrigin = async (origin) => {
      const r = await fetch(`${BASE}/health`, { headers: { Origin: origin } });
      return r.headers.get('access-control-allow-origin');
    };

    // El de la config (default en la suite: http://localhost:5173)
    check('cors: el origin configurado pasa',
          await pedirConOrigin('http://localhost:5173') === 'http://localhost:5173',
          'no devolvio el header');

    // Su par con www, que nadie configuro a mano
    check('cors: su par con www tambien pasa',
          await pedirConOrigin('http://www.localhost:5173') === 'http://www.localhost:5173',
          'el par www quedo afuera');

    // Un dominio ajeno sigue sin pasar: el par no es una barra libre
    check('cors: un origin ajeno sigue bloqueado',
          !(await pedirConOrigin('https://sitio-ajeno.example')),
          'dejo pasar un origin que no esta configurado');
  }

  // ---------- Reportes ----------
  {
    const r = await req('GET', '/payments/report', { token: admin });
    check('reportes: payments report', r.status === 200, `status=${r.status}`);

    const m = await req('GET', '/payments/monthly-overview', { token: ownerTok });
    check('reportes: monthly overview owner', m.status === 200, `status=${m.status}`);

    const st = await req('GET', `/events/${eventId}/stats`, { token: ownerTok });
    check('reportes: stats del evento', st.status === 200, `status=${st.status}`);

    const bs = await req('GET', `/events/${eventId}/buyer-stats`, { token: ownerTok });
    check('reportes: buyer-stats demograficas', bs.status === 200, `status=${bs.status}`);

    const h = await req('GET', '/events/history', { token: ownerTok });
    check('reportes: historial de eventos', h.status === 200, `status=${h.status}`);

    const ex = await req('GET', `/events/${eventId}/export-data`, { token: ownerTok });
    check('reportes: export-data owner', ex.status === 200, `status=${ex.status}`);

    const exAdmin = await req('GET', `/events/${eventId}/export-data`, { token: admin });
    check('reportes: export-data admin -> 403 (solo owner)', exAdmin.status === 403, `status=${exAdmin.status}`);

    const ps = await req('GET', '/users/promoter-sales', { token: ownerTok });
    check('reportes: promoter-sales', ps.status === 200, `status=${ps.status}`);

    const ms = await req('GET', '/users/my-sales', { token: jefeTok });
    check('reportes: my-sales jefe', ms.status === 200, `status=${ms.status}`);
  }

  // ---------- Audit log ----------
  {
    const r = await req('GET', '/audit-log?limit=50', { token: admin });
    const rows = r.data?.rows || r.data || [];
    check('audit: listado con eventos', r.status === 200 && rows.length > 0, JSON.stringify(r.status));
  }

  // ---------- Borrar ticket libera cupo ----------
  {
    const before = await dbGet('SELECT sold_count FROM ticket_types WHERE id = ?', [ttGeneralId]);
    const d = await req('DELETE', `/tickets/${manualTicket2Id}`, { token: ownerTok });
    check('tickets: owner borra ticket', d.status === 200, JSON.stringify(d.status));
    const after = await dbGet('SELECT sold_count FROM ticket_types WHERE id = ?', [ttGeneralId]);
    check('tickets: sold_count liberado al borrar', after?.sold_count === before?.sold_count - 1, `antes=${before?.sold_count} despues=${after?.sold_count}`);
  }

  // ---------- Sesiones ----------
  {
    const l = await req('GET', '/sessions', { token: ownerTok });
    check('sessions: listar con is_current', l.status === 200 && l.data?.rows?.some?.(s => s.is_current), JSON.stringify(l.data?.rows?.length));

    // Logout revoca la sesion actual (mejora nueva)
    const lg = await req('POST', '/sessions/logout', { token: ownerTok });
    check('sessions: logout server-side', lg.status === 200, JSON.stringify(lg));
    const me = await req('GET', '/auth/me', { token: ownerTok });
    check('sessions: token post-logout -> 403 revocado', me.status === 403, `status=${me.status}`);

    const re = await req('POST', '/auth/login', { body: { email: 'owner@test.com', password: 'claveOwner1' } });
    ownerTok = re.data?.token;
    check('sessions: re-login post-logout', re.status === 200, `status=${re.status}`);

    // revoke-others
    const extra = await req('POST', '/auth/login', { body: { email: 'owner@test.com', password: 'claveOwner1' } });
    const extraTok = extra.data?.token;
    const ro = await req('POST', '/sessions/revoke-others', { token: ownerTok });
    check('sessions: revoke-others', ro.status === 200, JSON.stringify(ro.status));
    const meExtra = await req('GET', '/auth/me', { token: extraTok });
    check('sessions: la otra sesion quedo revocada', meExtra.status === 403, `status=${meExtra.status}`);
    const meCur = await req('GET', '/auth/me', { token: ownerTok });
    check('sessions: la actual sigue viva', meCur.status === 200, `status=${meCur.status}`);
  }

  // ---------- Recupero de contraseña ----------
  {
    // Requiere MAIL_DEV_STUB=1 (o RESEND_API_KEY): sin proveedor de mail
    // configurado el endpoint responde 503 a proposito, para no dejar al
    // usuario esperando un correo que no va a salir.
    const f = await req('POST', '/auth/forgot-password', { body: { email: 'vend@test.com' } });
    check('forgot: respuesta generica', f.status === 200, JSON.stringify(f.data));

    // En la base va el HASH del token, no el token: si se filtra una copia de
    // la base, los resets en curso no sirven para entrar. Por eso el test no
    // puede leer el valor y usarlo — inventa uno, guarda su hash y usa el
    // original, que es exactamente lo que hace el link del mail.
    const guardado = await dbGet('SELECT reset_token FROM users WHERE email = ?', ['vend@test.com']);
    check('forgot: el token guardado es un hash sha256, no el token en claro',
          /^[a-f0-9]{64}$/.test(guardado?.reset_token || ''), JSON.stringify(guardado));

    const crypto = require('crypto');
    const tokenClaro = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(tokenClaro).digest('hex');
    const vence = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await dbRun('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE email = ?',
                [hash, vence, 'vend@test.com']);

    const chk = await req('GET', `/auth/reset-password/${tokenClaro}`);
    check('forgot: el link se valida antes de pedir la clave nueva',
          chk.status === 200 && chk.data?.valid === true, JSON.stringify(chk.data));

    const rp = await req('POST', '/auth/reset-password', { body: { token: tokenClaro, password: 'nuevaClave9' } });
    check('forgot: reset con token valido', rp.status === 200, JSON.stringify(rp.data));

    const rl = await req('POST', '/auth/login', { body: { email: 'vend@test.com', password: 'nuevaClave9' } });
    check('forgot: login con clave nueva', rl.status === 200, `status=${rl.status}`);

    const rp2 = await req('POST', '/auth/reset-password', { body: { token: tokenClaro, password: 'otraClave99' } });
    check('forgot: token de reset es de un solo uso', rp2.status === 400, `status=${rp2.status}`);

    // Por celular+apellido (vendedora Vicky Vende, cel +54 9 11 5555-0002)
    const fp = await req('POST', '/auth/forgot-password-phone', { body: { celular: '5491155550002', apellido: 'vende' } });
    check('forgot-phone: matchea celular normalizado + apellido', fp.status === 200 && fp.data?.ok === true && fp.data?.magic_path, JSON.stringify(fp.data));
    const magicTok = fp.data?.magic_path?.split('/').pop();
    const ml = await req('GET', `/auth/magic/${magicTok}`);
    check('forgot-phone: magic login funciona', ml.status === 200 && ml.data?.token, `status=${ml.status}`);

    const fpBad = await req('POST', '/auth/forgot-password-phone', { body: { celular: '5491155550002', apellido: 'otro' } });
    check('forgot-phone: apellido incorrecto -> generico', fpBad.status === 200 && fpBad.data?.ok === false, JSON.stringify(fpBad.data));
  }

  // ---------- 2FA ----------
  {
    const setup = await req('GET', '/auth/2fa/setup', { token: ownerTok });
    check('2fa: setup devuelve secreto y QR', setup.status === 200 && setup.data?.secret && setup.data?.qr_data_url, JSON.stringify(setup.status));
    const secret = setup.data?.secret;

    const badEnable = await req('POST', '/auth/2fa/enable', { token: ownerTok, body: { token: '000000' } });
    check('2fa: enable con codigo malo -> 401', badEnable.status === 401, `status=${badEnable.status}`);

    const code = authenticator.generate(secret);
    const en = await req('POST', '/auth/2fa/enable', { token: ownerTok, body: { token: code } });
    check('2fa: enable con TOTP valido', en.status === 200 && en.data?.recovery_codes?.length === 10, JSON.stringify(en.status));
    const recovery = en.data?.recovery_codes || [];

    // Login ahora pide 2FA
    const lg = await req('POST', '/auth/login', { body: { email: 'owner@test.com', password: 'claveOwner1' } });
    check('2fa: login devuelve needs_2fa', lg.status === 200 && lg.data?.needs_2fa === true && lg.data?.partial_token, JSON.stringify(lg.data));

    const ver = await req('POST', '/auth/2fa/verify', { body: { partial_token: lg.data?.partial_token, code: authenticator.generate(secret) } });
    check('2fa: verify con TOTP emite JWT', ver.status === 200 && ver.data?.token, `status=${ver.status}`);
    ownerTok = ver.data?.token;

    // Login + verify con recovery code
    const lg2 = await req('POST', '/auth/login', { body: { email: 'owner@test.com', password: 'claveOwner1' } });
    const ver2 = await req('POST', '/auth/2fa/verify', { body: { partial_token: lg2.data?.partial_token, code: recovery[0] } });
    check('2fa: verify con recovery code', ver2.status === 200 && ver2.data?.token, `status=${ver2.status}`);
    const ver3 = await req('POST', '/auth/2fa/verify', { body: { partial_token: lg2.data?.partial_token, code: recovery[0] } });
    check('2fa: recovery code es de un solo uso', ver3.status === 401, `status=${ver3.status}`);

    const st = await req('GET', '/auth/2fa/status', { token: ownerTok });
    check('2fa: status enabled', st.status === 200 && st.data?.enabled === true, JSON.stringify(st.data));

    const dis = await req('POST', '/auth/2fa/disable', { token: ownerTok, body: { password: 'claveOwner1', token: authenticator.generate(secret) } });
    check('2fa: disable con password+TOTP', dis.status === 200, JSON.stringify(dis.data));

    const lg3 = await req('POST', '/auth/login', { body: { email: 'owner@test.com', password: 'claveOwner1' } });
    check('2fa: login sin 2FA tras disable', lg3.status === 200 && lg3.data?.token && !lg3.data?.needs_2fa, JSON.stringify(lg3.status));
    ownerTok = lg3.data?.token;
  }

  // ---------- Clonar y resetear evento ----------
  {
    const in60d = new Date(Date.now() + 60 * 86400000);
    const cl = await req('POST', `/events/${eventId}/clone`, {
      token: ownerTok,
      body: {
        name: 'Fiesta Test (clon)',
        date: in60d.toISOString().slice(0, 10),
        start_time: '23:30',
        sale_start_at: fechaLocal(0),
        sale_end_at: in60d.toISOString(),
      },
    });
    check('events: clonar evento', (cl.status === 201 || cl.status === 200) && cl.data?.id, JSON.stringify(cl.data));
    const cloneId = cl.data?.id;

    const rs = await req('POST', `/events/${cloneId}/reset`, { token: ownerTok });
    check('events: reset del clon', rs.status === 200, JSON.stringify(rs.data));
  }

  // ---------- Gestion de usuarios (final) ----------
  {
    const up = await req('PUT', `/users/${vendId}`, { token: ownerTok, body: { name: 'Victoria' } });
    check('users: update datos', up.status === 200, JSON.stringify(up.status));

    const cm = await req('PATCH', `/users/${vendId}/commission`, { token: ownerTok, body: { commission: 900 } });
    check('users: update comision', cm.status === 200, JSON.stringify(cm.status));

    const mg = await req('POST', `/users/${vendId}/magic-link`, { token: ownerTok });
    check('users: owner genera magic link', mg.status === 200 && mg.data?.magic_token, JSON.stringify(mg.status));

    const de = await req('DELETE', `/users/${vendId}`, { token: ownerTok });
    check('users: desactivar vendedor', de.status === 200, JSON.stringify(de.status));

    const dl = await req('POST', '/auth/login', { body: { email: 'vend@test.com', password: 'nuevaClave9' } });
    check('users: login de desactivado -> 401', dl.status === 401, `status=${dl.status}`);

    // La venta publica del desactivado tambien queda bloqueada
    const pb = await req('POST', `/public/tickets/${vendCode}`, {
      body: { event_id: eventId, ticket_type_id: ttGeneralId, payment_method: 'efectivo', attendees: [{ buyer_name: 'Z', buyer_apellido: 'Z', buyer_dni: dni(42) }] },
    });
    check('users: link publico de desactivado -> 404', pb.status === 404, `status=${pb.status}`);

    // Safeguard: admin no puede auto-borrarse (hard)
    const meR = await req('GET', '/auth/me', { token: admin });
    const hd = await req('DELETE', `/users/${meR.data?.id}/hard`, { token: admin });
    check('users: admin no puede hard-borrarse', hd.status === 400 || hd.status === 403, `status=${hd.status}`);
  }

  // ---------- Estados del evento ----------
  {
    const dia = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const ayer2   = fechaLocal(-864e5);
    const manana2 = fechaLocal(+864e5);
    const armar = async (nombre, fecha) => {
      const e = await req('POST', '/events', { token: admin, body: {
        name: nombre, date: fecha, start_time: '23:00', sale_start_at: ayer2, sale_end_at: manana2 } });
      const t = await req('POST', `/events/${e.data?.id}/ticket-types`, { token: admin, body: {
        name: 'General', price: 5000, total_quota: 50 } });
      return { id: e.data?.id, ttId: t.data?.id };
    };
    const vender = (ev) => req('POST', '/tickets', { token: admin, body: {
      event_id: ev.id, ticket_type_id: ev.ttId,
      buyer_name: 'Cli', buyer_apellido: 'Estado', payment_method: 'efectivo' } });

    const ev1 = await armar('Estados: base', dia(0));
    const nuevo = await req('GET', `/events/${ev1.id}`, { token: admin });
    check('estados: un evento nuevo nace ACTIVE', nuevo.data?.status === 'ACTIVE', `status=${nuevo.data?.status}`);
    check('estados: se puede vender en un evento activo', (await vender(ev1)).status === 201, 'no dejo vender');

    // Finalizar: deja de operar pero conserva todo
    const fin = await req('POST', `/events/${ev1.id}/finish`, { token: admin });
    check('estados: finalizar responde 200', fin.status === 200, `HTTP ${fin.status}`);
    const trasFin = await req('GET', `/events/${ev1.id}`, { token: admin });
    check('estados: el evento queda FINISHED', trasFin.data?.status === 'FINISHED', `status=${trasFin.data?.status}`);

    check('estados: finalizado no vende por caja', (await vender(ev1)).status === 409, 'dejo vender');
    const pre = await req('POST', '/tickets/pre-sell', { token: admin, body: {
      event_id: ev1.id, ticket_type_id: ev1.ttId, qty: 1, payment_method: 'efectivo' } });
    check('estados: finalizado no vende por pre-venta', pre.status === 409, `HTTP ${pre.status}`);
    const pub = await req('POST', '/public/tickets/CASA', { body: {
      event_id: ev1.id, ticket_type_id: ev1.ttId, payment_method: 'efectivo',
      attendees: [{ buyer_name: 'X', buyer_apellido: 'Y', buyer_dni: '30111222' }] } });
    check('estados: finalizado no vende por link publico', pub.status === 409, `HTTP ${pub.status}`);
    const cor = await req('POST', '/cortesias', { token: admin, body: {
      event_id: ev1.id, ticket_type_id: ev1.ttId,
      attendees: [{ buyer_name: 'Inv', buyer_apellido: 'Tarde' }] } });
    check('estados: finalizado tampoco acepta cortesias', cor.status === 409, `HTTP ${cor.status}`);

    // El historico se conserva
    const stFin = await req('GET', `/events/${ev1.id}/stats`, { token: admin });
    check('estados: el finalizado conserva sus stats',
          stFin.status === 200 && Number(stFin.data?.totals?.total_pagados) === 1,
          `HTTP ${stFin.status} pagados=${stFin.data?.totals?.total_pagados}`);

    // Reabrir deshace el cierre
    const reab = await req('POST', `/events/${ev1.id}/reopen`, { token: admin });
    check('estados: reabrir responde 200', reab.status === 200, `HTTP ${reab.status}`);
    check('estados: reabierto vuelve a vender', (await vender(ev1)).status === 201, 'sigue bloqueado');

    // Cancelar
    const ev2 = await armar('Estados: cancelar', dia(3));
    check('estados: cancelar responde 200',
          (await req('POST', `/events/${ev2.id}/cancel`, { token: admin })).status === 200, 'fallo');
    check('estados: cancelado no vende', (await vender(ev2)).status === 409, 'dejo vender');
    check('estados: un cancelado no se puede finalizar',
          (await req('POST', `/events/${ev2.id}/finish`, { token: admin })).status === 409, 'lo dejo');

    // Cierre automatico: conservador a proposito
    const viejo  = await armar('Estados: hace 5 dias', dia(-5));
    const anoche = await armar('Estados: anoche', dia(-1));
    await req('GET', '/events', { token: admin });
    const vSt = (await req('GET', `/events/${viejo.id}`,  { token: admin })).data?.status;
    const aSt = (await req('GET', `/events/${anoche.id}`, { token: admin })).data?.status;
    check('estados: un evento de hace 5 dias se cierra solo', vSt === 'FINISHED', `status=${vSt}`);
    check('estados: el de ANOCHE sigue ACTIVE (la fiesta sigue de madrugada)',
          aSt === 'ACTIVE', `status=${aSt}`);
    check('estados: y se le puede seguir vendiendo en la puerta',
          (await vender(anoche)).status === 201, 'lo bloqueo de mas');
  }

  // ---------- Aislamiento entre eventos ----------
  // Los casos de seguridad del pedido: nadie debe poder ver ni tocar datos de
  // un evento al que no fue invitado, ni cambiando el id en la URL ni pegandole
  // directo al endpoint.
  {
    const hoy2 = new Date().toISOString().slice(0, 10);
    const ay = fechaLocal(-864e5);
    const ma = fechaLocal(+864e5);
    const rechazado = (s) => s === 403 || s === 404;

    const nuevoUsuario = async (rol, nombre, creador) => {
      const email = `${nombre}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@t.com`;
      const u = await req('POST', '/users', { token: creador, body: {
        name: nombre, apellido: 'T', email, password: 'password123', role: rol } });
      const l1 = await req('POST', '/auth/login', { body: { email, password: 'password123' } });
      await sleep(1100);
      await req('POST', '/auth/change-password', { token: l1.data?.token, body: { newPassword: 'claveNueva1' } });
      const l2 = await req('POST', '/auth/login', { body: { email, password: 'claveNueva1' } });
      return { id: u.data?.id, token: l2.data?.token };
    };
    const nuevoEvento = async (nombre, ownerId) => {
      const e = await req('POST', '/events', { token: admin, body: {
        name: nombre, date: hoy2, start_time: '23:00', sale_start_at: ay, sale_end_at: ma } });
      if (ownerId) await req('POST', `/events/${e.data?.id}/owners`, { token: admin, body: { user_id: ownerId } });
      const t = await req('POST', `/events/${e.data?.id}/ticket-types`, { token: admin, body: {
        name: 'General', price: 5000, total_quota: 50 } });
      return { id: e.data?.id, ttId: t.data?.id };
    };

    const duenioA = await nuevoUsuario('owner', 'aislA', admin);
    const duenioB = await nuevoUsuario('owner', 'aislB', admin);
    const evA = await nuevoEvento('Aislamiento A', duenioA.id);
    const evB = await nuevoEvento('Aislamiento B', duenioB.id);
    const evC = await nuevoEvento('Aislamiento conjunto', duenioA.id);
    await req('POST', `/events/${evC.id}/owners`, { token: admin, body: { user_id: duenioB.id } });
    const vendedorA = await nuevoUsuario('vendedor', 'aislVend', duenioA.token);

    // Lectura cruzada
    for (const [nombre, url] of [
      ['el evento',       `/events/${evB.id}`],
      ['sus stats',       `/events/${evB.id}/stats`],
      ['sus compradores', `/events/${evB.id}/buyer-stats`],
      ['sus tipos',       `/events/${evB.id}/ticket-types`],
    ]) {
      const r = await req('GET', url, { token: duenioA.token });
      check(`aislamiento: un dueño no puede ver ${nombre} de otro`, rechazado(r.status), `HTTP ${r.status}`);
    }
    const listado = await req('GET', `/tickets?event_id=${evB.id}`, { token: duenioA.token });
    check('aislamiento: ni listar las entradas de otro evento',
          rechazado(listado.status) || (listado.data || []).length === 0, `HTTP ${listado.status}`);

    // Escritura cruzada
    for (const [nombre, m, url, body] of [
      ['editarlo',           'PUT',  `/events/${evB.id}`, { name: 'Robado' }],
      ['agregarle un tipo',  'POST', `/events/${evB.id}/ticket-types`, { name: 'X', price: 1, total_quota: 1 }],
      ['finalizarlo',        'POST', `/events/${evB.id}/finish`, {}],
      ['resetearlo',         'POST', `/events/${evB.id}/reset`, {}],
      ['clonarlo',           'POST', `/events/${evB.id}/clone`, { name: 'Copia', date: hoy2, start_time: '23:00', sale_start_at: ay, sale_end_at: ma }],
      ['emitirle cortesias', 'POST', '/cortesias', { event_id: evB.id, ticket_type_id: evB.ttId, attendees: [{ buyer_name: 'A', buyer_apellido: 'B' }] }],
      ['crear link portero', 'POST', '/scanner-tokens', { event_id: evB.id, all_types: true }],
    ]) {
      const r = await req(m, url, { token: duenioA.token, body });
      check(`aislamiento: un dueño no puede ${nombre} en el evento de otro`, rechazado(r.status), `HTTP ${r.status}`);
    }

    // Colaborador: entra solo donde lo invitaron
    const colabFuera = await req('GET', `/events/${evA.id}`, { token: duenioB.token });
    check('aislamiento: el colaborador de un evento no entra a los otros del organizador',
          rechazado(colabFuera.status), `HTTP ${colabFuera.status}`);
    const colabDentro = await req('GET', `/events/${evC.id}`, { token: duenioB.token });
    check('aislamiento: pero SI entra al evento donde colabora',
          colabDentro.status === 200, `HTTP ${colabDentro.status}`);

    // El vendedor, pegandole directo al endpoint
    const ventaCruzada = await req('POST', '/tickets', { token: vendedorA.token, body: {
      event_id: evB.id, ticket_type_id: evB.ttId,
      buyer_name: 'Colado', buyer_apellido: 'X', payment_method: 'efectivo' } });
    check('aislamiento: un vendedor no vende en el evento de otro organizador',
          rechazado(ventaCruzada.status), `HTTP ${ventaCruzada.status}`);
    const preCruzado = await req('POST', '/tickets/pre-sell', { token: vendedorA.token, body: {
      event_id: evB.id, ticket_type_id: evB.ttId, qty: 1, payment_method: 'efectivo' } });
    check('aislamiento: ni pre-vende', rechazado(preCruzado.status), `HTTP ${preCruzado.status}`);

    // Mezclar el tipo de entrada de otro evento
    const mezcla = await req('POST', '/tickets', { token: admin, body: {
      event_id: evA.id, ticket_type_id: evB.ttId,
      buyer_name: 'Mezcla', buyer_apellido: 'Rara', payment_method: 'efectivo' } });
    check('aislamiento: no se vende un tipo de entrada de otro evento',
          mezcla.status === 404 || mezcla.status === 400, `HTTP ${mezcla.status}`);

    // Y lo que importa del otro lado: en el evento propio se vende normal
    const ventaPropia = await req('POST', '/tickets', { token: vendedorA.token, body: {
      event_id: evA.id, ticket_type_id: evA.ttId,
      buyer_name: 'Cliente', buyer_apellido: 'Propio', payment_method: 'efectivo' } });
    check('aislamiento: el vendedor SI vende en el evento de su organizador',
          ventaPropia.status === 201, `HTTP ${ventaPropia.status} ${JSON.stringify(ventaPropia.data)}`);
  }

  // ---------- Ventas por dia (informe del evento) ----------
  {
    const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const ev = await req('POST', '/events', { token: admin, body: {
      name: 'Curva de ventas', date: d(5), start_time: '23:00',
      sale_start_at: d(-10) + ' 12:00:00', sale_end_at: d(5) + ' 23:00:00' } });
    const evId = ev.data?.id;
    const gen = await req('POST', `/events/${evId}/ticket-types`, { token: admin, body: {
      name: 'General', price: 5000, total_quota: 200 } });
    const vip = await req('POST', `/events/${evId}/ticket-types`, { token: admin, body: {
      name: 'VIP', price: 12000, total_quota: 100 } });

    // Vendemos y corremos created_at para simular ventas en distintos dias.
    // 23:00 UTC = 20:00 en Argentina: sirve para comprobar que la venta de la
    // noche cae en SU dia y no en el siguiente.
    const vender = async (ttId, dia) => {
      const t = await req('POST', '/tickets', { token: admin, body: {
        event_id: evId, ticket_type_id: ttId,
        buyer_name: 'Cli', buyer_apellido: 'Curva', payment_method: 'efectivo' } });
      await dbRun('UPDATE tickets SET created_at = ? WHERE id = ?', [`${dia} 23:00:00`, t.data?.id]);
    };
    for (let i = 0; i < 3; i++) await vender(gen.data?.id, d(-9));
    for (let i = 0; i < 5; i++) await vender(gen.data?.id, d(-7));
    for (let i = 0; i < 2; i++) await vender(vip.data?.id, d(-7));
    for (let i = 0; i < 8; i++) await vender(gen.data?.id, d(-2));
    for (let i = 0; i < 4; i++) await vender(vip.data?.id, d(-2));
    // Una cortesia: es regalada, no cuenta como vendida
    await req('POST', '/cortesias', { token: admin, body: {
      event_id: evId, ticket_type_id: gen.data?.id,
      attendees: [{ buyer_name: 'Inv', buyer_apellido: 'Gratis' }] } });

    const base = await req('GET', `/events/${evId}/ventas-por-dia`, { token: admin });
    check('ventas-por-dia: responde 200', base.status === 200, `HTTP ${base.status}`);
    check('ventas-por-dia: el tramo arranca en la apertura de venta',
          base.data?.desde === d(-10), `desde=${base.data?.desde}`);
    check('ventas-por-dia: cuenta 22 y excluye la cortesia',
          base.data?.total === 22, `total=${base.data?.total}`);
    const conVentas = (base.data?.dias || []).filter(x => x.vendidas > 0);
    check('ventas-por-dia: las agrupa en 3 dias', conVentas.length === 3,
          JSON.stringify(conVentas.map(x => `${x.dia}:${x.vendidas}`)));
    check('ventas-por-dia: la venta de las 20:00 local cae en SU dia',
          conVentas[0]?.dia === d(-9), `primer dia: ${conVentas[0]?.dia}`);
    check('ventas-por-dia: rellena con 0 los dias sin ventas',
          (base.data?.dias || []).some(x => x.vendidas === 0), 'no hay dias en cero');
    check('ventas-por-dia: el acumulado cierra en el total',
          (base.data?.dias || []).slice(-1)[0]?.acumulado === 22, 'no cierra');

    const tramo = await req('GET', `/events/${evId}/ventas-por-dia?desde=${d(-10)}&hasta=${d(-5)}`, { token: admin });
    check('ventas-por-dia: un tramo acotado cuenta solo lo suyo (10)',
          tramo.data?.total === 10, `total=${tramo.data?.total}`);

    const soloVip = await req('GET', `/events/${evId}/ventas-por-dia?tipos=${vip.data?.id}`, { token: admin });
    check('ventas-por-dia: filtro por un tipo (VIP = 6)', soloVip.data?.total === 6, `total=${soloVip.data?.total}`);
    const dosTipos = await req('GET', `/events/${evId}/ventas-por-dia?tipos=${gen.data?.id},${vip.data?.id}`, { token: admin });
    check('ventas-por-dia: filtro por varios tipos (22)', dosTipos.data?.total === 22, `total=${dosTipos.data?.total}`);

    const alReves = await req('GET', `/events/${evId}/ventas-por-dia?desde=${d(0)}&hasta=${d(-5)}`, { token: admin });
    check('ventas-por-dia: rechaza el rango invertido', alReves.status === 400, `HTTP ${alReves.status}`);
    const ajeno = await req('GET', `/events/${evId}/ventas-por-dia?tipos=00000000-0000-0000-0000-000000000000`, { token: admin });
    check('ventas-por-dia: rechaza un tipo de otro evento', ajeno.status === 400, `HTTP ${ajeno.status}`);

    await req('POST', `/events/${evId}/finish`, { token: admin });
    const hist = await req('GET', `/events/${evId}/ventas-por-dia`, { token: admin });
    check('ventas-por-dia: sigue disponible con el evento finalizado',
          hist.status === 200 && hist.data?.total === 22, `HTTP ${hist.status} total=${hist.data?.total}`);
  }

  // ---------- Mantener sesion iniciada ----------
  {
    const vence = (tok) => {
      const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString());
      return { horas: Math.round((p.exp - p.iat) / 3600), jti: p.jti };
    };
    const cred = { email: ADMIN_EMAIL, password: ADMIN_PASS };

    const corta = await req('POST', '/auth/login', { body: cred });
    check('sesion: sin marcar la opcion dura 8 horas',
          vence(corta.data?.token).horas === 8, `dio ${vence(corta.data?.token).horas}h`);

    const larga = await req('POST', '/auth/login', { body: { ...cred, recordarme: true } });
    const vL = vence(larga.data?.token);
    check('sesion: con "mantener sesion iniciada" dura 30 dias',
          vL.horas === 24 * 30, `dio ${vL.horas}h`);
    check('sesion: la sesion larga sirve para operar',
          (await req('GET', '/auth/me', { token: larga.data?.token })).status === 200, 'no anda');

    const lista = await req('GET', '/sessions', { token: larga.data?.token });
    check('sesion: la larga figura en "Sesiones activas"',
          (lista.data?.rows || []).some(x => x.id === vL.jti && x.is_active), 'no aparece');

    // Lo que hace segura a una sesion larga: se puede cortar antes de que venza
    const otra = await req('POST', '/auth/login', { body: cred });
    check('sesion: se puede revocar desde otro dispositivo',
          (await req('DELETE', `/sessions/${vL.jti}`, { token: otra.data?.token })).status === 200, 'no se pudo');
    check('sesion: revocada deja de servir aunque NO haya vencido',
          (await req('GET', '/auth/me', { token: larga.data?.token })).status === 403, 'sigue andando');
  }

  // ---------- Newsletter (lista de descuentos) ----------
  // Solo entra quien MARCA la casilla al comprar. Los emails cargados antes
  // de que existiera la casilla no se migran: se dieron para recibir el QR.
  {
    const hoyN = new Date().toISOString().slice(0, 10);
    const ayN  = fechaLocal(-864e5);
    const maN  = fechaLocal(+864e5);
    const evN = await req('POST', '/events', { token: admin, body: {
      name: 'Evento newsletter', date: hoyN, start_time: '23:00',
      sale_start_at: ayN, sale_end_at: maN } });
    const ttN = await req('POST', `/events/${evN.data?.id}/ticket-types`, { token: admin, body: {
      name: 'General', price: 5000, total_quota: 50 } });

    const comprar = (nombre, email, acepta) => req('POST', '/public/tickets/CASA', { body: {
      event_id: evN.data?.id, ticket_type_id: ttN.data?.id, payment_method: 'efectivo',
      attendees: [{ buyer_name: nombre, buyer_apellido: 'NL',
                    buyer_dni: '30' + Math.floor(Math.random() * 1e6),
                    buyer_email: email, acepta_descuentos: acepta }] } });

    await comprar('Quiere',    'quiere@test.com',     true);
    await comprar('NoQuiere',  'noquiere@test.com',   false);
    await comprar('SinMarcar', 'sinmarcar@test.com',  undefined);
    await sleep(600);   // el alta va despues de responder, para no demorar la compra

    const lista = await req('GET', '/newsletter', { token: admin });
    const emails = (lista.data?.suscriptores || []).map(x => x.email);
    check('newsletter: entra quien marco la casilla',
          emails.includes('quiere@test.com'), JSON.stringify(emails));
    check('newsletter: queda afuera quien NO la marco',
          !emails.includes('noquiere@test.com'), JSON.stringify(emails));
    check('newsletter: queda afuera quien no la toco',
          !emails.includes('sinmarcar@test.com'), JSON.stringify(emails));

    // Misma persona comprando de nuevo: no se duplica y el mail se normaliza
    await comprar('Quiere', 'QUIERE@test.com', true);
    await sleep(600);
    const lista2 = await req('GET', '/newsletter', { token: admin });
    const repes = (lista2.data?.suscriptores || []).filter(x => x.email === 'quiere@test.com');
    check('newsletter: no duplica a la misma persona', repes.length === 1, `aparece ${repes.length} veces`);

    // La base de contactos es de cada organizador
    const mailOwn = `own_nl_${Date.now()}@t.com`;
    await req('POST', '/users', { token: admin, body: {
      name: 'OwnerNL', apellido: 'T', email: mailOwn, password: 'password123', role: 'owner' } });
    const lo1 = await req('POST', '/auth/login', { body: { email: mailOwn, password: 'password123' } });
    await sleep(1100);
    await req('POST', '/auth/change-password', { token: lo1.data?.token, body: { newPassword: 'claveNueva1' } });
    const otroOwner = (await req('POST', '/auth/login', { body: { email: mailOwn, password: 'claveNueva1' } })).data?.token;

    const ajena = await req('GET', '/newsletter', { token: otroOwner });
    check('newsletter: otro organizador no ve la lista ajena',
          (ajena.data?.suscriptores || []).length === 0, `vio ${ajena.data?.suscriptores?.length}`);
    const porEv = await req('GET', `/newsletter?event_id=${evN.data?.id}`, { token: otroOwner });
    check('newsletter: ni pidiendo el evento por id', porEv.status === 403, `HTTP ${porEv.status}`);

    const anon = await req('GET', '/newsletter');
    check('newsletter: sin login no se accede',
          anon.status === 401 || anon.status === 403, `HTTP ${anon.status}`);
  }

  // ---------- Reservas sin vender no se pueden escanear ----------
  // Una reserva nace con status='pagado' (para descontar cupo) y con su
  // qr_code ya armado. Sin este chequeo se escaneaba en la puerta antes de
  // que nadie la comprara: entraba alguien con el nombre "Pendiente
  // Pendiente" y despues el comprador real llegaba con SU entrada y se la
  // rechazaban por "ya fue utilizada".
  {
    const hoyR = new Date().toISOString().slice(0, 10);
    const ayR  = fechaLocal(-864e5);
    const maR  = fechaLocal(+864e5);
    const evR = await req('POST', '/events', { token: admin, body: {
      name: 'Evento reserva escaneable', date: hoyR, start_time: '23:00',
      sale_start_at: ayR, sale_end_at: maR } });
    const ttR = await req('POST', `/events/${evR.data?.id}/ticket-types`, { token: admin, body: {
      name: 'General', price: 5000, total_quota: 20 } });

    const preR = await req('POST', '/tickets/pre-sell', { token: admin, body: {
      event_id: evR.data?.id, ticket_type_id: ttR.data?.id,
      payment_method: 'efectivo', qty: 1 } });
    const idR = preR.data?.tickets?.[0];
    // El qr_code ya NO se deduce del id (ver bloque "El QR no se puede
    // deducir del id"): hay que leerlo, y solo el admin puede.
    const detR = await req('GET', `/tickets/${idR}`, { token: admin });
    const qrR = detR.data?.qr_code;

    const scanReserva = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: qrR } });
    check('reserva sin vender NO entra en la puerta',
          scanReserva.status === 402 && !scanReserva.data?.valid,
          `HTTP ${scanReserva.status} valid=${scanReserva.data?.valid}`);

    const compR = await req('POST', '/public/tickets-complete/CASA', { body: {
      ticket_ids: [idR],
      attendees: [{ buyer_name: 'Comprador', buyer_apellido: 'Real', buyer_dni: '30999111' }] } });
    check('la reserva se completa bien', compR.status === 200, `HTTP ${compR.status}`);

    const scanReal = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: qrR } });
    check('el comprador real SI entra con su entrada',
          scanReal.status === 200 && scanReal.data?.valid === true,
          `HTTP ${scanReal.status} ${scanReal.data?.error || ''}`);
    check('y entra con su nombre, no con "Pendiente"',
          scanReal.data?.ticket?.buyer_name === 'Comprador',
          `nombre=${scanReal.data?.ticket?.buyer_name}`);

    const scanDoble = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: qrR } });
    check('la misma entrada no entra dos veces',
          scanDoble.status === 409, `HTTP ${scanDoble.status}`);
  }

  // ---------- El QR no se puede deducir del id ----------
  // Antes el codigo era el prefijo + los 8 primeros caracteres del id, y
  // /public/tickets-info devuelve los ids a cualquiera con un link de
  // reserva: con el id a la vista se calculaba el QR y se entraba con la
  // entrada de otro. El escaner ademas aceptaba el id crudo.
  {
    const hoyQ = new Date().toISOString().slice(0, 10);
    const ayQ  = fechaLocal(-864e5);
    const maQ  = fechaLocal(+864e5);
    const evQ = await req('POST', '/events', { token: admin, body: {
      name: 'Evento QR secreto', date: hoyQ, start_time: '23:00',
      sale_start_at: ayQ, sale_end_at: maQ } });
    const ttQ = await req('POST', `/events/${evQ.data?.id}/ticket-types`, { token: admin, body: {
      name: 'General', price: 5000, total_quota: 20 } });

    const compraQ = await req('POST', '/public/tickets/CASA', { body: {
      event_id: evQ.data?.id, ticket_type_id: ttQ.data?.id, payment_method: 'efectivo',
      attendees: [{ buyer_name: 'Ana', buyer_apellido: 'Secreta', buyer_dni: '30555111' }] } });
    const tQ = compraQ.data?.tickets?.[0];
    // El prefijo sale del codigo real: si quedara escrito a mano y se volviera
    // a cambiar el nombre, este check pasaria solo porque los prefijos no
    // coinciden, sin probar nada.
    const prefijo  = String(tQ?.qr_code || '').split('-')[0];
    const deducido = `${prefijo}-` + String(tQ?.id || '').substring(0, 8).toUpperCase();

    check('el qr_code NO se deduce del id del ticket',
          tQ?.qr_code && tQ.qr_code !== deducido, `qr=${tQ?.qr_code}`);
    check('el qr_code tiene entropia suficiente',
          (tQ?.qr_code || '').length >= 24, `largo=${(tQ?.qr_code || '').length}`);

    // --- Prefijo: las entradas viejas tienen que seguir entrando ---------
    // Con el cambio de nombre el prefijo paso de GIANQR- a PRICKETS-. Las
    // entradas vendidas antes del cambio siguen guardadas con el prefijo
    // viejo, y son miles. Si en algun lado se validara el prefijo en vez de
    // buscar el codigo exacto, esa gente se quedaria afuera en la puerta.
    check('las entradas nuevas usan el prefijo nuevo',
          String(tQ?.qr_code || '').startsWith('PRICKETS-'), `qr=${tQ?.qr_code}`);

    // Entrada aparte: le reescribimos el codigo al prefijo viejo y la
    // escaneamos. No tocamos tQ, que los checks de abajo todavia usan.
    const compraVieja = await req('POST', '/public/tickets/CASA', { body: {
      event_id: evQ.data?.id, ticket_type_id: ttQ.data?.id, payment_method: 'efectivo',
      attendees: [{ buyer_name: 'Clara', buyer_apellido: 'Vieja', buyer_dni: '30555333' }] } });
    const tVieja  = compraVieja.data?.tickets?.[0];
    const qrViejo = 'GIANQR-A1B2C3D4E5F60718293A';
    await dbRun('UPDATE tickets SET qr_code = ? WHERE id = ?', [qrViejo, tVieja?.id]);
    const scanViejo = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: qrViejo } });
    check('una entrada con el prefijo viejo sigue escaneando',
          scanViejo.status === 200, `HTTP ${scanViejo.status} ${JSON.stringify(scanViejo.data)}`);

    const porId = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: tQ?.id } });
    check('el id crudo no abre la puerta', porId.status === 404, `HTTP ${porId.status}`);

    const porDeducido = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: deducido } });
    check('el codigo deducido del id tampoco', porDeducido.status === 404, `HTTP ${porDeducido.status}`);

    const porQr = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: tQ?.qr_code } });
    check('el QR real si entra', porQr.status === 200 && porQr.data?.valid === true,
          `HTTP ${porQr.status} ${porQr.data?.error || ''}`);

    // El lector manda el JSON completo que lleva el QR adentro.
    const compra2Q = await req('POST', '/public/tickets/CASA', { body: {
      event_id: evQ.data?.id, ticket_type_id: ttQ.data?.id, payment_method: 'efectivo',
      attendees: [{ buyer_name: 'Beto', buyer_apellido: 'Secreto', buyer_dni: '30555222' }] } });
    const t2Q = compra2Q.data?.tickets?.[0];
    const jsonQr = JSON.stringify({ code: t2Q?.qr_code, ticket_id: t2Q?.id });
    const porJson = await req('POST', '/tickets/scan', { token: admin, body: { qr_code: jsonQr } });
    check('el QR en formato JSON tambien entra',
          porJson.status === 200 && porJson.data?.valid === true,
          `HTTP ${porJson.status} ${porJson.data?.error || ''}`);
  }

  // ---------- Por que puerta entro cada uno ----------
  // Con 10 porteros hace falta saber quien escaneo. scanned_by no sirve:
  // apunta a users y los porteros usan links sin cuenta.
  {
    const evP = await req('POST', '/events', { token: admin, body: {
      name: 'Evento puertas', date: new Date().toISOString().slice(0, 10), start_time: '23:00',
      sale_start_at: fechaLocal(-864e5), sale_end_at: fechaLocal(+864e5) } });
    const ttP = await req('POST', `/events/${evP.data?.id}/ticket-types`, { token: admin, body: {
      name: 'General', price: 5000, total_quota: 20 } });

    // Sin nombre: se numeran solas
    const l1 = await req('POST', '/scanner-tokens', { token: admin, body: { event_id: evP.data?.id, all_types: true } });
    const l2 = await req('POST', '/scanner-tokens', { token: admin, body: { event_id: evP.data?.id, all_types: true } });
    const l3 = await req('POST', '/scanner-tokens', { token: admin, body: { event_id: evP.data?.id, all_types: true } });
    check('los links se numeran solos',
          l1.data?.label === 'Puerta 1' && l2.data?.label === 'Puerta 2' && l3.data?.label === 'Puerta 3',
          [l1.data?.label, l2.data?.label, l3.data?.label].join(', '));

    // Borrar una no hace que la siguiente repita el numero
    await req('DELETE', `/scanner-tokens/${l2.data?.id}`, { token: admin });
    const l4 = await req('POST', '/scanner-tokens', { token: admin, body: { event_id: evP.data?.id, all_types: true } });
    check('borrar una puerta no repite su numero', l4.data?.label === 'Puerta 4', `salio ${l4.data?.label}`);

    const compraP = await req('POST', '/public/tickets/CASA', { body: {
      event_id: evP.data?.id, ticket_type_id: ttP.data?.id, payment_method: 'efectivo',
      attendees: [{ buyer_name: 'Bruno', buyer_apellido: 'Puerta', buyer_dni: '30777123' }] } });
    const tP = compraP.data?.tickets?.[0];

    // Entra por la 3
    const e1 = await req('POST', `/scan/${l3.data?.token}`, { body: { qr_code: tP?.qr_code } });
    check('entra por la Puerta 3', e1.status === 200 && e1.data?.valid === true, `HTTP ${e1.status}`);

    // Alguien la reintenta en la 1: tiene que decir por donde se uso
    const e2 = await req('POST', `/scan/${l1.data?.token}`, { body: { qr_code: tP?.qr_code } });
    check('al rechazarla dice por que puerta se uso',
          e2.status === 409 && e2.data?.ticket?.puerta === 'Puerta 3',
          `HTTP ${e2.status} puerta=${e2.data?.ticket?.puerta}`);

    // Y el dueño lo ve en el detalle y en el listado
    const detP = await req('GET', `/tickets/${tP?.id}`, { token: admin });
    check('el detalle de la entrada muestra la puerta', detP.data?.puerta === 'Puerta 3', `puerta=${detP.data?.puerta}`);
    const listP = await req('GET', `/tickets?event_id=${evP.data?.id}`, { token: admin });
    check('el listado tambien muestra la puerta',
          listP.data?.[0]?.puerta === 'Puerta 3', `puerta=${listP.data?.[0]?.puerta}`);
  }

  // ---------- El que pierde la carrera no queda a ciegas ----------
  // Dos porteros escanean a la vez: uno gana, el otro recibe 409. Ese 409
  // devolvia el ticket LEIDO ANTES del update del otro, asi que scanned_at y
  // puerta venian vacios — justo los dos datos que el portero necesita para
  // decidir si deja pasar.
  {
    const evC = await req('POST', '/events', { token: admin, body: {
      name: 'Evento carrera', date: new Date().toISOString().slice(0, 10), start_time: '23:00',
      sale_start_at: fechaLocal(-864e5), sale_end_at: fechaLocal(+864e5) } });
    const ttC = await req('POST', `/events/${evC.data?.id}/ticket-types`, { token: admin, body: {
      name: 'General', price: 5000, total_quota: 20 } });
    const pa = await req('POST', '/scanner-tokens', { token: admin, body: { event_id: evC.data?.id, all_types: true } });
    const pb = await req('POST', '/scanner-tokens', { token: admin, body: { event_id: evC.data?.id, all_types: true } });

    const compraC = await req('POST', '/public/tickets/CASA', { body: {
      event_id: evC.data?.id, ticket_type_id: ttC.data?.id, payment_method: 'efectivo',
      attendees: [{ buyer_name: 'Caso', buyer_apellido: 'Carrera', buyer_dni: '30444777' }] } });
    const tC = compraC.data?.tickets?.[0];

    const [r1, r2] = await Promise.all([
      req('POST', `/scan/${pa.data?.token}`, { body: { qr_code: tC?.qr_code } }),
      req('POST', `/scan/${pb.data?.token}`, { body: { qr_code: tC?.qr_code } }),
    ]);
    const gano   = r1.data?.valid ? r1 : r2;
    const perdio = r1.data?.valid ? r2 : r1;

    check('en una carrera entra exactamente uno',
          gano.status === 200 && perdio.status === 409,
          `uno=${gano.status} otro=${perdio.status}`);
    check('el que pierde igual ve CUANDO se escaneo',
          !!perdio.data?.ticket?.scanned_at, `scanned_at=${perdio.data?.ticket?.scanned_at}`);
    check('y ve POR QUE PUERTA',
          /^Puerta \d+/.test(String(perdio.data?.ticket?.puerta || '')),
          `puerta=${perdio.data?.ticket?.puerta}`);
  }

  // ---------- Nivel minimo por tipo de entrada ----------
  // Cada tipo dice quien lo puede generar. Cada rol genera SU nivel y los de
  // abajo, nunca los de arriba. Y lo que no puede generar, tampoco lo ve.
  {
    // El vendedor de los bloques de arriba no deja su token en una variable
    // compartida, asi que creamos uno propio. El dueño puede crear
    // vendedores directo, sin pasar por un jefe.
    const mailV = `nivVend_${Date.now()}@t.com`;
    await req('POST', '/users', { token: ownerTok, body: {
      name: 'NivVend', apellido: 'T', email: mailV, password: 'password123', role: 'vendedor' } });
    const lv1 = await req('POST', '/auth/login', { body: { email: mailV, password: 'password123' } });
    await sleep(1100);
    await req('POST', '/auth/change-password', { token: lv1.data?.token, body: { newPassword: 'claveNueva1' } });
    const vendTok = (await req('POST', '/auth/login', { body: { email: mailV, password: 'claveNueva1' } })).data?.token;

    const evN = await req('POST', '/events', { token: ownerTok, body: {
      name: 'Evento niveles', date: new Date().toISOString().slice(0, 10), start_time: '23:00',
      sale_start_at: fechaLocal(-864e5), sale_end_at: fechaLocal(+864e5) } });
    const mkTT = async (nombre, nivel) => (await req('POST', `/events/${evN.data?.id}/ticket-types`,
      { token: ownerTok, body: { name: nombre, price: 1000, total_quota: 300, min_role: nivel } })).data;
    const tDue = await mkTT('Palco',   'owner');
    const tJef = await mkTT('VIP',     'jefe_publicas');
    const tVen = await mkTT('General', 'vendedor');

    check('el nivel se guarda como se mando',
          tDue?.min_role === 'owner' && tJef?.min_role === 'jefe_publicas' && tVen?.min_role === 'vendedor',
          [tDue?.min_role, tJef?.min_role, tVen?.min_role].join(','));

    // Lo que ve cada uno
    const ve = async (tok) => {
      const e = await req('GET', `/events/${evN.data?.id}`, { token: tok });
      return (e.data?.ticket_types || []).map(t => t.name).sort().join(',');
    };
    check('el dueño ve los tres tipos',      (await ve(ownerTok)) === 'General,Palco,VIP', await ve(ownerTok));
    check('el jefe NO ve el de dueño',       (await ve(jefeTok))  === 'General,VIP',       await ve(jefeTok));
    check('el vendedor solo ve el suyo',     (await ve(vendTok))  === 'General',           await ve(vendTok));

    // Quien puede generar: pre-sell admite los tres roles
    const gen = async (tok, tt) => (await req('POST', '/tickets/pre-sell', { token: tok, body: {
      event_id: evN.data?.id, ticket_type_id: tt?.id, payment_method: 'efectivo', qty: 1 } })).status;

    check('tipo de dueño: lo genera el dueño',        (await gen(ownerTok, tDue)) === 201);
    check('tipo de dueño: el jefe NO',                (await gen(jefeTok,  tDue)) === 403);
    check('tipo de dueño: el vendedor NO',            (await gen(vendTok,  tDue)) === 403);

    check('tipo de jefe: lo genera el dueño',         (await gen(ownerTok, tJef)) === 201);
    check('tipo de jefe: lo genera el jefe',          (await gen(jefeTok,  tJef)) === 201);
    check('tipo de jefe: el vendedor NO',             (await gen(vendTok,  tJef)) === 403);

    check('tipo de vendedor: lo generan los tres',
          (await gen(ownerTok, tVen)) === 201 && (await gen(jefeTok, tVen)) === 201 && (await gen(vendTok, tVen)) === 201);

    // La venta manual tampoco se puede saltear el nivel (antes no chequeaba)
    const manual = await req('POST', '/tickets', { token: vendTok, body: {
      event_id: evN.data?.id, ticket_type_id: tDue?.id, buyer_name: 'X', buyer_apellido: 'Y',
      buyer_dni: '30888111', payment_method: 'efectivo' } });
    check('la venta manual no saltea el nivel', manual.status === 403, `HTTP ${manual.status}`);

    // Los tipos ya existentes (sin nivel) siguen abiertos a todos
    const tViejo = await mkTT('Sin nivel', undefined);
    check('un tipo sin nivel queda abierto a todos',
          tViejo?.min_role === 'vendedor' && (await gen(vendTok, tViejo)) === 201,
          `min_role=${tViejo?.min_role}`);
  }

  // ---------- Push ----------
  {
    const pk = await req('GET', '/push/public-key');
    check('push: public key expuesta', pk.status === 200, JSON.stringify(pk.data));
  }

  // ---------- Regresiones de bugs ya corregidos ----------
  // Cada bloque de aca abajo cubre un error que se escapo a produccion. La
  // idea es que si alguno vuelve, CI lo cante antes de que lo vea un usuario.
  {
    // Evento nuevo y limpio para medir sin arrastrar lo de arriba.
    const hoy    = new Date().toISOString().slice(0, 10);
    const ayer   = fechaLocal(-864e5);
    const manana = fechaLocal(+864e5);
    const ev = await req('POST', '/events', { token: admin, body: {
      name: 'Regresiones', date: hoy, start_time: '23:00', sale_start_at: ayer, sale_end_at: manana } });
    const evId = ev.data?.id;
    const tt = await req('POST', `/events/${evId}/ticket-types`, { token: admin, body: {
      name: 'General', price: 5000, total_quota: 100 } });
    const ttId = tt.data?.id;

    // --- El check-in pasaba de 100% ------------------------------------
    // total_pagados cuenta solo las NO escaneadas: al usarlo de denominador,
    // con 9 de 10 escaneadas daba 900% y la barra se salia de la pantalla.
    const qrs = [];
    for (let i = 0; i < 10; i++) {
      const t = await req('POST', '/tickets', { token: admin, body: {
        event_id: evId, ticket_type_id: ttId,
        buyer_name: `Chk${i}`, buyer_apellido: 'Test', payment_method: 'efectivo' } });
      qrs.push(t.data?.qr_code);
    }
    for (let i = 0; i < 9; i++) {
      await req('POST', '/tickets/scan', { token: admin, body: { qr_code: qrs[i] } });
    }
    const st = await req('GET', `/events/${evId}/stats`, { token: admin });
    const usados  = Number(st.data?.totals?.total_usados || 0);
    const validas = usados + Number(st.data?.totals?.total_pagados || 0);
    const checkin = validas > 0 ? Math.round((usados / validas) * 100) : 0;
    check('regresion: check-in de 9 sobre 10 da 90%, no 900%', checkin === 90, `dio ${checkin}%`);

    // --- Las cortesias inflaban lo recaudado ---------------------------
    // by_type.recaudado salia de sold_count * price, asi que contaba las
    // regaladas a precio de lista.
    await req('POST', '/cortesias', { token: admin, body: {
      event_id: evId, ticket_type_id: ttId,
      attendees: [{ buyer_name: 'Free', buyer_apellido: 'Uno' }, { buyer_name: 'Free', buyer_apellido: 'Dos' }] } });
    const st2 = await req('GET', `/events/${evId}/stats`, { token: admin });
    const porTipo = st2.data?.by_type?.[0] || {};
    check('regresion: las cortesias no suman a lo recaudado',
          Number(porTipo.recaudado) === Number(st2.data?.totals?.total_recaudado),
          `by_type=${porTipo.recaudado} totals=${st2.data?.totals?.total_recaudado}`);
    check('regresion: se informan las cortesias por tipo', Number(porTipo.cortesias) === 2,
          `dio ${porTipo.cortesias}`);

    // --- El QR de una cortesia se sacaba sabiendo solo el nombre --------
    const apCort = 'CortRegr' + Date.now();
    await req('POST', '/cortesias', { token: admin, body: {
      event_id: evId, ticket_type_id: ttId,
      attendees: [{ buyer_name: 'Invitada', buyer_apellido: apCort }] } });
    const robo = await req('POST', '/public/recover/CASA', { body: {
      nombre: 'Invitada', apellido: apCort, dni: '11111111' } });
    check('regresion: no se recupera la cortesia ajena con un DNI inventado',
          (robo.data?.tickets?.length || 0) === 0, JSON.stringify(robo.data));

    // --- Clonar perdia los permisos por tipo ---------------------------
    // ticket_type_sellers no se copiaba: el clon quedaba abierto a todos.
    const vr = await req('POST', '/users', { token: admin, body: {
      name: 'VendRegr', apellido: 'T', email: `vr${Date.now()}@t.com`,
      password: 'password123', role: 'vendedor' } });
    await req('PUT', `/events/${evId}/ticket-types/${ttId}/sellers`, {
      token: admin, body: { user_ids: [vr.data?.id] } });
    const clon = await req('POST', `/events/${evId}/clone`, { token: admin, body: {
      name: 'Regresiones Clon', date: hoy, start_time: '23:00',
      sale_start_at: ayer, sale_end_at: manana } });
    const ttClon = (await req('GET', `/events/${clon.data?.id}/ticket-types`, { token: admin })).data?.[0];
    const selClon = await req('GET', `/events/${clon.data?.id}/ticket-types/${ttClon?.id}/sellers`, { token: admin });
    check('regresion: el clon conserva los vendedores autorizados',
          selClon.data?.length === 1, `dio ${selClon.data?.length}`);

    // --- Permisos editables cruzando eventos (IDOR) --------------------
    // Se validaba el evento de la URL pero no que el tipo fuera de ese evento.
    const cruzado = await req('PUT', `/events/${clon.data?.id}/ticket-types/${ttId}/sellers`, {
      token: admin, body: { user_ids: [] } });
    check('regresion: no se editan permisos de un tipo de otro evento',
          cruzado.status === 404, `status=${cruzado.status}`);

    // --- El DNI se descartaba en la venta manual -----------------------
    const conDni = await req('POST', '/tickets', { token: admin, body: {
      event_id: evId, ticket_type_id: ttId, buyer_name: 'ConDni', buyer_apellido: 'Test',
      buyer_dni: '30999888', payment_method: 'efectivo' } });
    check('regresion: la venta manual guarda el DNI', conDni.data?.buyer_dni === '30999888',
          JSON.stringify(conDni.data?.buyer_dni));

    // --- Un pedido con basura no puede tumbar el servidor ---------------
    // POST /public/tickets/:code con attendees:[null] tiraba TypeError en la
    // validacion. Como el handler es async, Express 4 no ve esa promesa
    // rechazada, Node la reporta como unhandledRejection y MATA el proceso:
    // un solo pedido publico dejaba a todos sin sistema. Ahora cada handler
    // va envuelto (utils/asyncRouter) y ademas se valida la forma del dato.
    {
      const basura = [
        ['persona nula',        [null]],
        ['persona como texto',  ['texto']],
        ['persona como numero', [123]],
        ['persona como lista',  [[]]],
      ];
      for (const [caso, attendees] of basura) {
        const r = await req('POST', '/public/tickets/CASA', { body: {
          event_id: evId, ticket_type_id: ttId, payment_method: 'efectivo', attendees } });
        check(`regresion: ${caso} devuelve error, no rompe el server`,
              r.status === 400, `status=${r.status}`);
      }
      const cort = await req('POST', '/cortesias', { token: admin, body: {
        event_id: evId, ticket_type_id: ttId, attendees: [null] } });
      check('regresion: cortesia con invitado nulo devuelve 400', cort.status === 400,
            `status=${cort.status}`);

      // Lo decisivo: el servidor tiene que seguir respondiendo.
      const vivo = await req('GET', '/health');
      check('regresion: el servidor sigue vivo despues de los pedidos basura',
            vivo.status === 200, `status=${vivo.status}`);
    }

    // --- Un pedido malformado NO debe tumbar el backend -----------------
    // POST /public/tickets/:code con attendees:[null] tiraba TypeError en la
    // validacion. Como el handler es async, Express 4 no ve la promesa
    // rechazada, Node la reporta como unhandledRejection y MATA EL PROCESO.
    // Era un endpoint publico: cualquiera dejaba sin sistema a todos.
    {
      const basura = [
        ['attendees con un nulo',      { event_id: evId, ticket_type_id: ttId, attendees: [null] }],
        ['attendees con un numero',    { event_id: evId, ticket_type_id: ttId, attendees: [42] }],
        ['attendees con un texto',     { event_id: evId, ticket_type_id: ttId, attendees: ['hola'] }],
        ['attendees que no es lista',  { event_id: evId, ticket_type_id: ttId, attendees: 'no-soy-lista' }],
      ];
      for (const [caso, body] of basura) {
        const r = await req('POST', '/public/tickets/CASA', { body });
        check(`regresion: ${caso} -> 400, no tumba el server`, r.status === 400,
              `status=${r.status} ${JSON.stringify(r.data)}`);
      }
      // Cortesias tenia el mismo patron
      const cortBasura = await req('POST', '/cortesias', { token: admin, body: {
        event_id: evId, ticket_type_id: ttId, attendees: [null] } });
      check('regresion: cortesia con invitado nulo -> 400', cortBasura.status === 400,
            `status=${cortBasura.status}`);

      // Y lo que de verdad importa: el server sigue vivo despues de todo eso
      const vivo = await req('GET', '/health');
      check('regresion: el backend sigue en pie tras los pedidos malformados',
            vivo.status === 200, `status=${vivo.status}`);
    }

    // --- Rendiciones: un admin no toca las publicas de otro admin -------
    // ownerCanAccessPromotor devolvia true para todo rol que no fuera owner,
    // asi que un admin podia listar, abrir, registrar y BORRAR pagos de las
    // publicas del arbol de otro admin.
    {
      // Segundo admin, con su propio arbol
      const emailB = `admin_rend_${Date.now()}@t.com`;
      await req('POST', '/users', { token: admin, body: {
        name: 'AdminOtro', apellido: 'T', email: emailB, password: 'password123', role: 'admin' } });
      const adminB = (await req('POST', '/auth/login', { body: {
        email: emailB, password: 'password123' } })).data?.token;

      // El admin dueño de este arbol SI ve sus publicas
      const propias = await req('GET', '/rendiciones', { token: admin });
      // Salteamos la fila "Caja": no es una publica y no tiene promotor_id
      // real, asi que no sirve para probar el aislamiento entre admins.
      const algunaPropia = (propias.data || []).find(p => !p.es_caja);
      check('rendiciones: el admin sigue viendo las publicas de su arbol',
            Array.isArray(propias.data) && propias.data.length > 0,
            `devolvio ${propias.data?.length}`);

      if (algunaPropia) {
        const listaB = await req('GET', '/rendiciones', { token: adminB });
        check('regresion: el otro admin NO ve esas publicas en su listado',
              !(listaB.data || []).some(p => p.promotor_id === algunaPropia.promotor_id),
              `devolvio ${listaB.data?.length} filas`);

        // La fila Caja agrega plata de eventos: tiene que respetar el mismo
        // aislamiento. Si se escapara, un admin veria la recaudacion de la
        // caja de los clientes de otro.
        const cajaB = (listaB.data || []).find(p => p.es_caja);
        check('regresion: el otro admin NO ve la caja de este arbol',
              !cajaB, `caja ajena con $${cajaB?.total_recaudado}`);

        const detB = await req('GET', `/rendiciones/${algunaPropia.promotor_id}`, { token: adminB });
        check('regresion: el otro admin no abre su detalle', detB.status === 403, `status=${detB.status}`);

        const pagoB = await req('POST', '/rendiciones', { token: adminB, body: {
          promotor_id: algunaPropia.promotor_id, amount: 1, note: 'cross-tenant' } });
        check('regresion: el otro admin no le registra pagos', pagoB.status === 403, `status=${pagoB.status}`);

        // Y el admin dueño si puede abrir el detalle
        const detPropio = await req('GET', `/rendiciones/${algunaPropia.promotor_id}`, { token: admin });
        check('rendiciones: el admin dueño si abre el detalle', detPropio.status === 200,
              `status=${detPropio.status}`);
      }
    }

    // --- Los conteos deben poder sumarse, no concatenarse ---------------
    // En Postgres COUNT() devuelve bigint y el driver lo entrega como TEXTO;
    // en SQLite viene como numero. Por esa diferencia, sumar dos conteos
    // andaba en desarrollo y en produccion CONCATENABA: el tablero llego a
    // mostrar "16450 vendidas" cuando eran 164 escaneadas + 50 pendientes.
    // El parser de INT8 en config/database lo normaliza; esto lo vigila.
    const stNum = await req('GET', `/events/${evId}/stats`, { token: admin });
    const t = stNum.data?.totals || {};
    const sumables = ['total_pagados', 'total_usados', 'total_pendientes'];
    const tiposMal = sumables.filter(k => typeof t[k] !== 'number');
    check('regresion: los conteos de stats llegan como numero, no como texto',
          tiposMal.length === 0,
          tiposMal.map(k => `${k}=${JSON.stringify(t[k])} (${typeof t[k]})`).join(', '));
    check('regresion: sumar dos conteos da un numero, no una concatenacion',
          typeof (t.total_usados + t.total_pagados) === 'number',
          `${JSON.stringify(t.total_usados)} + ${JSON.stringify(t.total_pagados)} = ${JSON.stringify(t.total_usados + t.total_pagados)}`);

    const porTipoNum = (stNum.data?.by_type || [])[0] || {};
    check('regresion: los conteos por tipo tambien son numeros',
          typeof porTipoNum.sold_count === 'number' && typeof porTipoNum.cortesias === 'number',
          `sold_count=${typeof porTipoNum.sold_count} cortesias=${typeof porTipoNum.cortesias}`);

    // --- El cupo del rate limit era por IP compartida -------------------
    // Todo el staff sale por el WiFi del lugar: con clave por IP, el tablero
    // abierto agotaba el cupo y dejaba sin escanear a los porteros.
    const rl = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${admin}` } });
    const cabecera = rl.headers.get('ratelimit') || '';
    const limite = Number(/limit=(\d+)/.exec(cabecera)?.[1] ?? 0);
    check('regresion: el usuario logueado tiene cupo propio y amplio', limite >= 3000,
          `limite=${limite} (${cabecera})`);
    const anon = await fetch(`${BASE}/health`);
    const limAnon = Number(/limit=(\d+)/.exec(anon.headers.get('ratelimit') || '')?.[1] ?? 0);
    check('regresion: el trafico anonimo mantiene el cupo corto', limAnon > 0 && limAnon < 3000,
          `limite=${limAnon}`);
  }

  // ---------- Resumen ----------
  console.log('\n' + '='.repeat(60));
  console.log(`TOTAL: ${results.length} checks — ${results.length - failures} PASS, ${failures} FAIL`);
  if (failures > 0) {
    console.log('\nFallas:');
    for (const r of results.filter(x => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  }
  if (dbh) await dbh.close();
  process.exit(failures > 0 ? 1 : 0);
})().catch(err => {
  console.error('ERROR FATAL del runner:', err);
  process.exit(1);
});
