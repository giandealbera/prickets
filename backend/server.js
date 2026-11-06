require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const compression = require('compression');
const { initDb } = require('./src/config/database');
const { globalLimiter, identifyForRateLimit } = require('./src/middleware/rateLimiters');

const app = express();

// Detras de Railway/Cloudflare/Vercel — necesario para que rate-limit lea la IP real
app.set('trust proxy', 1);

// Saca el header X-Powered-By: Express (fingerprinting fácil sino)
app.disable('x-powered-by');

// Helmet: pone headers de seguridad (X-Frame-Options, nosniff, HSTS, etc.)
// Desactivamos CSP porque es API only — la CSP del frontend la maneja Vercel.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Gzip las respuestas — gana ~70% en JSON grandes (reportes, listados).
app.use(compression());

// CORS: acepta una lista de origins separados por coma (FRONTEND_URL puede ser
// "https://gianqr.com,https://www.gianqr.com,https://gianqr.vercel.app").
// Asi el cambio a dominio propio no rompe el deploy de Vercel actual.
const originsConfigurados = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);

// www y el dominio pelado son el MISMO sitio, pero para CORS son origins
// distintos. Olvidarse uno de los dos es el error de configuracion mas facil
// de cometer y el mas dificil de ver: el navegador no distingue un CORS
// bloqueado de un corte de red, asi que la app muestra "sin conexion" y uno
// sale a buscar el problema donde no esta.
//
// Paso de verdad: FRONTEND_URL tenia solo https://www.gianqr.com y
// https://gianqr.com quedaba afuera. Por suerte el apex redirige a www antes
// de que cargue la app, asi que no se noto; con el dominio al reves habria
// sido una caida completa.
//
// Agregar el par no abre nada: es el mismo dominio, el mismo certificado y
// el mismo dueño.
function conParWww(origins) {
  const out = new Set(origins);
  for (const o of origins) {
    try {
      const u = new URL(o);
      u.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
      out.add(u.origin);
    } catch { /* no es una URL parseable: queda como vino */ }
  }
  return [...out];
}
const allowedOrigins = conParWww(originsConfigurados);

// Al log del arranque, para que una lista incompleta se vea en el deploy en
// vez de descubrirse con la gente en la puerta.
console.log('[cors] origins permitidos:', allowedOrigins.join(', '));
app.use(cors({
  origin: (origin, cb) => {
    // requests sin origin (curl, mobile apps) pasan
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  // credentials:false porque el frontend usa Authorization Bearer (localStorage),
  // no cookies. Setearlo en true abre la puerta a accidentes futuros con
  // cookies cross-origin sin necesidad real hoy. CSRF no aplica (sin cookies).
  credentials: false,
}));

// Body parsers — bajamos de 10mb a 1mb. Si en algun momento hace falta subir
// imagenes grandes, se mueve a un endpoint específico con limite mas alto.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limit global como red de seguridad — los limiters por-endpoint son mas
// estrictos para login/public.
// identifyForRateLimit va PRIMERO: resuelve de quien es el pedido para que
// cada usuario tenga su propio cupo. Sin eso, todo el staff de un evento
// (misma IP del WiFi del lugar) compartia uno solo y el tablero abierto
// dejaba sin escanear a los porteros.
app.use('/api', identifyForRateLimit, globalLimiter);

app.use('/api/auth',            require('./src/routes/auth'));
app.use('/api/users',           require('./src/routes/users'));
app.use('/api/events',          require('./src/routes/events'));
app.use('/api/tickets',         require('./src/routes/tickets'));
app.use('/api/payments',        require('./src/routes/payments'));
app.use('/api/scanner-tokens',  require('./src/routes/scannerTokens'));
app.use('/api/scan',            require('./src/routes/publicScan'));
app.use('/api/public',          require('./src/routes/public'));
app.use('/api/rendiciones',     require('./src/routes/rendiciones'));
app.use('/api/cortesias',       require('./src/routes/cortesias'));
app.use('/api/proveedores',     require('./src/routes/proveedores'));
app.use('/api/zonas',           require('./src/routes/zonas'));
app.use('/api/audit-log',       require('./src/routes/auditLog'));
app.use('/api/sessions',        require('./src/routes/sessions'));
app.use('/api/push',            require('./src/routes/push'));
app.use('/api/newsletter',      require('./src/routes/newsletter'));

// Health check sin fingerprinting (no exponemos version ni nombre)
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
  // PayloadTooLargeError: body excede el limit. Devolvemos 413, no 500.
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'El cuerpo de la solicitud es demasiado grande' });
  }
  // JSON malformado
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  // Solo logueamos el message — el stack completo en prod queda en logs internos
  // pero no se filtra al cliente.
  console.error('Error no manejado:', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 4000;

const start = async () => {
  // Inicializar la base (auto-detecta driver via DATABASE_URL)
  const { PG_MODE } = require('./src/config/database');
  await initDb();
  console.log(`  ✅ Base de datos lista (${PG_MODE ? 'Postgres' : 'SQLite local'})`);

  // Ejecutar seed (crea admin por defecto)
  try { await require('./src/seed')(); } catch(e) { /* ya seedeado */ }

  // Verifica el proveedor de mail y lo deja dicho en los logs. No se espera
  // (`await`) a proposito: si Gmail tarda en responder, que no demore el
  // arranque del server.
  require('./src/utils/mailer').checkMailProvider().catch(() => {});

  app.listen(PORT, () => {
    console.log(`
  ╔════════════════════════════════╗
  ║   🎵  Prickets Backend v1.0   ║
  ║   Puerto: ${PORT}                  ║
  ╚════════════════════════════════╝
    `);
  });
};

start().catch(err => {
  console.error('❌ Error al iniciar el servidor:', err);
  process.exit(1);
});

module.exports = app;
