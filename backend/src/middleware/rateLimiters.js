/**
 * Rate limiters por endpoint. Cada uno con su ventana y limite distintos
 * segun el riesgo (login brute-force, magic-token guess, public buy, etc.).
 *
 * Importante: para que el rate-limit lea la IP real detras de Railway/Cloudflare/Vercel,
 * el server.js setea app.set('trust proxy', 1). Sin eso todas las peticiones se ven
 * como del mismo IP y un atacante tumba a todos.
 */
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const baseConfig = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/**
 * Identifica al usuario para el cupo del rate limit.
 *
 * Por que existe: en un evento TODO el staff sale por el mismo WiFi del
 * lugar, asi que con la clave por IP compartian un unico cupo. Solo el
 * tablero de Control en vivo ya consumia ~600 pedidos cada 15 minutos
 * (refresca cada 3s con 2 llamadas), por encima del limite de 500 — y al
 * agotarse, el servidor empezaba a rechazar TODO lo que viniera de esa IP,
 * incluidos los escaneos de los porteros en plena entrada de gente.
 *
 * Va como middleware ANTES del limiter para verificar el token una sola vez.
 * La firma se valida de verdad: si aceptaramos un token sin verificar,
 * cualquiera podria inventar ids y fabricarse cupos nuevos a voluntad.
 */
const identifyForRateLimit = (req, res, next) => {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (token && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded?.id) req.rateLimitUserId = String(decoded.id);
    } catch { /* token invalido o vencido: queda con el cupo de su IP */ }
  }

  // El escaner de portero (/api/scan/:token) no manda JWT: su credencial es
  // el uuid del link. Sin esto caia en el cupo anonimo por IP, y como TODOS
  // los porteros salen por el mismo WiFi del lugar, los 500 pedidos cada 15
  // minutos se los repartian entre todos: 33 escaneos por minuto para toda la
  // puerta. Con 3000 personas entrando en hora y media eso es exactamente el
  // limite, y cualquier pico devolvia "Demasiadas solicitudes" con la cola
  // esperando afuera.
  //
  // El uuid no se puede adivinar, asi que sirve igual que el JWT para
  // separar cupos. El techo por link lo sigue poniendo publicScanLimiter
  // (120/min), que es el que frena el abuso real.
  if (!req.rateLimitUserId) {
    const m = /^\/scan\/([A-Za-z0-9_-]{8,})/.exec(req.path || '');
    if (m) req.rateLimitScanToken = m[1];
  }
  next();
};

// Clave del cupo: el usuario logueado, sino el link de portero, sino su IP.
const claveUsuarioOIp = (req) =>
  req.rateLimitUserId    ? `u:${req.rateLimitUserId}`
  : req.rateLimitScanToken ? `scan:${req.rateLimitScanToken}`
  : `ip:${ipKeyGenerator(req.ip)}`;

// Global: red de seguridad para todo /api/*.
// Al usuario identificado le damos margen (un tablero abierto toda la noche
// hace muchos pedidos chicos y legitimos); al trafico anonimo lo dejamos mas
// corto, que es donde vive el abuso.
//
// El cupo anonimo paso de 500 a 1500 cada 15 minutos. Por que: en un evento
// TODA la gente que compra desde el lugar sale por el mismo WiFi, o sea una
// sola IP. Abrir el link de compra cuesta 3 pedidos (promotor, eventos y la
// compra), asi que con 500 entraban unos 165 compradores cada 15 minutos y el
// resto veia "Demasiadas solicitudes". Medido en la simulacion de 3000: 252
// compras cortadas de 750.
// Sigue acotado, y lo peligroso ya lo frenan los limiters por endpoint
// (compra 20/min, recuperacion 10/15min, consulta de reservas 30/min).
const globalLimiter = rateLimit({
  ...baseConfig,
  windowMs: 15 * 60 * 1000,
  max: (req) => (req.rateLimitUserId || req.rateLimitScanToken ? 3000 : 1500),
  keyGenerator: claveUsuarioOIp,
  message: { error: 'Demasiadas solicitudes, esperá unos minutos' },
});

// Login: 5 intentos por IP en 15 min. No cuenta los exitosos, así un usuario
// que se loguea bien y sigue navegando no consume el cupo.
const loginLimiter = rateLimit({
  ...baseConfig,
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 5000 : 5,
  skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos de login, esperá 15 minutos' },
});

// Magic token: 10 intentos por IP en 15 min. Los tokens son UUIDs (poco
// brute-forceables) pero igual ponemos un techo.
const magicLimiter = rateLimit({
  ...baseConfig,
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos, esperá unos minutos' },
});

// Public ticket buy: 20/min por IP. Es alto a propósito — un comprador real
// puede retry varias veces si tiene mala conexión. Un bot que spamea cae igual.
// En desarrollo el tope sube: la suite e2e hace decenas de compras seguidas
// y con 20/min chocaba contra el limite, devolviendo 429 en checks que
// esperaban otra cosa. Mismo criterio que el limiter de login. En produccion
// no cambia nada.
const publicBuyLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 5000 : 20,
  message: { error: 'Demasiadas solicitudes, esperá un momento' },
});

// Public recover: 10/15min por IP. Este endpoint permite enumerar compradores
// por nombre+apellido. Lo ajustamos bajo.
const publicRecoverLimiter = rateLimit({
  ...baseConfig,
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiadas búsquedas, esperá unos minutos' },
});

// Public tickets-info: 30/min por IP. Devuelve info de reservas por id (uuid).
// Sin techo, un atacante podia ir enumerando ids para mapear reservas en
// curso. Con 30/min y uuids de 122 bits de entropia es inviable.
const publicTicketsInfoLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Demasiadas consultas, esperá un momento' },
});

// Public scan: 600/min POR LINK DE PORTERO, no por IP.
//
// Con la clave por IP, los 4 o 5 porteros de la puerta —todos en el WiFi del
// lugar, todos con la misma IP publica— compartian un unico cupo de 60/min.
// En la entrada fuerte se lo comian entre ellos y el escaneo empezaba a
// fallar justo en el peor momento. Cada link tiene su propio cupo ahora, y un
// link es un uuid: el que no lo tiene no llega a este endpoint igual.
//
// El tope por link paso de 120 a 600 por minuto. El sistema de puertas
// numeradas da un link a cada portero, y con eso 120/min sobra: una puerta
// real hace 20 o 30 escaneos por minuto en el pico. Pero nada obliga a usarlo
// asi, y lo comodo es mandar UN link al grupo de WhatsApp. Diez porteros
// compartiendo un link, a 12 escaneos por minuto cada uno, dan 120: justo el
// limite, con la cola esperando afuera.
//
// Subirlo no abre nada: para llegar aca hay que tener el uuid del link, los
// codigos QR son de 80 bits (adivinar es inviable a cualquier ritmo) y cada
// escaneo cuesta ~20ms, asi que 600/min es trafico despreciable para el
// servidor. Lo que el tope frena es un cliente desbocado, no un ataque.
const publicScanLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req) =>
    req.params?.token ? `scan:${req.params.token}` : `ip:${ipKeyGenerator(req.ip)}`,
  message: { error: 'Demasiados escaneos' },
});

// Forgot password: 3 pedidos por IP cada 15min. Evita spam de mails de reset.
const forgotPasswordLimiter = rateLimit({
  ...baseConfig,
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: 'Demasiados pedidos de reset, esperá 15 minutos' },
});

// Reset password: 5 intentos de aplicar reset por IP cada 15min.
const resetPasswordLimiter = rateLimit({
  ...baseConfig,
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos, esperá 15 minutos' },
});

module.exports = {
  identifyForRateLimit,
  globalLimiter,
  loginLimiter,
  magicLimiter,
  publicBuyLimiter,
  publicRecoverLimiter,
  publicTicketsInfoLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  publicScanLimiter,
};
