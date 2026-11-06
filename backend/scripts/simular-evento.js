/**
 * Simulacion de un evento real, de punta a punta.
 *
 *   node scripts/simular-evento.js            # 3000 entradas
 *   ENTRADAS=500 node scripts/simular-evento.js
 *
 * Necesita un backend corriendo (E2E_URL, por defecto :4000).
 *
 * Por que existe: la suite e2e prueba que cada cosa funcione una vez. Esto
 * prueba lo otro — que funcione 3000 veces, con gente entrando al mismo
 * tiempo. Los problemas de una noche de evento (sobreventa, entradas que
 * entran dos veces, el tablero que se arrastra, el rate limit que corta a
 * los porteros) no aparecen probando de a uno.
 *
 * Corre las cuatro etapas de una noche:
 *   1. Venta      — publica, caja y reservas, en paralelo
 *   2. Puerta     — varios porteros escaneando a la vez
 *   3. Ataques    — la misma entrada dos veces, reservas, QR inventados
 *   4. Tablero    — los numeros con la base llena
 */
const BASE     = process.env.E2E_URL || 'http://127.0.0.1:4000/api';
const ENTRADAS = Number(process.env.ENTRADAS || 3000);
const PORTEROS = Number(process.env.PORTEROS || 5);
const EMAIL    = process.env.ADMIN_EMAIL || 'gianfrancodealbera@gmail.com';
const PASS     = process.env.ADMIN_PASS  || '43955952Gd';

let fallas = 0;
const check = (nombre, ok, detalle = '') => {
  console.log(`${ok ? 'PASS ' : 'FALLA'}  ${nombre}${ok ? '' : '  ->  ' + detalle}`);
  if (!ok) fallas++;
};
const titulo = (t) => console.log(`\n${'='.repeat(66)}\n${t}\n${'='.repeat(66)}`);

async function req(metodo, url, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const t0 = Date.now();
  const r = await fetch(`${BASE}${url}`, {
    method: metodo, headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, data: d, ms: Date.now() - t0 };
}

// Corre `tareas` con un tope de concurrencia, como la gente real: varios a la
// vez, no todos de golpe ni de a uno.
async function enParalelo(tareas, concurrencia) {
  const out = new Array(tareas.length);
  let i = 0;
  await Promise.all(Array.from({ length: concurrencia }, async () => {
    while (i < tareas.length) {
      const mio = i++;
      out[mio] = await tareas[mio]();
    }
  }));
  return out;
}

const percentil = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const resumenTiempos = (ms) => ({
  p50: percentil(ms, 0.50), p95: percentil(ms, 0.95),
  p99: percentil(ms, 0.99), max: Math.max(...ms),
});

const fechaLocal = (offsetMs = 0) => {
  const d = new Date(Date.now() + offsetMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

(async () => {
  const t0 = Date.now();
  console.log(`Simulando un evento de ${ENTRADAS} entradas con ${PORTEROS} porteros`);
  console.log(`Backend: ${BASE}`);

  const login = await req('POST', '/auth/login', { body: { email: EMAIL, password: PASS } });
  const admin = login.data?.token;
  if (!admin) { console.log('No pude loguear:', JSON.stringify(login.data)); process.exit(1); }

  // ---------------------------------------------------------------- 1. ARMADO
  titulo('1. ARMADO DEL EVENTO');
  const hoy = new Date().toISOString().slice(0, 10);
  const ev = await req('POST', '/events', { token: admin, body: {
    name: `Simulacion ${ENTRADAS}`, date: hoy, start_time: '23:00',
    sale_start_at: fechaLocal(-7 * 864e5), sale_end_at: fechaLocal(864e5) } });
  const evId = ev.data?.id;
  check('evento creado', !!evId, JSON.stringify(ev.data));
  if (!evId) process.exit(1);

  // Cupo EXACTO: asi la sobreventa no tiene donde esconderse.
  const reparto = [
    { name: 'General', price: 8000,  total_quota: Math.floor(ENTRADAS * 0.70) },
    { name: 'VIP',     price: 20000, total_quota: Math.floor(ENTRADAS * 0.20) },
    { name: 'Early',   price: 6000,  total_quota: ENTRADAS - Math.floor(ENTRADAS * 0.70) - Math.floor(ENTRADAS * 0.20) },
    // Cupo aparte para las pruebas de la etapa 4, que necesitan emitir
    // entradas DESPUES de que se agoto todo lo demas.
    { name: 'Reservado pruebas', price: 1, total_quota: 5 },
  ];
  const tipos = [];
  for (const t of reparto) {
    const r = await req('POST', `/events/${evId}/ticket-types`, { token: admin, body: t });
    tipos.push({ ...t, id: r.data?.id });
  }
  const cupoTotal = reparto.slice(0, 3).reduce((a, t) => a + t.total_quota, 0);
  check('tipos de entrada creados', tipos.every(t => t.id), JSON.stringify(tipos.map(t => t.id)));
  check(`el cupo suma ${ENTRADAS}`, cupoTotal === ENTRADAS, `suma ${cupoTotal}`);

  // Links de portero
  const tokens = [];
  for (let i = 0; i < PORTEROS; i++) {
    const r = await req('POST', '/scanner-tokens', { token: admin, body: {
      event_id: evId, all_types: true, label: `Puerta ${i + 1}` } });
    if (r.data?.token) tokens.push(r.data.token);
  }
  check(`${PORTEROS} links de portero`, tokens.length === PORTEROS, `salieron ${tokens.length}`);

  // ----------------------------------------------------------------- 2. VENTA
  titulo('2. VENTA');
  const POR_COMPRA = 4;                       // la gente compra de a grupos
  const entradas = [];                        // { id, qr }
  const msVenta = [];
  let sinCupo = 0, erroresVenta = 0;
  let dni = 30000000;

  const compras = [];
  for (const tipo of tipos.slice(0, 3)) {
    const n = Math.ceil(tipo.total_quota / POR_COMPRA);
    for (let i = 0; i < n; i++) {
      const cuantos = Math.min(POR_COMPRA, tipo.total_quota - i * POR_COMPRA);
      compras.push(() => req('POST', '/public/tickets/CASA', { body: {
        event_id: evId, ticket_type_id: tipo.id, payment_method: 'efectivo',
        attendees: Array.from({ length: cuantos }, () => ({
          buyer_name: 'Comprador', buyer_apellido: `N${dni}`, buyer_dni: String(dni++),
        })),
      } }));
    }
  }
  // Mezclamos para que los tres tipos se vendan entreverados, como en la vida real
  compras.sort(() => Math.random() - 0.5);

  console.log(`  ${compras.length} compras de hasta ${POR_COMPRA} entradas, 24 en paralelo...`);
  const resVenta = await enParalelo(compras, 24);
  for (const r of resVenta) {
    msVenta.push(r.ms);
    if (r.status === 201 && Array.isArray(r.data?.tickets)) {
      for (const t of r.data.tickets) entradas.push({ id: t.id, qr: t.qr_code });
    } else if (/cupo/i.test(r.data?.error || '')) sinCupo++;
    else erroresVenta++;
  }

  const tv = resumenTiempos(msVenta);
  console.log(`  tiempos de venta (ms): p50=${tv.p50} p95=${tv.p95} p99=${tv.p99} max=${tv.max}`);
  check(`se vendieron las ${ENTRADAS} entradas`, entradas.length === ENTRADAS, `salieron ${entradas.length}`);
  check('ninguna compra fallo por error inesperado', erroresVenta === 0, `${erroresVenta} errores`);
  check('todas tienen QR distinto', new Set(entradas.map(e => e.qr)).size === entradas.length,
        `${new Set(entradas.map(e => e.qr)).size} unicos de ${entradas.length}`);

  // Sobreventa: una compra mas alla del cupo tiene que rebotar
  const extra = await req('POST', '/public/tickets/CASA', { body: {
    event_id: evId, ticket_type_id: tipos[0].id, payment_method: 'efectivo',
    attendees: [{ buyer_name: 'Sobre', buyer_apellido: 'Venta', buyer_dni: '39999999' }] } });
  check('pasado el cupo no vende mas', extra.status !== 201, `HTTP ${extra.status}`);

  // ----------------------------------------------------------------- 3. PUERTA
  titulo('3. PUERTA');
  const msScan = [];
  let entraron = 0, rechazos = 0, limitados = 0, erroresScan = 0;
  const motivos = {};

  // Ritmo. Esto antes decia en un comentario que escaneaba a ritmo realista y
  // reintentaba ante 429, pero no hacia ninguna de las dos: tiraba los 3000 de
  // golpe. Resultado, entraban exactamente PORTEROS x 120 (el cupo del primer
  // minuto) y el resto rebotaba, asi que la simulacion "fallaba" siempre
  // midiendo la compresion del test y no el sistema.
  //
  // Ahora se espacian los escaneos para no pasar de RITMO por puerta por
  // minuto. Por defecto 400, que es holgado contra el tope real de 600 y a la
  // vez bastante mas rapido que cualquier puerta de verdad (20 o 30 por
  // minuto en el pico). Una noche entera entra en menos de un minuto de test.
  const RITMO     = Number(process.env.RITMO || 400);   // escaneos/min por puerta
  const esperaMs  = 60000 / (RITMO * PORTEROS);
  const dormir    = (ms) => new Promise(r => setTimeout(r, ms));

  let proximo = Date.now();
  const turno = async () => {
    const mio = proximo;
    proximo += esperaMs;
    const falta = mio - Date.now();
    if (falta > 0) await dormir(falta);
  };

  // Un 429 suelto no es "esta persona no entro": es el limite frenando un
  // instante. Reintentamos una vez, que es lo que haria el portero.
  const scans = entradas.map((e, i) => async () => {
    await turno();
    const tok = tokens[i % tokens.length];
    let r = await req('POST', `/scan/${tok}`, { body: { qr_code: e.qr } });
    if (r.status === 429) {
      await dormir(1000);
      r = await req('POST', `/scan/${tok}`, { body: { qr_code: e.qr } });
      if (r.status !== 429) r.reintentado = true;
    }
    return r;
  });

  console.log(`  ${scans.length} escaneos por ${PORTEROS} puertas a ${RITMO}/min cada una ` +
              `(~${Math.round(scans.length * esperaMs / 1000)}s)...`);
  const resScan = await enParalelo(scans, PORTEROS * 2);
  const reintentados = resScan.filter(r => r.reintentado).length;
  if (reintentados) console.log(`  ${reintentados} escaneos entraron recien en el reintento`);
  for (const r of resScan) {
    msScan.push(r.ms);
    if (r.status === 200 && r.data?.valid) entraron++;
    else if (r.status === 429) limitados++;
    else if (r.status === 409 || r.status === 402) { rechazos++; motivos[r.data?.error] = (motivos[r.data?.error] || 0) + 1; }
    else { erroresScan++; motivos[`HTTP ${r.status}: ${r.data?.error}`] = (motivos[`HTTP ${r.status}: ${r.data?.error}`] || 0) + 1; }
  }

  const ts = resumenTiempos(msScan);
  console.log(`  tiempos de escaneo (ms): p50=${ts.p50} p95=${ts.p95} p99=${ts.p99} max=${ts.max}`);
  if (Object.keys(motivos).length) console.log('  motivos:', JSON.stringify(motivos));
  check(`entraron las ${ENTRADAS} personas`, entraron === ENTRADAS, `entraron ${entraron}`);
  check('ningun escaneo dio error inesperado', erroresScan === 0, `${erroresScan} errores`);
  check('el rate limit no dejo a nadie afuera', limitados === 0,
        `${limitados} escaneos rebotados por limite aun despues de reintentar — ` +
        'en la puerta serian personas esperando');
  check('el escaneo responde rapido (p95 < 1s)', ts.p95 < 1000, `p95=${ts.p95}ms`);

  // ---------------------------------------------------------------- 4. ATAQUES
  titulo('4. LO QUE NO TIENE QUE PASAR');

  // Link propio: los de la puerta acaban de consumir su cupo de 120/min y
  // responderian 429, que no es lo que queremos medir aca.
  const tokPruebas = (await req('POST', '/scanner-tokens', { token: admin, body: {
    event_id: evId, all_types: true, label: 'Pruebas' } })).data?.token;

  // a) la misma entrada, dos porteros, al mismo tiempo
  const victima = entradas[0];
  await req('POST', '/tickets/scan', { token: admin, body: { qr_code: victima.qr } }); // ya usada igual
  const carrera = await Promise.all([
    req('POST', `/scan/${tokPruebas}`, { body: { qr_code: entradas[1].qr } }),
    req('POST', `/scan/${tokens[PORTEROS - 1]}`, { body: { qr_code: entradas[1].qr } }),
  ]);
  const ganaron = carrera.filter(r => r.status === 200 && r.data?.valid).length;
  check('dos porteros a la vez: no entra dos veces', ganaron === 0,
        `${ganaron} aceptaron una entrada ya usada`);

  // b) reserva sin vender
  const pre = await req('POST', '/tickets/pre-sell', { token: admin, body: {
    event_id: evId, ticket_type_id: tipos[3].id, payment_method: 'efectivo', qty: 1 } });
  const idRes = pre.data?.tickets?.[0];
  const det = idRes ? await req('GET', `/tickets/${idRes}`, { token: admin }) : { data: {} };
  const scanRes = det.data?.qr_code
    ? await req('POST', `/scan/${tokPruebas}`, { body: { qr_code: det.data.qr_code } })
    : { status: 0 };
  check('una reserva sin vender no entra', scanRes.status === 402, `HTTP ${scanRes.status}`);

  // c) QR inventado
  const falso = await req('POST', `/scan/${tokPruebas}`, { body: { qr_code: 'PRICKETS-FFFFFFFFFFFFFFFFFFFF' } });
  check('un QR inventado no entra', falso.status === 404, `HTTP ${falso.status}`);

  // d) el id del ticket no sirve como QR
  const porId = await req('POST', `/scan/${tokPruebas}`, { body: { qr_code: entradas[5].id } });
  check('el id del ticket no abre la puerta', porId.status === 404, `HTTP ${porId.status}`);

  // ---------------------------------------------------------------- 5. TABLERO
  titulo('5. EL TABLERO CON LA BASE LLENA');
  const st = await req('GET', `/events/${evId}/stats`, { token: admin });
  console.log(`  /stats respondio en ${st.ms}ms`);
  const tot = st.data?.totals || {};
  const claves = ['total_pagados', 'total_usados', 'total_pendientes', 'total_recaudado'];
  const noNumeros = claves.filter(k => typeof tot[k] !== 'number');
  // Postgres devuelve COUNT como string: si se cuela, los totales se
  // concatenan ("164"+"50" = "16450") en vez de sumarse.
  check('los totales son numeros, no texto', noNumeros.length === 0,
        JSON.stringify(Object.fromEntries(claves.map(k => [k, typeof tot[k]]))));
  check('lo usado cuadra con lo que entro', tot.total_usados === ENTRADAS,
        `usados=${tot.total_usados} entraron=${ENTRADAS}`);
  check('el tablero responde rapido (< 2s)', st.ms < 2000, `${st.ms}ms`);

  const lista = await req('GET', `/tickets?event_id=${evId}`, { token: admin });
  console.log(`  listado de entradas: ${lista.ms}ms, ${Array.isArray(lista.data) ? lista.data.length : '?'} filas`);
  check('el listado completo responde (< 5s)', lista.ms < 5000, `${lista.ms}ms`);

  const vpd = await req('GET', `/events/${evId}/ventas-por-dia`, { token: admin });
  check('ventas-por-dia responde', vpd.status === 200, `HTTP ${vpd.status} ${JSON.stringify(vpd.data).slice(0, 120)}`);
  // +1 por la reserva que emitimos en la etapa 4: pre-sell descuenta cupo y
  // cuenta como vendida a proposito, aunque el comprador no cargo sus datos.
  const esperado = ENTRADAS + (idRes ? 1 : 0);
  check('ventas-por-dia cuadra con lo vendido', vpd.data?.total === esperado,
        `dice ${vpd.data?.total}, esperaba ${esperado}`);

  // ----------------------------------------------------------------- RESUMEN
  titulo('RESUMEN');
  console.log(`entradas vendidas : ${entradas.length}`);
  console.log(`personas que entraron : ${entraron}`);
  console.log(`venta   p50/p95/max : ${tv.p50} / ${tv.p95} / ${tv.max} ms`);
  console.log(`escaneo p50/p95/max : ${ts.p50} / ${ts.p95} / ${ts.max} ms`);
  console.log(`duracion total      : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('');
  console.log(fallas === 0 ? 'SIN FALLAS' : `${fallas} FALLAS`);
  process.exit(fallas ? 1 : 0);
})();
