/**
 * Mailer unificado.
 *
 * Prioridad de proveedores (el primero configurado se usa):
 *   1. RESEND_API_KEY  → via API REST de Resend (resend.com)
 *   2. SMTP_HOST       → via Nodemailer + cualquier servidor SMTP (Gmail, etc.)
 *   3. Ninguno         → imprime al log y descarta (modo dev / no configurado)
 *
 * Variables de entorno necesarias:
 *
 *   Para Resend:
 *     RESEND_API_KEY=re_xxxxxxxx
 *     MAIL_FROM=Prickets <noreply@tudominio.com>   ← dominio verificado en Resend
 *
 *   Para SMTP (ej Gmail con App Password):
 *     SMTP_HOST=smtp.gmail.com
 *     SMTP_PORT=587          (opcional, default 587)
 *     SMTP_USER=tucuenta@gmail.com
 *     SMTP_PASS=xxxx xxxx xxxx xxxx  ← App Password de Google (no la clave normal)
 *     MAIL_FROM=Prickets <tucuenta@gmail.com>
 *
 * `isMailConfigured()` → true si algún proveedor está listo.
 * `sendMail({ to, subject, text, html })` → envía el mail, siempre resuelve
 *   (nunca lanza; los errores quedan logueados).
 */

const nodemailer = require('nodemailer');

const FROM = () => process.env.MAIL_FROM || 'Prickets <noreply@gianqr.com>';

// ─── Detección de proveedor ───────────────────────────────────────────────────

function hasResend()  { return !!process.env.RESEND_API_KEY; }
function hasSmtp()    { return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }

// Modo de prueba local: MAIL_DEV_STUB=1 hace que el sistema se comporte como
// si el envio estuviera configurado, pero los mails se imprimen al log en vez
// de salir. Nunca aplica en produccion.
const devStub = () =>
  process.env.MAIL_DEV_STUB === '1' && process.env.NODE_ENV !== 'production';

function isMailConfigured() {
  return hasResend() || hasSmtp() || devStub();
}

// ─── Proveedor 1: Resend ──────────────────────────────────────────────────────

async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM(), to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Proveedor 2: SMTP (Nodemailer) ──────────────────────────────────────────

// El transporter se crea una sola vez (pool de conexiones).
let _smtpTransporter = null;
function getSmtpTransporter() {
  if (_smtpTransporter) return _smtpTransporter;
  _smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465, // true solo para 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _smtpTransporter;
}

async function sendViaSmtp({ to, subject, text, html }) {
  const transporter = getSmtpTransporter();
  await transporter.sendMail({ from: FROM(), to, subject, text, html });
}

// ─── Fallback: log al console ─────────────────────────────────────────────────

function logToConsole({ to, subject, text }) {
  if (process.env.NODE_ENV === 'production') {
    console.log(`[mail-stub] would send: to=${to} subject="${subject}" (ningún proveedor configurado)`);
    return;
  }
  console.log('\n📧 MAIL STUB (sin proveedor configurado):');
  console.log(`   To:      ${to}`);
  console.log(`   Subject: ${subject}`);
  console.log(`   Body:    ${text.split('\n').join('\n            ')}`);
  console.log('   (configurar RESEND_API_KEY o SMTP_HOST+SMTP_USER+SMTP_PASS para envio real)\n');
}

// ─── Función principal ────────────────────────────────────────────────────────

const sendMail = async ({ to, subject, text, html }) => {
  if (hasResend()) {
    try {
      await sendViaResend({ to, subject, text, html });
      return { sent: true, provider: 'resend' };
    } catch (err) {
      console.error(`[mail/resend] FALLO el envio a ${to} ("${subject}"):`, err.message);
      return { sent: false, provider: 'resend', error: err.message };
    }
  }

  if (hasSmtp()) {
    try {
      await sendViaSmtp({ to, subject, text, html });
      return { sent: true, provider: 'smtp' };
    } catch (err) {
      console.error(`[mail/smtp] FALLO el envio a ${to} ("${subject}"):`, err.message);
      return { sent: false, provider: 'smtp', error: err.message };
    }
  }

  // Stub: log + descarte
  logToConsole({ to, subject, text });
  return { sent: false, provider: 'stub' };
};

// ─── Helpers de plantilla HTML ────────────────────────────────────────────────

// Escapa texto que va embebido en el HTML del mail. Sin esto, un nombre con
// `<` o `&` rompe el markup (y en el peor caso inyecta etiquetas).
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plantilla HTML comun para los mails transaccionales. Estilos inline
 * porque los clientes de mail ignoran <style> y CSS externo.
 *
 * @param {string}  title      titulo grande dentro del mail
 * @param {string}  intro      parrafo principal (texto plano, se escapa)
 * @param {object}  [cta]      { label, url } boton principal (opcional)
 * @param {string}  [note]     linea chica al pie (texto plano, se escapa)
 */
function renderEmail({ title, intro, cta, note }) {
  const btn = cta
    ? `<tr><td style="padding:8px 0 20px;">
         <a href="${escapeHtml(cta.url)}"
            style="display:inline-block;background:#C9974D;color:#0B0F14;text-decoration:none;
                   font-weight:700;font-size:15px;padding:13px 28px;border-radius:10px;">
           ${escapeHtml(cta.label)}
         </a>
       </td></tr>
       <tr><td style="padding:0 0 18px;color:#6B7280;font-size:12px;line-height:1.6;">
         Si el botón no funciona, copiá y pegá este link en tu navegador:<br>
         <span style="color:#9AA3B2;word-break:break-all;">${escapeHtml(cta.url)}</span>
       </td></tr>`
    : '';

  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#0B0F14;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#0B0F14;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:480px;background:#0D1117;border:1px solid #1E2530;
                    border-radius:16px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,
                    'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="padding:0 0 24px;">
          <span style="font-size:22px;font-weight:900;color:#C9974D;letter-spacing:-0.5px;">Prickets</span>
        </td></tr>
        <tr><td style="padding:0 0 12px;color:#FFFFFF;font-size:19px;font-weight:600;">
          ${escapeHtml(title)}
        </td></tr>
        <tr><td style="padding:0 0 22px;color:#9AA3B2;font-size:14px;line-height:1.65;">
          ${escapeHtml(intro)}
        </td></tr>
        ${btn}
        ${note ? `<tr><td style="padding:16px 0 0;border-top:1px solid #1E2530;
                     color:#6B7280;font-size:12px;line-height:1.6;">
                    ${escapeHtml(note)}
                  </td></tr>` : ''}
      </table>
      <p style="color:#4B5563;font-size:11px;margin:18px 0 0;font-family:-apple-system,
                BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        Prickets — Sistema de entradas
      </p>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Chequea al arrancar que el proveedor de mail realmente ande, y lo deja
 * dicho en los logs.
 *
 * Por que existe: cuando Gmail rechaza la contraseña, el endpoint de
 * recuperacion igual contesta "te enviamos las instrucciones" (la respuesta
 * es generica a proposito, para no filtrar que emails estan registrados).
 * El error real quedaba enterrado en los logs y solo aparecia DESPUES de que
 * alguien pidiera un reset. Resultado: la unica forma de saber si el mail
 * andaba era pedirselo a un usuario real y preguntarle si le llego.
 *
 * Con esto, apenas levanta el server los logs dicen si las credenciales
 * sirven, sin tener que mandar nada.
 *
 * No corta el arranque si falla: que no salgan los mails es un problema,
 * pero es mucho peor que se caiga la venta de entradas por eso.
 */
async function checkMailProvider() {
  if (hasResend()) {
    console.log('[mail] proveedor: Resend');
    return { ok: true, provider: 'resend' };
  }

  if (hasSmtp()) {
    try {
      await getSmtpTransporter().verify();
      console.log(`[mail] proveedor: SMTP ${process.env.SMTP_HOST} como ${process.env.SMTP_USER} — credenciales OK`);
      return { ok: true, provider: 'smtp' };
    } catch (err) {
      // El detalle importa: "535 Username and Password not accepted" se
      // arregla distinto que un timeout de conexion.
      console.error(`[mail] SMTP RECHAZADO por ${process.env.SMTP_HOST} como ${process.env.SMTP_USER}: ${err.message}`);
      console.error('[mail] los mails NO van a salir hasta que se corrija. Si es una App Password de Gmail, revisar que sean 16 letras sin espacios.');
      return { ok: false, provider: 'smtp', error: err.message };
    }
  }

  console.warn('[mail] sin proveedor configurado: los mails se descartan. Setear RESEND_API_KEY o SMTP_HOST+SMTP_USER+SMTP_PASS.');
  return { ok: false, provider: 'stub' };
}

module.exports = { sendMail, isMailConfigured, checkMailProvider, renderEmail, escapeHtml };
