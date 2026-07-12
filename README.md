# TRAMARSA LMS

Plataforma de capacitaciones corporativas (inducciones, cursos, evaluaciones, certificados) para Grupo Tramarsa. Aplicación web **sin backend propio**: el frontend (HTML/CSS/JS estático, sin build step) corre en el navegador y se apoya en servicios externos administrados para persistencia, autenticación y almacenamiento de archivos.

Documentación técnica y funcional completa: [`doc/DOCUMENTACION_COMPLETA_TRAMARSA_LMS_V0.1.md`](doc/DOCUMENTACION_COMPLETA_TRAMARSA_LMS_V0.1.md).

---

## Arquitectura

```
Navegador (cliente)
  index.html + js/*.js         ← única "aplicación", sin servidor propio
        │
        ├── Firebase Authentication   (login)
        ├── Cloud Firestore           (usuarios, módulos, asignaciones, historial)
        └── GitHub REST API           (repo dedicado: paquetes de módulo + certificados PDF)
```

- **Frontend:** HTML/CSS/JavaScript vanilla, ES Modules nativos, sin framework ni build step.
- **Autenticación:** Firebase Authentication — el trabajador ingresa con DNI, la app resuelve el DNI a su correo real internamente.
- **Base de datos:** Cloud Firestore como única fuente de verdad de negocio.
- **Archivos:** paquetes de módulo (`.zip`/`.rar`) y certificados (`.pdf`) se almacenan en un repositorio de GitHub dedicado, subidos automáticamente desde el panel de administración.
- **Reproductor de contenido:** arquitectura universal — cualquier módulo con un `index.html` en su raíz se ejecuta dentro de un `<iframe>` aislado (sandbox, origen opaco) y se comunica con el LMS mediante un contrato `postMessage` documentado. El LMS nunca inspecciona la estructura interna del módulo.
- **Responsive:** toda la interfaz (login, ambos paneles, modales, reproductor) está adaptada a móvil/tablet/desktop (breakpoint principal 880px) — ver sección 31 de la documentación técnica.

Detalle completo de cada pieza (modelo de datos, protocolo SDK, decisiones de arquitectura, limitaciones conocidas) en la documentación técnica enlazada arriba.

---

## Configuración requerida (no incluida en el repositorio)

Este proyecto necesita credenciales propias para funcionar. **Ningún archivo de configuración con valores reales debe commitearse.**

### 1. Firebase
1. Crear un proyecto en [Firebase Console](https://console.firebase.google.com).
2. **Authentication** → Sign-in method → habilitar **Correo electrónico/contraseña**.
3. **Firestore Database** → crear la base de datos, y pegar las reglas de [`firestore.rules`](firestore.rules).
4. Completar `js/firebase-config.js` con la configuración de tu app web (`apiKey`, `authDomain`, `projectId`, etc.).

### 2. Repositorio de GitHub para módulos
1. Crear un repositorio dedicado para almacenar los paquetes de módulo y certificados.
2. Generar un **Personal Access Token fine-grained**, con permiso **Contents: Read and write**, limitado únicamente a ese repositorio.
3. Completar `js/github-config.js` con el owner, repo, rama y token.

> **Nota de seguridad:** esta app corre 100% en el navegador y se sirve como archivos estáticos, por lo que cualquier credencial en `js/firebase-config.js`/`js/github-config.js` queda visible en el código fuente servido. Usa siempre tokens de alcance mínimo (un solo repositorio, solo lectura/escritura de contenido) y nunca un token con permisos amplios de cuenta u organización.

Mientras estos dos archivos no estén configurados, la app muestra una pantalla de aviso explícita en vez de fallar en silencio.

---

## Ejecutar en local

Sin build step — cualquier servidor estático sirve. Ejemplo:

```bash
python -m http.server 8000
```

Luego abrir `http://localhost:8000`. **No abrir `index.html` directo con doble clic (`file://`)** — la carga de módulos `.rar` y algunas operaciones de red no funcionan bajo ese protocolo.

---

## Estructura del proyecto

```
index.html                 Estructura HTML + CSS de toda la plataforma
firestore.rules            Reglas de seguridad de Firestore
js/
  firebase-config.js       Credenciales Firebase (no versionar valores reales)
  firebase-secondary.js    Crea cuentas de Auth sin cerrar la sesión del admin
  github-config.js         Credenciales del repo de módulos (no versionar valores reales)
  github-storage.js        Sube archivos a GitHub vía Git Data API
  db-firestore.js          Capa de acceso a datos (CRUD Firestore)
  app.js                   Lógica de negocio + UI (login, ambos paneles)
  reproductor.js           Motor de reproducción de módulos, evaluación, certificados
  modulo-loader/           Driver + resolver + adaptadores del reproductor universal
  vendor/libarchive/       WASM para leer archivos .rar en el navegador
```

Ver la documentación técnica completa para el detalle de cada archivo, el modelo de datos, el protocolo SDK del reproductor, y el formato oficial para crear nuevos módulos de capacitación.

---

## Estado del proyecto

Versión **V0.1** — funcional y validada de punta a punta. Limitaciones conocidas y mejoras pendientes documentadas en la sección correspondiente de [`doc/DOCUMENTACION_COMPLETA_TRAMARSA_LMS_V0.1.md`](doc/DOCUMENTACION_COMPLETA_TRAMARSA_LMS_V0.1.md).
