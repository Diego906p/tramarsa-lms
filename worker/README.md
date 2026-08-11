# Gateway privado de archivos

Este Worker es la única pieza que conoce el token de GitHub. Verifica los ID
tokens de Firebase y delega la autorización de cada archivo a las reglas de
Firestore usando el token del propio usuario.

Variables no secretas: `FIREBASE_PROJECT_ID`, `GITHUB_BRANCH`,
`ALLOWED_ORIGINS` y `ADMIN_EMAILS` se definen en `wrangler.toml` o en el panel
de Cloudflare. En producción, `ALLOWED_ORIGINS` debe ser la URL exacta del LMS.

Secreto requerido al desplegar:

```text
GITHUB_TOKEN     Token fine-grained, Contents read/write, limitado a este repo.
RESEND_API_KEY    Clave de envio de Resend; en demostracion entrega al titular de Resend.
FIREBASE_SERVICE_ACCOUNT_JSON
                 JSON de una cuenta con Firebase Authentication Admin.
```

El token no debe guardarse en ningún archivo, variable del frontend ni chat.
El Worker admite archivos de hasta 25 MB; si un curso supera ese tamaño se
divide el audio/contenido o se necesitará una arquitectura de almacenamiento
distinta.
