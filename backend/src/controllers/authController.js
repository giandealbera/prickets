const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../config/database');
const { sendMail, isMailConfigured, renderEmail } = require('../utils/mailer');
const { logAudit } = require('../utils/auditLog');
const { verifyToken: verifyTotp } = require('../utils/tfa');
const { consumeRecoveryCode } = require('./tfaController');
const { createSession, revokeAllSessionsForUser } = require('../utils/sessions');

// Roles para los que el 2FA es OBLIGATORIO. Se setea por env var.
// Si el rol del usuario aparece aca y NO tiene totp_enabled=1, el cliente
// va a recibir tfa_required:true y debe llevarlo a /configuracion/2fa.
function tfaRequiredRoles() {
  return (process.env.TFA_REQUIRED_ROLES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}
function isTfaRequiredForRole(role) {
  return tfaRequiredRoles().includes(role);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Reset de contraseña por email ------------------------------------------

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

// En la base guardamos el HASH del token, nunca el token. Si alguien se hace
// de una copia de la base (backup, dump, acceso al panel del proveedor), los
// resets en curso no le sirven para entrar: el valor que abre el link solo
// existe en la casilla del usuario.
const hashResetToken = (t) =>
  crypto.createHash('sha256').update(String(t)).digest('hex');

// Parseo robusto de fechas que vienen de la base. SQLite devuelve
// "YYYY-MM-DD HH:MM:SS" en UTC y Postgres puede devolver un Date ya armado;
// sin la 'Z' explicita, new Date() interpreta el string como hora LOCAL y el
// vencimiento se corre tantas horas como el offset del servidor. Es el mismo
// tratamiento que ya hacen magicLogin y el middleware de auth.
function parseDbDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const raw = String(value);
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// Igualamos el tiempo de respuesta de las dos ramas (la cuenta existe / no
// existe). Antes la rama "existe" se quedaba esperando la llamada HTTP al
// proveedor de mail y la otra dormia 200ms fijos, asi que cronometrando la
// respuesta se podia deducir que emails estaban registrados.
const FORGOT_MIN_MS = 180;
async function padTiming(startedAt) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < FORGOT_MIN_MS) {
    await new Promise(r => setTimeout(r, FORGOT_MIN_MS - elapsed));
  }
}

// Cuanto dura la sesion.
//
// Por defecto 8 horas. Con "mantener sesion iniciada" pasa a 30 dias, para
// que el vendedor o el portero no tengan que escribir la contraseña cada vez
// que abren la app en su telefono.
//
// Una sesion larga es segura aca porque el middleware de auth valida contra
// la tabla `sessions` en CADA pedido: si se revoca desde "Sesiones activas" o
// se cambia la contraseña, el token deja de servir en el acto aunque todavia
// no haya vencido.
const DURACION_NORMAL    = process.env.JWT_EXPIRES_IN || '8h';
const DURACION_RECORDADO = process.env.JWT_EXPIRES_IN_REMEMBER || '30d';
const duracionSesion = (recordar) => (recordar ? DURACION_RECORDADO : DURACION_NORMAL);

// POST /api/auth/login
const login = async (req, res) => {
  const { email, password, recordarme } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (!EMAIL_REGEX.test(email))
    return res.status(400).json({ error: 'Email inválido' });

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE email = ? AND is_active = 1',
      [email.toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) {
      // No revelamos si el email existe o no — para audit log igual nos
      // sirve trazar el intento (sin user_id), para detectar credential
      // stuffing.
      logAudit(req, 'AUTH_LOGIN_FAILED', { details: { reason: 'user_not_found_or_inactive', email: email.toLowerCase() } });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logAudit(req, 'AUTH_LOGIN_FAILED', {
        details: { reason: 'bad_password', email: email.toLowerCase() },
        actorOverride: { id: user.id, email: user.email, role: user.role },
      });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Si tiene 2FA habilitado, NO emitimos el JWT completo todavia. En su
    // lugar devolvemos un "partial token" firmado con el mismo JWT_SECRET
    // pero con un scope distinto (purpose:'2fa'). El cliente debe llamar
    // /auth/2fa/verify con ese partial + el codigo TOTP para conseguir el
    // JWT final. El partial dura 5 minutos.
    if (user.totp_enabled) {
      // La eleccion de "mantener sesion" viaja DENTRO del partial token, que
      // esta firmado por nosotros. Si la mandara el cliente en el segundo
      // paso, cualquiera podria pedir una sesion de 30 dias sin haberla
      // elegido en el login.
      const partialToken = jwt.sign(
        { id: user.id, email: user.email, purpose: '2fa', recordarme: !!recordarme },
        process.env.JWT_SECRET,
        { expiresIn: '5m', algorithm: 'HS256' }
      );
      return res.json({ needs_2fa: true, partial_token: partialToken });
    }

    const jti = await createSession(req, user.id);
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name, jti },
      process.env.JWT_SECRET,
      { expiresIn: duracionSesion(recordarme), algorithm: 'HS256' }
    );

    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        must_change_password: !!user.must_change_password,
        totp_enabled: !!user.totp_enabled,
        tfa_required: isTfaRequiredForRole(user.role) && !user.totp_enabled,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// POST /api/auth/2fa/verify { partial_token, code }
// Segundo paso del login cuando hay 2FA. Acepta codigo TOTP o codigo de
// recuperacion (one-time). Si valida, emite el JWT completo.
const verifyTwoFactor = async (req, res) => {
  const { partial_token, code } = req.body;
  if (!partial_token || !code)
    return res.status(400).json({ error: 'partial_token y code son requeridos' });
  try {
    let decoded;
    try {
      decoded = jwt.verify(partial_token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Sesión de verificación expirada. Volvé a loguearte.' });
    }
    if (decoded.purpose !== '2fa') {
      return res.status(401).json({ error: 'Token inválido' });
    }
    const r = await db.query('SELECT id, name, email, role, totp_secret, totp_enabled, must_change_password FROM users WHERE id = ? AND is_active = 1', [decoded.id]);
    const user = r.rows[0];
    if (!user || !user.totp_enabled) return res.status(401).json({ error: 'Cuenta inválida' });

    // Aceptamos codigo TOTP de 6 digitos O codigo de recuperacion XXXX-XXXX.
    const isTotp = /^\d{6}$/.test(String(code).replace(/\s+/g, ''));
    let ok = false;
    if (isTotp) {
      ok = verifyTotp(code, user.totp_secret);
    } else {
      ok = await consumeRecoveryCode(user.id, code);
    }

    if (!ok) {
      logAudit(req, 'AUTH_2FA_FAILED', {
        actorOverride: { id: user.id, email: user.email, role: user.role },
      });
      return res.status(401).json({ error: 'Código incorrecto' });
    }

    const jti = await createSession(req, user.id);
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name, jti },
      process.env.JWT_SECRET,
      // La eleccion viene del partial token, que firmamos nosotros en el
      // primer paso del login.
      { expiresIn: duracionSesion(decoded.recordarme), algorithm: 'HS256' }
    );

    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        must_change_password: !!user.must_change_password,
        totp_enabled: !!user.totp_enabled,
        tfa_required: isTfaRequiredForRole(user.role) && !user.totp_enabled,
      },
    });
  } catch (err) {
    console.error('verifyTwoFactor error:', err);
    res.status(500).json({ error: 'Error interno' });
  }
};

// GET /api/auth/me
const me = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, email, role, created_at, must_change_password, totp_enabled FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    const u = result.rows[0];
    // tfa_required = el rol exige 2FA y el user NO lo tiene habilitado.
    // El frontend usa esto para redirigir a /configuracion/2fa y bloquear
    // el resto de la app.
    const tfa_required = isTfaRequiredForRole(u.role) && !u.totp_enabled;
    res.json({
      ...u,
      must_change_password: !!u.must_change_password,
      totp_enabled: !!u.totp_enabled,
      tfa_required,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// GET /api/auth/magic/:token — login instantáneo sin contraseña (UNA SOLA VEZ)
const magicLogin = async (req, res) => {
  const { token } = req.params;
  try {
    const result = await db.query(
      'SELECT * FROM users WHERE magic_token = ? AND is_active = 1',
      [token]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Link inválido o ya usado' });

    // Expiracion: si el link tiene expiracion seteada y ya paso, lo invalidamos.
    // magic_token_expires NULL = legacy (token sin expiracion, sigue valiendo).
    if (user.magic_token_expires) {
      const raw = String(user.magic_token_expires);
      const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
      if (Date.now() > new Date(iso).getTime()) {
        await db.query('UPDATE users SET magic_token = NULL, magic_token_expires = NULL WHERE id = ?', [user.id]);
        return res.status(410).json({ error: 'Link vencido. Pedile al jefe uno nuevo.' });
      }
    }

    // Invalidar el token: el link es de un solo uso. Si el vendedor pierde el
    // acceso, el jefe puede generarle uno nuevo desde su panel.
    await db.query('UPDATE users SET magic_token = NULL, magic_token_expires = NULL WHERE id = ?', [user.id]);

    const jti = await createSession(req, user.id);
    const jwt_token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name, jti },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256' }
    );
    res.json({
      token: jwt_token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('magicLogin error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// POST /api/auth/forgot-password — recibe email, genera reset_token, envia mail
// (o lo loguea si no hay Resend configurado). Siempre devuelve la misma respuesta
// generica para no permitir enumeracion de emails.
const forgotPassword = async (req, res) => {
  const startedAt = Date.now();
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  if (!EMAIL_REGEX.test(email))
    return res.status(400).json({ error: 'Email inválido' });

  // Este chequeo va ANTES de tocar la base a proposito: la respuesta es
  // identica exista o no la cuenta, asi que no filtra nada. Antes, si el
  // proveedor de mail no estaba configurado el endpoint igual contestaba
  // "te enviamos las instrucciones" y el mail no salia nunca: el usuario
  // quedaba esperando un correo fantasma, sin ninguna pista de que hacer.
  if (!isMailConfigured()) {
    return res.status(503).json({
      error: 'El envío de emails no está disponible en este momento. Recuperá tu acceso con celular + apellido, o pedile a un administrador que te genere un acceso directo.',
      code: 'MAIL_NOT_CONFIGURED',
    });
  }

  // Respuesta generica: la misma exista o no el email (anti-enumeration)
  const genericReply = { message: 'Si el email existe en el sistema, te enviamos las instrucciones para resetear tu contraseña' };

  try {
    const result = await db.query(
      'SELECT id, name, email FROM users WHERE email = ? AND is_active = 1',
      [email.toLowerCase()]
    );
    const user = result.rows[0];

    // Token random de 32 bytes hex (64 chars) — imposible de adivinar.
    // En la base va solo su hash; el valor en claro viaja unicamente al mail.
    let pending = null;
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt  = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      await db.query(
        'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
        [hashResetToken(resetToken), expiresAt, user.id]
      );
      pending = { user, resetToken };
      logAudit(req, 'AUTH_FORGOT_PASSWORD', { resourceType: 'user', resourceId: user.id });
    }

    await padTiming(startedAt);
    res.json(genericReply);

    // El envio va DESPUES de responder: el usuario no espera el round-trip al
    // proveedor, y el tiempo de respuesta deja de depender de si la cuenta
    // existe. Si el envio falla queda en los logs del server (el token sigue
    // valido y el usuario puede volver a pedirlo).
    if (pending) {
      const frontUrl  = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
      const resetLink = `${frontUrl}/reset-password/${pending.resetToken}`;
      const nombre    = pending.user.name || '';
      sendMail({
        to: pending.user.email,
        subject: 'Prickets — Restablecer tu contraseña',
        text: `Hola ${nombre},\n\nPediste restablecer tu contraseña de Prickets. Entrá a este link para elegir una nueva (vale 1 hora y se puede usar una sola vez):\n\n${resetLink}\n\nSi no fuiste vos, ignorá este mensaje: tu contraseña actual sigue funcionando.\n\n— Prickets`,
        html: renderEmail({
          title: `Hola ${nombre}`,
          intro: 'Pediste restablecer tu contraseña de Prickets. Tocá el botón para elegir una nueva. El link vale 1 hora y se puede usar una sola vez.',
          cta:   { label: 'Elegir nueva contraseña', url: resetLink },
          note:  'Si no fuiste vos, ignorá este mensaje: tu contraseña actual sigue funcionando.',
        }),
      }).catch(() => { /* ya se loguea dentro de sendMail */ });
    }
  } catch (err) {
    console.error('forgotPassword error:', err.message);
    // Aun en caso de error, respondemos generico para no filtrar info
    if (!res.headersSent) res.json(genericReply);
  }
};

// POST /api/auth/forgot-password-phone — recovery sin email.
// Recibe { celular, apellido }, valida que ambos matcheen un usuario
// activo, genera magic_token de 1h y devuelve el link /acceso/:token
// directamente en la respuesta. El frontend muestra un boton "Entrar"
// que toca ese link y loguea al usuario (que despues setea su nueva pwd
// con el flujo must_change_password — gratis porque magicLogin ya lo
// hace).
//
// Seguridad: pediomos celular AND apellido (no solo uno). El celular solo
// no alcanza porque podria leakearse (whatsapp, base de datos compartida).
// El combo apellido+celular es lo bastante unico para una app de
// boliche/eventos donde los users se conocen. Esta detras del mismo
// forgotPasswordLimiter (5 intentos / IP / 15min) — bloquea fuerza bruta.
//
// La respuesta es generica si no encuentra: no revelamos si el celular
// existe o si fue el apellido el que no matcheo (anti-enumeration).
const forgotPasswordByPhone = async (req, res) => {
  const { celular, apellido } = req.body;
  if (!celular || !apellido)
    return res.status(400).json({ error: 'Celular y apellido son requeridos' });

  // Respuesta generica de "no se encontro" — misma forma que el caso ok
  // para no filtrar info por status/mensaje.
  const notFound = { ok: false, error: 'No encontramos esa combinación. Probá con email o pedile a un admin que te genere un acceso.' };

  try {
    // Normalizo el celular sacando todo lo no numerico (espacios, guiones,
    // parentesis, '+'). Asi "+54 9 11 5555-5555" matchea con "5491155555555"
    // si se cargo el numero un poco distinto.
    const cleanCel = String(celular).replace(/\D/g, '');
    if (cleanCel.length < 6) {
      await new Promise(r => setTimeout(r, 200));
      return res.json(notFound);
    }

    // Match insensible al caso del apellido + comparacion del celular
    // ignorando caracteres no numericos en BD tambien.
    const result = await db.query(
      `SELECT id, name, apellido
         FROM users
        WHERE is_active = 1
          AND LOWER(TRIM(apellido)) = LOWER(TRIM(?))
          AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(celular,''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') = ?`,
      [apellido, cleanCel]
    );
    const user = result.rows[0];
    if (!user) {
      // Pequeno delay para que el timing no delate "no existe vs existe pero apellido mal"
      await new Promise(r => setTimeout(r, 200));
      return res.json(notFound);
    }

    const magicToken = crypto.randomBytes(32).toString('hex');
    // 1h de vida — mismo SLA que el reset-token de email.
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.query(
      'UPDATE users SET magic_token = ?, magic_token_expires = ? WHERE id = ?',
      [magicToken, expiresAt, user.id]
    );

    logAudit(req, 'AUTH_FORGOT_BY_PHONE', { user_id: user.id });

    // Devolvemos el link directamente. La proteccion contra robo del
    // magic-link en transito es el HTTPS — mismo modelo que el reset por
    // email.
    res.json({
      ok: true,
      user_name: user.name,
      magic_path: `/acceso/${magicToken}`,
    });
  } catch (err) {
    console.error('forgotPasswordByPhone error:', err.message);
    res.json(notFound);
  }
};

// Busca al usuario dueño de un reset token en claro. Devuelve
// { user } | { error, status } para que los dos endpoints den el mismo
// diagnostico (vencido vs invalido) sin duplicar la logica.
async function findUserByResetToken(token) {
  const result = await db.query(
    'SELECT id, name, email, reset_token_expires FROM users WHERE reset_token = ? AND is_active = 1',
    [hashResetToken(token)]
  );
  const user = result.rows[0];
  if (!user) return { status: 400, error: 'Link inválido o ya usado. Pedí uno nuevo desde "Olvidé mi contraseña".' };

  const expires = parseDbDate(user.reset_token_expires);
  if (!expires || expires < new Date()) {
    // Limpiamos el token vencido para que no quede dando vueltas en la base.
    await db.query('UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE id = ?', [user.id]);
    return { status: 410, error: 'El link expiró. Pedí uno nuevo desde "Olvidé mi contraseña".' };
  }
  return { user };
}

// GET /api/auth/reset-password/:token — valida el link ANTES de mostrar el
// formulario. Sin esto el usuario elegia y confirmaba una contraseña nueva
// para recien ahi enterarse de que el link estaba vencido.
const checkResetToken = async (req, res) => {
  try {
    const found = await findUserByResetToken(req.params.token);
    if (found.error) return res.status(found.status).json({ valid: false, error: found.error });
    // El nombre solo se revela a quien ya tiene el token valido en la mano.
    res.json({ valid: true, name: found.user.name || null });
  } catch (err) {
    console.error('checkResetToken error:', err.message);
    res.status(500).json({ valid: false, error: 'Error al validar el link' });
  }
};

// POST /api/auth/reset-password — recibe token + nueva password, valida y resetea
const resetPassword = async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password)
    return res.status(400).json({ error: 'Token y nueva contraseña son requeridos' });
  if (password.length < 8)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

  try {
    const found = await findUserByResetToken(token);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const user = found.user;

    const hash = await bcrypt.hash(password, 10);
    // Reset por mail tambien limpia must_change_password (la password nueva
    // es responsabilidad del usuario, no del creador).
    await db.query(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, password_changed_at = CURRENT_TIMESTAMP, must_change_password = 0 WHERE id = ?',
      [hash, user.id]
    );

    // Cerramos todas las sesiones abiertas. password_changed_at ya invalida
    // los JWT viejos en el middleware, pero sin esto las filas quedaban como
    // "activas" en la pantalla de Sesiones. Y si el reset fue porque alguien
    // le entro a la cuenta, el intruso tiene que quedar afuera de verdad.
    try { await revokeAllSessionsForUser(user.id); } catch { /* no critico */ }

    logAudit(req, 'AUTH_PASSWORD_RESET', { resourceType: 'user', resourceId: user.id });

    res.json({ message: 'Contraseña actualizada. Ya podés iniciar sesión.' });

    // Aviso post-cambio: si el reset no lo pidio el dueño de la cuenta, este
    // mail es la unica forma de que se entere.
    if (isMailConfigured() && user.email) {
      const frontUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
      sendMail({
        to: user.email,
        subject: 'Prickets — Tu contraseña fue cambiada',
        text: `Hola ${user.name || ''},\n\nTe confirmamos que la contraseña de tu cuenta de Prickets se cambió recién, y se cerraron todas las sesiones abiertas.\n\nSi no fuiste vos, entrá ya mismo a ${frontUrl}/olvide-password y restablecela de nuevo, o avisale a un administrador.\n\n— Prickets`,
        html: renderEmail({
          title: 'Tu contraseña fue cambiada',
          intro: `Hola ${user.name || ''}, te confirmamos que la contraseña de tu cuenta de Prickets se cambió recién. Por seguridad cerramos todas las sesiones abiertas.`,
          cta:   { label: 'No fui yo, restablecer', url: `${frontUrl}/olvide-password` },
          note:  'Si el cambio lo hiciste vos, podés ignorar este mensaje.',
        }),
      }).catch(() => { /* ya se loguea dentro de sendMail */ });
    }
  } catch (err) {
    console.error('resetPassword error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Error al resetear contraseña' });
  }
};

// POST /api/auth/change-password — usuario logueado cambia su propia contraseña.
// Si must_change_password=1 (primer login con clave del creador o vino via
// magic link), NO exigimos currentPassword: el JWT actual ya prueba que el
// usuario tiene acceso, y la idea es justamente que el creador deje de
// poder loguearse como él.
const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword)
    return res.status(400).json({ error: 'Nueva contraseña requerida' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });

  try {
    const result = await db.query('SELECT id, password_hash, must_change_password FROM users WHERE id = ? AND is_active = 1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (!user.must_change_password) {
      // Cambio normal: pide la actual y valida.
      if (!currentPassword)
        return res.status(400).json({ error: 'Contraseña actual requerida' });
      if (currentPassword === newPassword)
        return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual' });
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
    }
    // En modo must_change_password, saltamos la verificacion: el JWT es la
    // prueba de identidad (le llego via magic link o le dieron una clave
    // que ya esta cambiando).

    const hash = await bcrypt.hash(newPassword, 10);
    // Apaga must_change_password: el usuario ya seteo la suya propia.
    await db.query('UPDATE users SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP, must_change_password = 0 WHERE id = ?', [hash, user.id]);

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('changePassword error:', err.message);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
};

module.exports = { login, me, magicLogin, forgotPassword, forgotPasswordByPhone, resetPassword, checkResetToken, changePassword, verifyTwoFactor };
