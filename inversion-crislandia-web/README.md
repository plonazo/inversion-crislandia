# Inversión Crislandia - versión online

Esta versión usa PostgreSQL en lugar de SQLite. Necesita estas variables de entorno:

- `DATABASE_URL`: cadena de conexión de PostgreSQL.
- `SESSION_SECRET`: una cadena larga y aleatoria.
- `ADMIN_USER`: nombre del administrador inicial (opcional, por defecto `admin`).
- `ADMIN_PASSWORD`: contraseña del administrador inicial (recomendado).
- `NODE_ENV=production` en el servidor.

En local, para probarla, Node.js 20+ y una base PostgreSQL son necesarios.

No subas contraseñas ni la `DATABASE_URL` a GitHub. Configúralas como variables de entorno en el servicio donde alojes la aplicación.
