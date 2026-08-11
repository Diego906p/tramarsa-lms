# TRAMARSA LMS

Plataforma LMS corporativa para capacitaciones, evaluaciones y certificados.

Documentacion vigente para entrega:

- `doc/guia-implementacion-cliente.html`
- `doc/flujo-ux-lms.html`
- `doc/arquitectura-lms.html`
- `doc/README_ACTUAL.md`

La documentacion historica `doc/DOCUMENTACION_COMPLETA_TRAMARSA_LMS_V0.1.md`
describe una version anterior y no debe usarse como guia de despliegue.

## Arquitectura vigente

- Frontend estatico: `index.html`, `js/` y `assets/`.
- Firebase Authentication: autenticacion con cuenta interna, presentada al usuario como ingreso por DNI.
- Firestore: usuarios, perfiles, administradores, modulos, asignaciones e historial.
- Cloudflare Worker: gateway seguro hacia GitHub privado y envio de recuperacion de contrasena.
- GitHub privado: paquetes de modulos, audios, imagenes y certificados.
- Resend: correo visual de recuperacion de contrasena.

Ningun token de GitHub, clave privada o cuenta de servicio debe vivir en el
frontend ni en el repositorio. Los secretos se cargan en Cloudflare Worker.
