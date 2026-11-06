# Prickets — cómo trabajar en este repo

Sistema de venta y control de entradas con QR para boliches. **Está en producción
con eventos reales y clientes que pagan.** Un error acá no es un bug: es una fila
parada en la puerta de un boliche a las 2 de la mañana.

## Lo que más importa

**Reproducir antes de arreglar.** Si no se pudo reproducir el problema, no se
sabe si se arregló. Después del arreglo, volver a correr lo mismo que lo
reproducía.

**Dejar un check permanente.** Todo bug que llegó a producción vuelve, salvo que
quede una prueba que lo atrape. Van en `backend/scripts/e2e-test.js`.

**SQLite verde no garantiza nada.** Desarrollo corre sobre SQLite y producción
sobre PostgreSQL. Esa diferencia ya dejó pasar: un `ALTER` que corría antes de
existir la tabla y fallaba en silencio, timestamps leídos con tres horas de
corrimiento, y conteos que volvían como texto en vez de número. Todos verdes en
SQLite. CI ahora corre las dos cosas; en local, ante cualquier cambio de SQL,
levantar un Postgres y correr la suite contra él.

## Comandos

```bash
cd backend && npm test      # suite e2e completa, base temporal, no toca nada
cd frontend && npm run build
```

Contra PostgreSQL: levantar el server con `DATABASE_URL` y `PGSSL=disable`, y
correr `node scripts/e2e-test.js` con el mismo `DATABASE_URL` y `E2E_URL`.

Simulación de una noche entera (3000 entradas, varios porteros, ataques):
`node scripts/simular-evento.js`, con un backend ya levantado.

## Autorizaciones permanentes

- **Pushear a master sin preguntar**, siempre que la suite pase y el build esté
  limpio. El deploy sale solo (Render + Vercel) y después hay que verificar
  contra producción, no darlo por hecho.
- Commits en español, explicando **por qué** y qué se verificó, no solo qué
  cambió.
- Correr la suite, los builds y las simulaciones cuantas veces haga falta.

## Lo que NO se hace sin preguntar

- Borrar o pisar datos de producción. El sistema **no borra eventos a propósito**:
  son el registro de lo que pasó. Para sacarlos de circulación se cancelan, que
  es reversible.
- Tocar variables de entorno o renombrar servicios en Render o Vercel: cambian
  URLs vivas y reinician el backend.
- Comprar dominios o cualquier otra cosa.
- Entrar con la contraseña de nadie. Para operar sobre producción hace falta una
  sesión ya abierta en el navegador.

## Trampas conocidas

**Hay strings `gianqr` que son infraestructura, no marca.** El producto se llama
Prickets desde el 2026-11-05, pero estos NO se tocan:

- `frontend/src/api/config.js` → `gianqr.onrender.com`, el host real del backend.
- `backend/src/seed.js` → busca `admin@gianqr.com` para migrar cuentas viejas.
- `backend/src/utils/mailer.js` → el dominio del remitente.
- La carpeta local sigue siendo `Desktop/gianqr`; el repo es `giandealbera/prickets`.

**Los QR viejos empiezan con `GIANQR-` y los nuevos con `PRICKETS-`.** El prefijo
no se valida en ningún lado: se busca el código exacto en `qr_code`. No agregar
validación por prefijo o se quedan afuera las entradas ya vendidas.

**`tryMigrate` se traga los errores "esperados"**, así que el ORDEN de las
migraciones en `config/database.js` importa: una FK a una tabla que todavía no
existe falla sin que nadie se entere.

**Cambiar la clave del token en `localStorage` desloguea a todos de golpe** —
porteros y vendedores incluidos, en plena venta. Ver `frontend/src/lib/authToken.js`.

**CORS**: `FRONTEND_URL` lista los origins separados por coma. El server agrega
solo el par www/apex, pero cualquier otro dominio (por ejemplo el de Vercel) hay
que ponerlo a mano.

## Roles

`vendedor` < `jefe_publicas` < `owner` < `admin`. Cada tipo de entrada tiene un
`min_role`: quien está por encima también puede emitirla. La lógica vive en
`backend/src/utils/nivelTipoEntrada.js` y la usan los cuatro caminos de emisión.
