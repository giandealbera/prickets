/**
 * Migración de datos SQLite -> Postgres.
 *
 * Uso:
 *   1. Tener la SQLite local en database/prickets.sqlite (o setear DB_PATH)
 *   2. Tener DATABASE_URL apuntando al Postgres destino (Railway, Neon, etc.)
 *   3. Correr:   node scripts/migrate-sqlite-to-pg.js
 *
 * Lo que hace:
 *   - Abre la SQLite read-only
 *   - Conecta al Postgres destino (el wrapper ya corrió migrations al inicializarse)
 *   - Por cada tabla, lee todas las filas de SQLite y las inserta en Postgres
 *     respetando dependencias (users primero, después promotors, después tickets, etc.)
 *   - Hace INSERT ... ON CONFLICT DO NOTHING para que sea re-corrible (idempotente)
 *
 * IMPORTANTE: corré esto UNA VEZ y verificá los counts antes de switchear el
 * backend a Postgres. Si querés re-correrlo después, podés (es idempotente),
 * pero NUEVAS filas que se crearon en el SQLite local no van a sobrescribir
 * las que ya esten en Postgres (ON CONFLICT DO NOTHING).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL no está seteado. Apuntá a tu Postgres destino antes de correr.');
  process.exit(1);
}

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

// Ordenamos por dependencias FK
const TABLES = [
  'users',
  'venues',
  'events',
  'ticket_types',
  'promotors',
  'tickets',
  'payments',
  'rendiciones',
  'scanner_tokens',
  'zonas',
  'proveedores',
];

async function main() {
  // SQLite source
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../database/prickets.sqlite');
  console.log('SQLite source:', DB_PATH);
  const sqlite = await open({ filename: DB_PATH, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });

  // Postgres destino (vía el wrapper que ya corre las migraciones)
  const db = require('../src/config/database');
  await db.initDb();  // crea las tablas en pg si no existen
  console.log('Postgres conectado, migraciones corridas');

  const stats = {};

  for (const table of TABLES) {
    let rows;
    try {
      rows = await sqlite.all(`SELECT * FROM ${table}`);
    } catch (err) {
      console.log(`  ⚠️  ${table}: no existe en sqlite source, salteo`);
      stats[table] = { source: 0, inserted: 0 };
      continue;
    }

    let inserted = 0;
    let skipped  = 0;

    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map(c => row[c]);
      const placeholders = cols.map(() => '?').join(',');
      // El wrapper traduce ? -> $N y agrega ON CONFLICT DO NOTHING porque usamos OR IGNORE
      const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
      try {
        const result = await db.query(sql, vals);
        if (result.affectedRows > 0) inserted++;
        else skipped++;
      } catch (err) {
        console.error(`  ❌ Error insertando en ${table}:`, err.message);
        console.error('     row:', JSON.stringify(row).slice(0, 200));
        throw err;
      }
    }

    stats[table] = { source: rows.length, inserted, skipped };
    console.log(`  ✓ ${table.padEnd(18)} ${String(inserted).padStart(5)} insertados / ${String(rows.length).padStart(5)} en source (${skipped} ya existían)`);
  }

  console.log('\nResumen:');
  console.table(stats);

  await sqlite.close();
  console.log('\n✅ Migración completa. Verificá los counts antes de switchear DATABASE_URL en producción.');
  process.exit(0);
}

main().catch(err => {
  console.error('Migración falló:', err);
  process.exit(1);
});
