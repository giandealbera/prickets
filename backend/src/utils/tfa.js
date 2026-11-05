// Helpers de 2FA (TOTP).
//
// Usamos otplib (RFC 6238) — compatible con Google Authenticator,
// 1Password, Authy, Microsoft Authenticator, etc.
//
// Generacion: el secreto es base32 (~160 bits). El usuario lo agrega a su
// app via QR (otpauth://...). Al confirmar setup nos manda el primer
// codigo de 6 digitos para que verifiquemos.
//
// Verificacion: aceptamos 1 step de tolerancia (la app puede generar el
// del paso anterior o siguiente si los relojes estan ligeramente
// desfasados). window=1 cubre +/- 30s.

const crypto = require('crypto');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');

// 30s por step, 1 step de tolerancia (acepta el codigo actual + el previo
// y el siguiente). Asi un usuario que tarda en tipear no falla por 1s.
authenticator.options = { step: 30, window: 1 };

const ISSUER = process.env.TFA_ISSUER || 'Prickets';

function generateSecret() {
  return authenticator.generateSecret();
}

function otpauthUri(email, secret) {
  // Formato estandar: el accountName + issuer aparecen en la app.
  return authenticator.keyuri(email, ISSUER, secret);
}

async function otpauthQrDataUrl(uri) {
  return QRCode.toDataURL(uri, { width: 240, margin: 1 });
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  // Sanitizar: a veces vienen con espacios "123 456"
  const clean = String(token).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    return authenticator.verify({ token: clean, secret });
  } catch {
    return false;
  }
}

// Generar 10 codigos de recuperacion de un solo uso. Formato XXXX-XXXX
// (8 chars hex, agrupados, evita confusion 0/O y 1/l).
function generateRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 chars
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

// Hash de codigo de recuperacion. SHA-256 simple — los codigos ya tienen
// 32 bits de entropia y son one-time, no necesitamos bcrypt.
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
}

module.exports = {
  generateSecret,
  otpauthUri,
  otpauthQrDataUrl,
  verifyToken,
  generateRecoveryCodes,
  hashRecoveryCode,
};
