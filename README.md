# 🎵 Prickets — Sistema de Ventas de Entradas con QR

Sistema completo para gestión y venta de entradas con código QR para boliche. Incluye panel de administración, escáner de puerta, caja de ventas y panel de promotores.

---

## ⚡ Stack tecnológico

| Capa       | Tecnología                    |
|------------|-------------------------------|
| Frontend   | React 18 + Vite + Tailwind CSS |
| Backend    | Node.js + Express             |
| Base de datos | PostgreSQL                 |
| Pagos      | MercadoPago SDK + Efectivo + Transferencia |
| QR         | qrcode (backend) + qrcode.react (frontend) |
| Auth       | JWT (8hs de expiración)       |

---

## 📁 Estructura del proyecto

```
gianqr/
├── database/
│   └── schema.sql          ← Schema PostgreSQL completo
├── backend/
│   ├── server.js           ← Punto de entrada
│   ├── .env.example        ← Variables de entorno (copiá a .env)
│   └── src/
│       ├── config/         ← Conexión a la DB
│       ├── middleware/     ← Auth + control de roles
│       ├── routes/         ← Rutas API
│       └── controllers/    ← Lógica de negocio
└── frontend/
    ├── src/
    │   ├── pages/
    │   │   ├── admin/      ← Dashboard, Eventos, Usuarios, Reportes
    │   │   ├── cashier/    ← Venta de entradas
    │   │   ├── scanner/    ← Escáner QR de portero
    │   │   └── promoter/   ← Panel del promotor
    │   ├── context/        ← Auth context
    │   └── api/            ← Axios configurado
    └── ...
```

---

## 🚀 Instalación paso a paso

### 1. Requisitos previos

- **Node.js** 18 o superior
- **PostgreSQL** 14 o superior
- (Opcional) **npm** o **yarn**

---

### 2. Base de datos

```bash
# Crear la base de datos
psql -U postgres -c "CREATE DATABASE gianqr;"

# Ejecutar el schema
psql -U postgres -d gianqr -f database/schema.sql
```

Esto crea todas las tablas, índices y un usuario admin inicial:
- **Email:** `admin@gianqr.com`
- **Password:** `Admin1234!`

> ⚠️ **Cambiá la contraseña del admin desde el panel de Usuarios antes de usar en producción.**

---

### 3. Backend

```bash
cd backend

# Copiar variables de entorno
cp .env.example .env

# Editar .env con tus datos
nano .env   # o con cualquier editor

# Instalar dependencias
npm install

# Correr en desarrollo
npm run dev

# Correr en producción
npm start
```

El servidor levanta en `http://localhost:4000`

**Variables importantes en `.env`:**
```
DB_HOST=localhost
DB_NAME=gianqr
DB_USER=postgres
DB_PASSWORD=tu_password

JWT_SECRET=una_clave_muy_larga_y_secreta

MP_ACCESS_TOKEN=APP_USR-...   # de tu cuenta de MercadoPago
FRONTEND_URL=http://localhost:5173
```

---

### 4. Frontend

```bash
cd frontend

# Instalar dependencias
npm install

# Correr en desarrollo
npm run dev

# Build para producción
npm run build
```

El frontend corre en `http://localhost:5173`

---

## 👤 Roles del sistema

| Rol         | Acceso                                          |
|-------------|--------------------------------------------------|
| **admin**   | Todo: eventos, usuarios, reportes, caja, scanner |
| **cajero**  | Venta de entradas en caja                        |
| **portero** | Escáner QR en la puerta                          |
| **promotor**| Ver sus propias ventas y su link de promotor     |

---

## 📱 Pantallas del sistema

### Admin
- **Dashboard** → estadísticas generales y próximos eventos
- **Eventos** → crear y gestionar eventos con múltiples salas y tipos de entrada
- **Usuarios** → crear porteros, cajeros y promotores
- **Reportes** → ventas filtradas por evento/fecha con totales por método de pago

### Cajero (`/caja`)
- Seleccionar evento y tipo de entrada
- Cargar datos del comprador
- Elegir método de pago (efectivo / transferencia / MercadoPago)
- El QR se genera y muestra automáticamente para imprimir

### Portero (`/escaner`)
- Escáner en tiempo real con la cámara del celular o tablet
- Resultado inmediato: ✅ válido / ❌ ya usado / ❌ no pagado
- Funciona con QR en pantalla o impreso

### Promotor (`/promotor`)
- Ver link de venta con su código único
- Ver sus ventas y el monto total generado

---

## 💳 Integración MercadoPago

1. Creá una cuenta en [MercadoPago Developers](https://www.mercadopago.com.ar/developers)
2. Obtenés el **Access Token** y **Public Key** de tu aplicación
3. Los pegás en el `.env` del backend
4. Para webhooks en producción, configurá la URL:
   `https://tu-dominio.com/api/payments/mp/webhook`

---

## 🔌 API Endpoints principales

```
POST   /api/auth/login           Iniciar sesión
GET    /api/auth/me              Usuario actual

GET    /api/events               Listar eventos (público)
POST   /api/events               Crear evento (admin)
GET    /api/events/:id/stats     Estadísticas de evento (admin)

GET    /api/tickets              Listar tickets (admin/cajero)
POST   /api/tickets              Vender entrada (admin/cajero)
POST   /api/tickets/scan         Escanear QR (admin/portero)

GET    /api/users                Listar usuarios (admin)
POST   /api/users                Crear usuario (admin)

POST   /api/payments/mp/create-preference   Crear pago MP
GET    /api/payments/report      Reporte de pagos (admin)
```

---

## 🔐 Seguridad

- Contraseñas hasheadas con **bcrypt** (10 rounds)
- Autenticación via **JWT** con expiración de 8 horas
- Roles verificados en cada endpoint del backend
- Variables sensibles en `.env` (nunca commitear a git)

---

## 🛠️ Próximas mejoras sugeridas

- [ ] Envío de QR por email al comprador
- [ ] Página pública de venta online con MercadoPago
- [ ] App móvil del escáner (PWA)
- [ ] Exportar reportes a Excel/CSV
- [ ] Múltiples boliches / multitenancy
- [ ] Historial de escaneos del portero

---

*Prickets v1.0 — Sistema de ventas de entradas para boliche*
