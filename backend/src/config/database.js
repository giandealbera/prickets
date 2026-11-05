/**
 * Capa de DB con soporte dual:
 *   - SQLite en desarrollo (sin DATABASE_URL)
 *   - PostgreSQL en producción (con DATABASE_URL seteada en Railway/Neon/etc.)
 *
 * Los controllers usan db.query(text, params) y db.transaction(fn). Internamente
 * traducimos sintaxis específica (placeholders, INSERT OR IGNORE, tipos) según
 * el driver activo.
 */
const path = require('path');

const PG_MODE = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Traducciones SQLite -> Postgres
// ---------------------------------------------------------------------------
function translateForPostgres(text) {
  let out = text;

  // INSERT OR IGNORE INTO / INSERT IGNORE INTO -> INSERT INTO ... ON CONFLICT DO NOTHING
  const hadIgnore = /\bINSERT\s+(OR\s+)?IGNORE\s+INTO\b/i.test(out);
  out = out.replace(/\bINSERT\s+(OR\s+)?IGNORE\s+INTO\b/gi, 'INSERT INTO');

  // DATETIME -> TIMESTAMP (postgres no entiende DATETIME)
  out = out.replace(/\bDATETIME\b/gi, 'TIMESTAMP');

  // NOW() ya funciona en postgres tal cual; CURRENT_TIMESTAMP también.
  // FOR UPDATE: postgres lo soporta nativo, no hace falta sacarlo.

  // Reemplazo de placeholders ? por $1,$2,... (último paso para no contar dentro de literales)
  let n = 0;
  out = out.replace(/\?/g, () => `$${++n}`);

  // Si era INSERT OR IGNORE, agregar ON CONFLICT DO NOTHING al final (idempotente)
  if (hadIgnore && !/\bON\s+CONFLICT\b/i.test(out)) {
    out = out.trimEnd().replace(/;$/, '') + ' ON CONFLICT DO NOTHING';
  }

  return out;
}

// SQLite no quiere ;PRAGMA si está embebido, pero acepta cualquier statement.
// Postgres no entiende PRAGMA — saltamos esos statements.
function isSkippableInPg(text) {
  return /^\s*PRAGMA\b/i.test(text);
}

// ---------------------------------------------------------------------------
// SQLite driver (dev)
// ---------------------------------------------------------------------------
let sqliteInstance = null;

async function initSqlite() {
  if (sqliteInstance) return sqliteInstance;
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');

  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../../database/prickets.sqlite');
  const fs = require('fs');
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  sqliteInstance = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await sqliteInstance.run('PRAGMA journal_mode = WAL');
  await sqliteInstance.run('PRAGMA foreign_keys = ON');
  await runMigrations(sqliteQuery, sqliteExec);
  return sqliteInstance;
}

async function sqliteQuery(text, params = []) {
  const db = await initSqlite();
  // Conserva la lógica MySQL legacy para los controllers que aún usen NOW() o IGNORE
  const cleanText = text
    .replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/INSERT IGNORE INTO/gi, 'INSERT OR IGNORE INTO');

  if (cleanText.trim().toUpperCase().startsWith('SELECT')) {
    const rows = await db.all(cleanText, params);
    return { rows };
  }
  const result = await db.run(cleanText, params);
  return { rows: [], insertId: result.lastID, affectedRows: result.changes };
}

async function sqliteExec(sql) {
  const db = await initSqlite();
  await db.exec(sql);
}

let sqliteMutex = Promise.resolve();

async function sqliteTransaction(callback) {
  const db = await initSqlite();

  // Adquirir el lock/mutex para transacciones secuenciales en SQLite
  let releaseLock;
  const lockAcquired = new Promise((resolve) => {
    releaseLock = resolve;
  });

  const previousMutex = sqliteMutex;
  sqliteMutex = lockAcquired;

  await previousMutex;

  await db.run('BEGIN IMMEDIATE');
  try {
    const conn = {
      execute: async (text, params = []) => {
        const cleanText = text
          .replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP')
          .replace(/ FOR UPDATE/gi, '')
          .replace(/INSERT IGNORE INTO/gi, 'INSERT OR IGNORE INTO');
        if (cleanText.trim().toUpperCase().startsWith('SELECT')) {
          const rows = await db.all(cleanText, params);
          return [rows];
        }
        const result = await db.run(cleanText, params);
        return [[], result];
      },
      query: (text, params) => sqliteQuery(text, params),
    };
    const result = await callback(conn);
    await db.run('COMMIT');
    return result;
  } catch (err) {
    try {
      await db.run('ROLLBACK');
    } catch (e) {}
    throw err;
  } finally {
    releaseLock(); // Permitir que proceda la siguiente transacción
  }
}

// ---------------------------------------------------------------------------
// Postgres driver (prod)
// ---------------------------------------------------------------------------
let pgPool = null;

async function initPg() {
  if (pgPool) return pgPool;
  const { Pool, types } = require('pg');

  // COUNT() en Postgres devuelve bigint, y el driver lo entrega como TEXTO
  // para no perder precision con numeros enormes. En SQLite viene como
  // numero. Esa diferencia es una trampa: el codigo que suma dos conteos
  // anda perfecto en desarrollo y en produccion CONCATENA. Paso de verdad:
  // "164" + "50" mostraba 16450 entradas vendidas en vez de 214.
  //
  // Un conteo de entradas jamas se acerca al limite seguro de JS
  // (9 mil billones), asi que lo parseamos a numero y el problema
  // desaparece para todas las consultas de una.
  types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));
  // NUMERIC tiene el mismo tratamiento y aparece en los SUM de dinero.
  types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));

  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway/Neon/Supabase usan SSL pero sin CA en el cliente
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 10,
  });
  await runMigrations(pgQuery, pgExec);
  return pgPool;
}

async function pgQuery(text, params = []) {
  const pool = await initPg();
  if (isSkippableInPg(text)) return { rows: [] };
  const translated = translateForPostgres(text);
  const result = await pool.query(translated, params);
  return {
    rows: result.rows,
    affectedRows: result.rowCount,
    // Postgres no devuelve lastID; los controllers generan UUIDs upfront así
    // que no lo necesitamos. Si alguna query lo necesitara hay que agregar RETURNING id.
  };
}

async function pgExec(sql) {
  // Postgres acepta múltiples statements en una sola query del pool driver,
  // pero los hace en una sola transacción implícita. Para migraciones esto
  // está OK porque queremos atomicidad por bloque.
  const pool = await initPg();
  const translated = translateForPostgres(sql);
  await pool.query(translated);
}

async function pgTransaction(callback) {
  const pool = await initPg();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conn = {
      execute: async (text, params = []) => {
        if (isSkippableInPg(text)) return [[], { rowCount: 0 }];
        const translated = translateForPostgres(text);
        const result = await client.query(translated, params);
        return [result.rows, result];
      },
      query: async (text, params = []) => {
        if (isSkippableInPg(text)) return { rows: [] };
        const translated = translateForPostgres(text);
        const result = await client.query(translated, params);
        return { rows: result.rows, affectedRows: result.rowCount };
      },
    };
    const result = await callback(conn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Migraciones (compartidas entre ambos drivers)
// ---------------------------------------------------------------------------
async function runMigrations(queryFn, execFn) {
  // Tablas base — el wrapper traduce DATETIME -> TIMESTAMP para postgres
  await execFn(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS promotors (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      promo_code  TEXT NOT NULL UNIQUE,
      commission  REAL DEFAULT 0.00,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS venues (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      capacity    INTEGER NOT NULL DEFAULT 200,
      description TEXT,
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id           TEXT PRIMARY KEY,
      venue_id     TEXT,
      name         TEXT NOT NULL,
      description  TEXT,
      date         TEXT NOT NULL,
      start_time   TEXT NOT NULL,
      end_time     TEXT,
      flyer_url    TEXT,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_by   TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (venue_id)   REFERENCES venues(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)  ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_types (
      id           TEXT PRIMARY KEY,
      event_id     TEXT NOT NULL,
      name         TEXT NOT NULL,
      price        REAL NOT NULL DEFAULT 0.00,
      total_quota  INTEGER NOT NULL,
      sold_count   INTEGER NOT NULL DEFAULT 0,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id             TEXT PRIMARY KEY,
      ticket_type_id TEXT NOT NULL,
      event_id       TEXT NOT NULL,
      buyer_name     TEXT NOT NULL,
      buyer_email    TEXT NOT NULL,
      buyer_dni      TEXT,
      qr_code        TEXT NOT NULL UNIQUE,
      payment_method TEXT NOT NULL,
      payment_ref    TEXT,
      amount_paid    REAL NOT NULL DEFAULT 0.00,
      status         TEXT NOT NULL DEFAULT 'pendiente',
      promotor_id    TEXT,
      scanned_at     DATETIME,
      scanned_by     TEXT,
      sold_by        TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id),
      FOREIGN KEY (event_id)       REFERENCES events(id),
      FOREIGN KEY (promotor_id)    REFERENCES promotors(id) ON DELETE SET NULL,
      FOREIGN KEY (scanned_by)     REFERENCES users(id)     ON DELETE SET NULL,
      FOREIGN KEY (sold_by)        REFERENCES users(id)     ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id            TEXT PRIMARY KEY,
      ticket_id     TEXT NOT NULL,
      method        TEXT NOT NULL,
      amount        REAL NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pendiente',
      external_id   TEXT,
      external_data TEXT,
      notes         TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_event_id    ON tickets(event_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status      ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_buyer_email ON tickets(buyer_email);
    CREATE INDEX IF NOT EXISTS idx_events_date         ON events(date);
    CREATE INDEX IF NOT EXISTS idx_ticket_types_event  ON ticket_types(event_id);
    CREATE INDEX IF NOT EXISTS idx_payments_ticket     ON payments(ticket_id);
  `);

  // Filtro de errores esperados al correr migraciones idempotentes. Si el
  // mensaje contiene uno de estos, asumimos que la columna/indice/etc. ya
  // existia y no logueamos. Cualquier otra cosa (disk full, FK constraint,
  // sintaxis mala despues de un refactor) sale a stderr para que se vea.
  const EXPECTED_MIGRATE_ERRORS = [
    'already exists',          // SQLite: "duplicate column name", "index ... already exists"
    'duplicate column',        // SQLite alternativo
    'duplicate_column',        // PG SQLSTATE
    'duplicate_object',        // PG (indices, constraints)
    'duplicate key value',     // PG
    'relation', 'already',     // PG combina "relation X already exists"
  ];
  function isExpectedMigrateError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return EXPECTED_MIGRATE_ERRORS.some(hint => msg.includes(hint));
  }
  async function tryMigrate(label, sql) {
    try { await execFn(sql); }
    catch (e) {
      if (isExpectedMigrateError(e)) return;
      console.error(`[migration] ${label} failed:`, e.message);
    }
  }

  // Migraciones incrementales (cada ALTER en su propio try/catch — fallan si la
  // columna ya existe, eso es esperado y aceptable). Postgres lanza distintos
  // mensajes pero el comportamiento es el mismo. Errores no-esperados se
  // loguean (antes quedaban silenciados).
  const incrementals = [
    'ALTER TABLE promotors ADD COLUMN leader_id TEXT REFERENCES users(id) ON DELETE SET NULL',
    'ALTER TABLE promotors ADD COLUMN leader_commission REAL DEFAULT 400.00',
    'ALTER TABLE users ADD COLUMN apellido TEXT',
    'ALTER TABLE users ADD COLUMN celular TEXT',
    'ALTER TABLE users ADD COLUMN localidad TEXT',
    'ALTER TABLE tickets ADD COLUMN buyer_celular TEXT',
    'ALTER TABLE tickets ADD COLUMN buyer_apellido TEXT',
    'ALTER TABLE tickets ADD COLUMN buyer_edad TEXT',
    'ALTER TABLE tickets ADD COLUMN buyer_localidad TEXT',
    'ALTER TABLE users ADD COLUMN magic_token TEXT',
    'ALTER TABLE events ADD COLUMN sale_start_at DATETIME',
    'ALTER TABLE events ADD COLUMN sale_end_at DATETIME',
    'ALTER TABLE promotors ADD COLUMN zona_id TEXT REFERENCES zonas(id) ON DELETE SET NULL',
    // Reset de contraseña: token random + expiracion. Se invalida tras un uso.
    'ALTER TABLE users ADD COLUMN reset_token TEXT',
    'ALTER TABLE users ADD COLUMN reset_token_expires DATETIME',
    // Nivel minimo para generar un tipo de entrada: 'vendedor' (todos),
    // 'jefe_publicas' o 'owner'. Default 'vendedor' = como se comportaba
    // antes, asi que los tipos ya cargados no cambian.
    "ALTER TABLE ticket_types ADD COLUMN min_role TEXT DEFAULT 'vendedor'",
  ];
  for (const sql of incrementals) {
    await tryMigrate(sql.slice(0, 60), sql);
  }

  await execFn(`CREATE TABLE IF NOT EXISTS rendiciones (
    id          TEXT PRIMARY KEY,
    promotor_id TEXT NOT NULL,
    amount      REAL NOT NULL,
    note        TEXT,
    event_id    TEXT,
    created_by  TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (promotor_id) REFERENCES promotors(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id)    REFERENCES events(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by)  REFERENCES users(id) ON DELETE SET NULL
  )`);

  await tryMigrate('migration', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_magic_token ON users(magic_token)');

  await execFn(`CREATE TABLE IF NOT EXISTS scanner_tokens (
    id             TEXT PRIMARY KEY,
    token          TEXT UNIQUE NOT NULL,
    event_id       TEXT NOT NULL,
    ticket_type_id TEXT NOT NULL,
    label          TEXT,
    all_types      INTEGER DEFAULT 0,
    is_active      INTEGER DEFAULT 1,
    created_by     TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Link de portero que valida TODOS los tipos del evento (1 = todos).
  // El ALTER va DESPUES del CREATE: en bases nuevas la columna ya viene en
  // el CREATE (el ALTER cae en "duplicate column", esperado); en bases
  // viejas creadas sin la columna, este ALTER la agrega. Antes estaba en
  // el array de incrementales (que corre ANTES del CREATE) y en una base
  // fresca fallaba con "no such table" -> la tabla quedaba sin all_types
  // y crear links de portero rompia con 500.
  await tryMigrate('migration', 'ALTER TABLE scanner_tokens ADD COLUMN all_types INTEGER DEFAULT 0');

  // Por que puerta entro cada persona. scanned_by solo sirve para el escaner
  // con login (apunta a users) y los porteros usan links sin cuenta: quedaba
  // en NULL y no habia forma de saber quien escaneo. Con 10 puertas y 3000
  // personas, ante un "mi entrada figura usada y yo no entre" se veia la hora
  // pero no la puerta.
  //
  // Va ACA y no en los incrementals de arriba a proposito: aquellos corren
  // antes de crear scanner_tokens, asi que la clave foranea fallaba con
  // "relation does not exist" y tryMigrate se lo tragaba como error esperado.
  // La columna nunca se creaba y el escaneo reventaba en runtime.
  await tryMigrate('migration',
    'ALTER TABLE tickets ADD COLUMN scanned_token_id TEXT REFERENCES scanner_tokens(id) ON DELETE SET NULL');

  // Un link de portero puede validar VARIOS tipos (o todos). all_types=1 acepta
  // cualquier tipo del evento; si hay filas en scanner_token_types, valida solo
  // esos tipos; si no hay ninguna de las dos cosas, cae al ticket_type_id único
  // (links viejos de un solo tipo siguen funcionando igual).
  await execFn(`CREATE TABLE IF NOT EXISTS scanner_token_types (
    token_id       TEXT NOT NULL,
    ticket_type_id TEXT NOT NULL,
    PRIMARY KEY (token_id, ticket_type_id)
  )`);

  // Suscripciones de Web Push por usuario. Una misma cuenta puede tener
  // varias (un iPhone, una iPad, una compu). endpoint es UNIQUE — si el
  // mismo dispositivo se vuelve a subscribir, el INSERT IGNORE/ON CONFLICT
  // evita duplicados. Cuando el dispositivo se "desubscribe" (logout o
  // toggle off), se borra la fila.
  await execFn(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)');

  await execFn(`CREATE TABLE IF NOT EXISTS zonas (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await execFn(`CREATE TABLE IF NOT EXISTS event_owners (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
  )`);
  await tryMigrate('migration', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_event_owners_unique ON event_owners(event_id, user_id)');

  // Audit log: registro append-only de operaciones sensibles. Sirve
  // para forense post-incidente (quién reseteó la password de tal usuario,
  // quién borró tal evento, quién cambió tal rol). Append-only: no se
  // edita ni se borra desde la UI; el cleanup se hace por antiguedad.
  // - actor_*: quien hizo la accion (user_id puede ser NULL si fue magic
  //   link o accion publica).
  // - action: codigo corto en MAYUSCULAS (USER_UPDATE, USER_DEACTIVATE,
  //   USER_PASSWORD_RESET, EVENT_RESET, EVENT_DELETE_TICKET, ROLE_CHANGE,
  //   COMMISSION_CHANGE, MAGIC_LINK_GENERATED, OWNER_ADDED, OWNER_REMOVED).
  // - target_*: sobre quien/que. resource_type='user'|'event'|'ticket'|...
  // - details: JSON con before/after o info adicional. Texto plano para
  //   simplificar (parseamos en el viewer).
  await execFn(`CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT PRIMARY KEY,
    actor_user_id   TEXT,
    actor_email     TEXT,
    actor_role      TEXT,
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    details         TEXT,
    ip              TEXT,
    user_agent      TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_audit_log_actor   ON audit_log(actor_user_id)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_audit_log_action  ON audit_log(action)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)');

  await execFn(`CREATE TABLE IF NOT EXISTS proveedores (
    id          TEXT PRIMARY KEY,
    nombre      TEXT NOT NULL,
    apellido    TEXT,
    alias_cbu   TEXT,
    notas       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // El zona_id en promotors quedo en el array de incrementales arriba pero
  // intentamos una vez mas DESPUES de crear zonas para que el FK resuelva
  // en SQLite (que comprueba referencias en runtime aunque sea soft).
  await tryMigrate('migration', 'ALTER TABLE promotors ADD COLUMN zona_id TEXT REFERENCES zonas(id) ON DELETE SET NULL');

  // Migracion: eliminar el rol "cajero" (erradicado). Cualquier usuario
  // que quedo con ese rol se promueve a admin. Es idempotente: si no
  // hay cajeros, no hace nada.
  await tryMigrate('migration', `UPDATE users SET role = 'admin' WHERE role = 'cajero'`);

  // Migracion: eliminar el rol "promotor" (erradicado). Cualquier usuario
  // con ese rol se migra a "vendedor". Es idempotente.
  await tryMigrate('migration', `UPDATE users SET role = 'vendedor' WHERE role = 'promotor'`);

  // Multi-tenant lite (Fase 1): users tienen un "created_by" para que cada
  // owner solo vea SU propio staff. Admin pasa a través de todo. Las filas
  // existentes quedan con created_by=NULL = compartidas (visibles para admin
  // solo, no leak entre owners).
  await tryMigrate('migration', 'ALTER TABLE users ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL');
  // Mismo patron para zonas y proveedores: owners solo pueden ver/modificar
  // las suyas. Admin las ve todas. created_by=NULL = legacy/global (admin only).
  await tryMigrate('migration', 'ALTER TABLE zonas ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL');
  await tryMigrate('migration', 'ALTER TABLE proveedores ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL');

  // Cortar venta manual (sold out, decision del dueño). Independiente de
  // sale_end_at (la ventana planeada). Si sales_stopped_at != NULL, la
  // venta esta cerrada. El owner puede reanudarla seteandolo a NULL.
  // El evento sigue accesible para rendiciones, escaneo, reportes.
  await tryMigrate('migration', 'ALTER TABLE events ADD COLUMN sales_stopped_at DATETIME');

  // Ciclo de vida del evento. Hasta ahora "terminado" se deducia de la fecha,
  // asi que no habia forma de distinguir un evento que paso de uno que se
  // cancelo, ni de dejarlo cerrado como registro historico.
  //
  //   DRAFT     — en preparacion, todavia no sale a la venta
  //   ACTIVE    — en curso: se vende y se escanea
  //   FINISHED  — termino. Queda como fotografia historica: se consulta todo
  //               (ventas, escaneos, rendiciones) pero no se opera mas.
  //   CANCELLED — se dio de baja sin realizarse.
  //
  // Convive con is_active y sales_stopped_at, que siguen significando lo
  // mismo (ocultar el evento / cortar la venta) para no romper nada de lo que
  // ya funciona.
  await tryMigrate('migration', "ALTER TABLE events ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'");
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)');
  // Marca de cuando se finalizo, para poder mostrar "finalizado el ..." y
  // distinguir el cierre automatico del manual mas adelante si hace falta.
  await tryMigrate('migration', 'ALTER TABLE events ADD COLUMN finished_at DATETIME');

  // Backfill de los eventos que ya existen. Se corre una sola vez de hecho:
  // despues no quedan filas con status NULL o vacio.
  //   - los dados de baja (is_active=0) pasan a CANCELLED
  //   - los que ya pasaron de fecha, a FINISHED
  //   - el resto queda ACTIVE
  // No se borra ni se pisa ningun dato: solo se completa la columna nueva.
  //
  // Va con queryFn y parametro en vez de SQL crudo: events.date es TEXT y
  // compararlo contra CURRENT_DATE explota en Postgres ("operator does not
  // exist: text < date"). Mandando la fecha de hoy como string, la
  // comparacion es texto contra texto y anda igual en los dos motores.
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    await queryFn(
      "UPDATE events SET status = 'CANCELLED' WHERE is_active = 0 AND (status IS NULL OR status = 'ACTIVE')"
    );
    await queryFn(
      "UPDATE events SET status = 'FINISHED' WHERE is_active = 1 AND date < ? AND (status IS NULL OR status = 'ACTIVE')",
      [hoy]
    );
    await queryFn("UPDATE events SET status = 'ACTIVE' WHERE status IS NULL OR status = ''");
  } catch (e) {
    console.error('[migration] backfill de status fallo:', e.message);
  }

  // Invalidacion de JWT al cambiar/resetear contraseña: el middleware auth
  // rechaza tokens emitidos antes de esta fecha. Filas legacy quedan NULL =
  // sin restriccion (los tokens viejos siguen valiendo hasta su exp natural).
  await tryMigrate('migration', 'ALTER TABLE users ADD COLUMN password_changed_at DATETIME');

  // Expiracion del magic_token: si el link no se usa en 48h, deja de servir.
  // NULL = legacy (los tokens viejos vienen sin expiracion, en el controller
  // los tratamos como aun validos para no romper links emitidos ya).
  await tryMigrate('migration', 'ALTER TABLE users ADD COLUMN magic_token_expires DATETIME');

  // must_change_password: cuando un admin/owner/jefe crea un usuario con una
  // password manual, marcamos must_change_password=1 para que el usuario
  // tenga que setear la suya al primer login. Asi el creador no conserva el
  // poder de loguearse como el. Reset por /auth/change-password lo apaga.
  await tryMigrate('migration', 'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');

  // 2FA / TOTP. totp_secret guarda el secreto base32 (lo usa otplib para
  // verificar el codigo de 6 digitos). totp_enabled=1 significa que el
  // usuario completo el flujo de setup (escaneo de QR + confirmacion con
  // un primer codigo) y a partir de ahi el login pide 2FA.
  await tryMigrate('migration', 'ALTER TABLE users ADD COLUMN totp_secret TEXT');
  await tryMigrate('migration', 'ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');

  // Codigos de recuperacion del 2FA. Si el usuario pierde el dispositivo
  // (Authenticator borrado, telefono perdido), puede usar uno de estos 10
  // codigos de un solo uso para entrar y desactivar el 2FA. Guardamos el
  // hash, no el codigo en claro.
  await execFn(`CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    used_at     DATETIME,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_recovery_user ON totp_recovery_codes(user_id)');

  // Sessions: tracking de JWTs emitidos. Cada login crea una fila con un
  // jti random; el middleware auth chequea que la fila exista y no este
  // revoked_at. Asi podemos:
  //   - listar sesiones activas por usuario (UA, IP, last_seen),
  //   - revocar una sesion concreta sin tocar la password,
  //   - "cerrar sesion en todos los demas dispositivos".
  // password_changed_at sigue siendo el "kill switch" global (sigue
  // invalidando TODOS los jti previos).
  await execFn(`CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    user_agent    TEXT,
    ip            TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at    DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions(revoked_at)');

  // Indices que faltaban en hot paths. Sin estos, cada scan del portero,
  // cada listado de rendiciones, cada audit-log filter eran full table scans.
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_tickets_qr_code     ON tickets(qr_code)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_tickets_promotor    ON tickets(promotor_id)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_tickets_event_status ON tickets(event_id, status)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_tickets_created     ON tickets(created_at)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_tickets_buyer_email ON tickets(buyer_email)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_events_date         ON events(date)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_events_active       ON events(is_active)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_users_created_by    ON users(created_by)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_event_owners_user   ON event_owners(user_id)');

  // Permisos por tipo de entrada. Si NO hay filas para un ticket_type_id,
  // todos los jefes/vendedores del owner pueden venderlo (default abierto).
  // Si hay filas, SOLO los user_ids listados pueden venderlo. El admin/owner
  // siempre puede (bypass). Asi el owner decide, por tipo de entrada, quien
  // puede generarlo.
  await execFn(`CREATE TABLE IF NOT EXISTS ticket_type_sellers (
    ticket_type_id TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ticket_type_id, user_id),
    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)        REFERENCES users(id)        ON DELETE CASCADE
  )`);
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_tt_sellers_tt   ON ticket_type_sellers(ticket_type_id)');
  await tryMigrate('migration', 'CREATE INDEX IF NOT EXISTS idx_tt_sellers_user ON ticket_type_sellers(user_id)');

  // Suscriptores al newsletter.
  //
  // Tabla aparte y no una columna en tickets, por dos razones: una persona
  // puede comprar varias veces y la lista tiene su propio ciclo de vida
  // (alta, baja) que no tiene nada que ver con la entrada.
  //
  // Solo entra quien marca la casilla al comprar. Los emails cargados antes
  // de que existiera la casilla NO se migran: esa gente dio su mail para
  // recibir el QR, nunca acepto recibir novedades.
  //
  // event_id guarda de que evento vino, que es lo que ata cada suscriptor a
  // su organizador: al listar filtramos por los eventos a los que el usuario
  // tiene acceso, asi un dueño no se lleva la base de otro.
  // unsubscribed_at: baja. No borramos la fila, para no volver a sumar a
  // alguien que ya se dio de baja si vuelve a comprar sin marcar.
  await execFn(`CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL,
    nombre          TEXT,
    apellido        TEXT,
    event_id        TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    unsubscribed_at DATETIME,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
  )`);
  await tryMigrate('migration',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_email_event ON newsletter_subscribers(email, event_id)');
  await tryMigrate('migration',
    'CREATE INDEX IF NOT EXISTS idx_newsletter_event ON newsletter_subscribers(event_id)');

  // Backfill multi-tenant: owners cargados antes del fix de create() quedaron
  // con created_by=NULL e invisibles para el admin (el filtro WHERE
  // created_by=admin.id no matchea NULL). Los asignamos al primer admin activo
  // para que aparezcan en la lista. Si hay owners de prueba que no querés,
  // los desactivas desde la UI una vez que se ven. Idempotente: el nuevo
  // create() ya setea created_by, asi que en runs siguientes afecta 0 filas.
  try {
    await execFn(`UPDATE users
                  SET created_by = (SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY created_at ASC LIMIT 1)
                  WHERE role='owner' AND created_by IS NULL`);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
const initDb = () => (PG_MODE ? initPg() : initSqlite());
const query = (text, params) => (PG_MODE ? pgQuery(text, params) : sqliteQuery(text, params));
const transaction = (callback) => (PG_MODE ? pgTransaction(callback) : sqliteTransaction(callback));

module.exports = { query, initDb, transaction, PG_MODE };
