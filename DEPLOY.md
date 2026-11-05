# Deploy Prickets a internet

Esta guía deploya el proyecto en **Railway** (backend Node + SQLite con volumen
persistente) y **Vercel** (frontend Vite). Tiempo estimado: 15 minutos.

## Requisitos
- Tener el repo en GitHub
- Cuenta en [Railway](https://railway.app) (login con GitHub, $5 de crédito gratis)
- Cuenta en [Vercel](https://vercel.com) (login con GitHub, plan Hobby gratis)

---

## Paso 1 — Backend en Railway

1. Entra a https://railway.app/new
2. **Deploy from GitHub repo** → seleccionar el repo `gianqr`
3. En el wizard del nuevo servicio:
   - **Root directory**: `backend`
   - **Build command**: (default) `npm install`
   - **Start command**: (default) `npm start`
4. Apenas se cree el servicio, hacer click en él y:
   - Ir a **Settings → Networking → Generate Domain** (te dará una URL tipo
     `gianqr-backend-production.up.railway.app`)
   - Ir a **Settings → Volumes → New Volume**
     - Mount path: `/data`
     - Size: 1 GB (suficiente para miles de tickets)
5. Ir a **Variables** y agregar:

   ```
   PORT=4000
   NODE_ENV=production
   JWT_SECRET=<usa un valor random largo, ej openssl rand -hex 32>
   JWT_EXPIRES_IN=8h
   DB_PATH=/data/gianqr.db
   FRONTEND_URL=https://gianqr.vercel.app
   ```
   (FRONTEND_URL es provisorio, lo actualizamos cuando deployemos el front)

6. Railway re-deploya solo. Esperar a que el log diga `Prickets Backend v1.0`
7. Verificar abriendo `https://[tu-backend].up.railway.app/api/health` →
   debe responder `{"status":"ok","sistema":"GianQR","version":"1.0.0"}`

---

## Paso 2 — Frontend en Vercel

1. Entra a https://vercel.com/new
2. Importar el repo `gianqr`
3. En el wizard:
   - **Framework Preset**: Vite (auto-detecta)
   - **Root Directory**: `frontend`
   - **Build Command**: (default) `npm run build`
   - **Output Directory**: (default) `dist`
4. En **Environment Variables**, agregar:

   ```
   VITE_API_URL=https://[tu-backend].up.railway.app/api
   ```
   (la URL de Railway del paso anterior, terminada en `/api`)

5. Click **Deploy**. Esperar 1-2 minutos.
6. Vercel te da una URL tipo `gianqr-xxxxx.vercel.app`. Anotala.

---

## Paso 3 — Actualizar CORS del backend

1. Volver a Railway → tu servicio → **Variables**
2. Editar `FRONTEND_URL` y pegar la URL de Vercel (sin `/` al final)
3. Railway re-deploya solo

---

## Paso 4 — Probar end-to-end

1. Abrir la URL de Vercel
2. Login con `admin / admin123`
3. Crear un evento de prueba en `/eventos → + Nuevo evento`
4. Crear un tipo de entrada en el evento
5. Ir a `/caja` → generar un link
6. Copiar el link, abrirlo en otra ventana (modo incógnito o en el celular)
7. Completar los datos del comprador → ver el QR
8. Volver al admin → `/admin/control` → ver la persona en la tabla en
   tiempo real

---

## Cambiar las credenciales antes de la demo

El seed crea usuarios `admin/admin123` y `vendedor/vendedor123`. **Antes**
de mostrar la app a tus socios:

1. Entrar como admin
2. `/admin/usuarios` → crear un nuevo admin con tu nombre y contraseña fuerte
3. Cambiar el rol del admin original a `cajero` o desactivarlo
4. (Opcional) Hacer lo mismo con el `vendedor` seed

---

## Custom domain (opcional)

### En Vercel (frontend)
- Settings → Domains → Add Domain
- Pegar tu dominio (ej `gianqr.com`)
- Configurar DNS según las instrucciones de Vercel

### En Railway (backend)
- Settings → Networking → Custom Domain
- Pegar subdominio (ej `api.gianqr.com`)
- Configurar DNS según las instrucciones

Después actualizar `FRONTEND_URL` en Railway y `VITE_API_URL` en Vercel.

---

## Costos estimados (mensuales)

| Servicio | Plan | Costo |
|----------|------|-------|
| Railway (backend + volumen 1GB) | Pro | ~$5 USD/mes |
| Vercel (frontend) | Hobby | $0 |
| Dominio propio (opcional) | — | ~$12 USD/año |

Sin dominio propio, el costo es **~$5 USD/mes**.

---

## Troubleshooting

**El backend tira "CORS error" en el navegador**
→ Verificar que `FRONTEND_URL` en Railway coincide EXACTAMENTE con la URL
  de Vercel (sin barra al final, https incluido).

**El frontend muestra "Network Error"**
→ Verificar que `VITE_API_URL` en Vercel termina en `/api` y apunta al
  backend de Railway. Después de cambiar, hacer Redeploy.

**Login falla con "Credenciales incorrectas"**
→ El seed corre la primera vez que arranca el backend. Si la DB ya existía
  vacía y no se creó el admin, hacer Redeploy del servicio Railway.

**Quiero resetear todo**
→ Railway → Variables → eliminar el volumen y crearlo de nuevo. El próximo
  deploy correrá el seed limpio.
