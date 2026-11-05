#!/usr/bin/env node
/**
 * Corre la suite e2e de punta a punta: levanta el backend con una base
 * SQLite temporal, espera a que responda, ejecuta los checks y apaga todo.
 *
 * Existe para que sea un solo comando (`npm test`) tanto en CI como en la
 * maquina de uno, sin tener que acordarse de los puertos ni las env vars.
 *
 * Nunca toca la base de desarrollo: usa un archivo aparte en el temp del
 * sistema y lo borra al terminar.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.E2E_PORT || 4100;
const BASE = `http://127.0.0.1:${PORT}/api`;
const DB   = path.join(os.tmpdir(), `prickets-e2e-${process.pid}.sqlite`);

const limpiarBase = () => {
  for (const suf of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suf); } catch { /* no existia */ }
  }
};

async function esperarServidor(intentos = 40) {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* todavia no levanto */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  limpiarBase();

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      NODE_ENV: 'development',
      JWT_SECRET: process.env.JWT_SECRET || 'e2e_secret_local',
      // Hace que el flujo de reset de contraseña funcione sin proveedor de
      // mail: los correos se imprimen al log en vez de salir.
      MAIL_DEV_STUB: '1',
      // Sin esto el limiter de login (5 intentos) corta la suite, que hace
      // varios logins a proposito.
      RATE_LIMIT_DISABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  server.stdout.on('data', d => logs.push(d.toString()));
  server.stderr.on('data', d => logs.push(d.toString()));

  let code = 1;
  try {
    if (!await esperarServidor()) {
      console.error('El servidor de prueba no respondio a tiempo. Log:\n' + logs.join(''));
      throw new Error('server timeout');
    }

    code = await new Promise((resolve) => {
      const suite = spawn(process.execPath, [path.join(__dirname, 'e2e-test.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, E2E_URL: BASE, E2E_DB: DB },
        stdio: 'inherit',
      });
      suite.on('exit', resolve);
    });

    if (code !== 0) {
      console.error('\n--- log del servidor de prueba ---');
      console.error(logs.join('').slice(-4000));
    }
  } finally {
    server.kill();
    // Damos un instante a que SQLite cierre antes de borrar el archivo.
    await new Promise(r => setTimeout(r, 300));
    limpiarBase();
  }

  process.exit(code);
})();
