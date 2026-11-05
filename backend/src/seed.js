/**
 * Prickets - Seed inicial
 * Crea el usuario admin por defecto si no existe.
 * Se ejecuta automáticamente al arrancar el servidor.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./config/database');

async function seed() {
  try {
    const ADMIN_EMAIL    = 'gianfrancodealbera@gmail.com';
    const ADMIN_PASSWORD = '43955952Gd';

    // Migrar admin viejo (email='admin' o 'admin@gianqr.com') al nuevo email/password
    const oldAdmin = await db.query(
      "SELECT id FROM users WHERE email IN ('admin','admin@gianqr.com')"
    );
    if (oldAdmin.rows.length > 0) {
      const hashMig = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await db.query(
        "UPDATE users SET email = ?, password_hash = ? WHERE email IN ('admin','admin@gianqr.com')",
        [ADMIN_EMAIL, hashMig]
      );
      console.log(`✅ Admin migrado a ${ADMIN_EMAIL}`);
    }

    // Crear admin si todavía no existe con el nuevo email
    let adminId;
    const existingAdmin = await db.query(
      "SELECT id FROM users WHERE email = ?", [ADMIN_EMAIL]
    );
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    if (existingAdmin.rows.length === 0) {
      adminId = uuidv4();
      await db.query(
        "INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?,?,?,?,?,1)",
        [adminId, 'Administrador', ADMIN_EMAIL, hash, 'admin']
      );
      console.log(`✅ Admin creado: ${ADMIN_EMAIL}`);
    } else {
      adminId = existingAdmin.rows[0].id;
      await db.query(
        "UPDATE users SET password_hash = ?, role = 'admin', is_active = 1 WHERE id = ?",
        [hash, adminId]
      );
      console.log(`✅ Admin actualizado/verificado: ${ADMIN_EMAIL}`);
    }

    // Garantizar promotor "CASA" asociado al admin (para que la caja pueda generar links)
    const casaRow = await db.query("SELECT id FROM promotors WHERE promo_code = 'CASA'");
    if (casaRow.rows.length === 0) {
      await db.query(
        "INSERT INTO promotors (id, user_id, promo_code, commission, leader_commission) VALUES (?,?,?,?,?)",
        [uuidv4(), adminId, 'CASA', 0, 0]
      );
      console.log('✅ Promotor CASA creado (caja interna)');
    }

    // Migrar vendedor viejo (email='vendedor') a formato email real
    const oldVend = await db.query("SELECT id FROM users WHERE email = 'vendedor'");
    if (oldVend.rows.length > 0) {
      await db.query("UPDATE users SET email = ? WHERE email = 'vendedor'", ['vendedor@gianqr.com']);
      console.log('✅ Vendedor migrado a vendedor@gianqr.com');
    }
  } catch (err) {
    console.error('❌ Error en seed:', err.message);
  }
}

module.exports = seed;
