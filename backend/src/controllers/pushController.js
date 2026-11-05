// Web Push: el endpoint y formato siguen la spec de W3C Push API.
// iOS Safari 16.4+ lo soporta SOLO en PWA standalone (apple-mobile-web-app-
// capable=yes — ya lo tenemos). Android Chrome / desktop tambien.
//
// Setup:
//   1. Generar VAPID keys: `node backend/scripts/generate-vapid.js`
//   2. Setear VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y VAPID_CONTACT (mailto)
//      en env vars de Railway. Hasta tener las 3, el servicio queda en
//      modo "no-op" — los subscribes se aceptan y guardan, pero ningun
//      sendPush envia nada (no rompe).
//
// El sendPush() es interno — los controllers que quieran disparar push
// (ej: "tu venta se cancelo", "se corto la venta del evento") lo llaman.
// Por ahora ningun caller existe — esta listo para enganchar despues.

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');

let webpush = null;
let configured = false;
function ensureWebPush() {
  if (configured) return webpush;
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const ct   = process.env.VAPID_CONTACT || 'mailto:no-reply@gianqr.com';
  if (!pub || !priv) return null; // no configurado — no-op silencioso
  webpush = require('web-push');
  webpush.setVapidDetails(ct, pub, priv);
  configured = true;
  return webpush;
}

// GET /api/push/public-key — el frontend la necesita para subscribirse.
const getPublicKey = (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || null;
  res.json({ key, enabled: !!key });
};

// POST /api/push/subscribe — guarda la subscription del browser.
// body: { endpoint, keys: { p256dh, auth } }
const subscribe = async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return res.status(400).json({ error: 'subscription invalida' });
  try {
    const ua = String(req.headers['user-agent'] || '').slice(0, 500);
    const id = uuidv4();
    // Si ya existe (el mismo endpoint vuelve a subscribirse), actualizamos
    // las keys y nada mas — el browser puede rotarlas.
    // SQLite no soporta ON CONFLICT con sintaxis fija para todo, asi que
    // hacemos un upsert manual.
    const existing = await db.query('SELECT id FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    if (existing.rows[0]) {
      await db.query(
        'UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_id = ?, user_agent = ? WHERE endpoint = ?',
        [keys.p256dh, keys.auth, req.user.id, ua, endpoint]
      );
      return res.json({ ok: true, updated: true });
    }
    await db.query(
      'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, endpoint, keys.p256dh, keys.auth, ua]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('push subscribe', err);
    res.status(500).json({ error: 'No se pudo guardar la subscripcion' });
  }
};

// POST /api/push/unsubscribe — borra la subscription por endpoint.
const unsubscribe = async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  try {
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo borrar' });
  }
};

// POST /api/push/test — solo para validar el flujo. El usuario logueado
// se manda una notificacion a si mismo. Si VAPID no esta configurado,
// devuelve 503 — asi en prod hasta que pongas las keys queda inerte.
const sendTest = async (req, res) => {
  const wp = ensureWebPush();
  if (!wp) return res.status(503).json({ error: 'Web Push no configurado (faltan VAPID keys)' });
  try {
    const subs = await db.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
    if (!subs.rows.length) return res.status(404).json({ error: 'No tenes notificaciones activadas en ningun dispositivo' });
    const payload = JSON.stringify({
      title: 'Prickets',
      body:  'Notificaciones funcionando',
      url:   '/eventos',
    });
    await Promise.all(subs.rows.map(s =>
      wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
        .catch(err => {
          // 410 Gone = el browser borro la subscription. La limpiamos.
          if (err.statusCode === 404 || err.statusCode === 410) {
            return db.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [s.endpoint]);
          }
          console.error('push send', err.statusCode, err.body);
        })
    ));
    res.json({ ok: true, count: subs.rows.length });
  } catch (err) {
    console.error('push test', err);
    res.status(500).json({ error: 'Error al enviar' });
  }
};

// Helper para callers internos. Manda a TODOS los devices de un usuario.
// Uso futuro:
//   const { sendPush } = require('./pushController');
//   await sendPush(ownerId, { title: 'Venta cortada', body: '...', url: `/evento/${id}` });
async function sendPush(userId, { title, body, url } = {}) {
  const wp = ensureWebPush();
  if (!wp || !userId) return { sent: 0 };
  const subs = await db.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
  const payload = JSON.stringify({ title, body, url });
  let sent = 0;
  await Promise.all(subs.rows.map(s =>
    wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
      .then(() => { sent++; })
      .catch(err => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          return db.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [s.endpoint]);
        }
      })
  ));
  return { sent };
}

module.exports = { getPublicKey, subscribe, unsubscribe, sendTest, sendPush };
