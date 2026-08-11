# Documentacion vigente

La documentacion `DOCUMENTACION_COMPLETA_TRAMARSA_LMS_V0.1.md` es historica y
describe el diseno anterior con token de GitHub en el navegador. No debe usarse
como guia de despliegue de esta plantilla.

La arquitectura vigente es:

- Firebase Authentication con correo y contrasena.
- Firestore Spark con perfiles privados por UID y reglas por rol.
- Cloudflare Worker como gateway autenticado hacia el repositorio GitHub privado.
- Token de GitHub solo como secreto del Worker.
- Modulos v2 generables con IA bajo `CONTRATO_MODULO_IA.md`.

Revisa tambien `worker/README.md` antes de configurar el gateway.

Guias de entrega vigentes:

- `guia-implementacion-cliente.html`: guia didactica para empresas receptoras.
- `flujo-ux-lms.html`: flujo visual de uso para administrador y usuario.
- `arquitectura-lms.html`: diagrama visual de arquitectura tecnica real.
