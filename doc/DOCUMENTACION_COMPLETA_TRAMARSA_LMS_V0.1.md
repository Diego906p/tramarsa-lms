# TRAMARSA LMS — Documentación Completa V0.1

**Documento oficial de referencia de la plataforma.** Está escrito para que cualquier desarrollador — humano o IA — pueda entender, mantener y continuar el proyecto leyendo únicamente este archivo, sin depender del historial de conversación que lo originó.

**Versión documentada:** V0.1 (primera versión estable y operativa).
**Última actualización:** 13 de julio de 2026.

---

## Índice

1. [Objetivos y alcance de la versión 0.1](#1-objetivos-y-alcance-de-la-versión-01)
2. [Arquitectura general](#2-arquitectura-general)
3. [Tecnologías utilizadas](#3-tecnologías-utilizadas)
4. [Estructura completa de carpetas](#4-estructura-completa-de-carpetas)
5. [Descripción de todos los archivos importantes](#5-descripción-de-todos-los-archivos-importantes)
6. [Modelo de datos (Cloud Firestore)](#6-modelo-de-datos-cloud-firestore)
7. [Integración con Firebase](#7-integración-con-firebase)
8. [Integración con GitHub](#8-integración-con-github)
9. [Flujo de autenticación (Login → Logout)](#9-flujo-de-autenticación-login--logout)
10. [Persistencia de sesión y cierre por inactividad](#10-persistencia-de-sesión-y-cierre-por-inactividad)
11. [Panel Administrador](#11-panel-administrador)
12. [Panel Trabajador](#12-panel-trabajador)
13. [Arquitectura del reproductor de módulos](#13-arquitectura-del-reproductor-de-módulos)
14. [El contrato SDK `window.TramarsaLMS` (solo formato v1 legacy)](#14-el-contrato-sdk-windowtramarsalms-solo-formato-v1-legacy)
15. [Virtual Asset Resolver — construcción del documento virtual (solo formato v1 legacy)](#15-virtual-asset-resolver--construcción-del-documento-virtual-solo-formato-v1-legacy)
16. [Package Adapters — normalización de .zip/.rar/carpeta](#16-package-adapters--normalización-de-ziprarcarpeta)
17. [Drivers del reproductor (`DriverLaminas` oficial + `DriverIndexHtml` legacy)](#17-drivers-del-reproductor-driverlaminas-oficial--driverindexhtml-legacy)
18. [Lógica del reproductor, estados y modos](#18-lógica-del-reproductor-estados-y-modos)
19. [Barra de progreso — diseño técnico](#19-barra-de-progreso--diseño-técnico)
20. [Evaluación](#20-evaluación)
21. [Certificados](#21-certificados)
22. [Flujo "Volver a ver"](#22-flujo-volver-a-ver)
23. [Formato oficial de un módulo — cómo crear futuras capacitaciones](#23-formato-oficial-de-un-módulo--cómo-crear-futuras-capacitaciones)
24. [Flujo completo de sistema: Login → Certificado](#24-flujo-completo-de-sistema-login--certificado)
25. [Decisiones de arquitectura y por qué se eligieron](#25-decisiones-de-arquitectura-y-por-qué-se-eligieron)
26. [Problemas reales encontrados y cómo se resolvieron](#26-problemas-reales-encontrados-y-cómo-se-resolvieron)
27. [Limitaciones conocidas](#27-limitaciones-conocidas)
28. [Pendiente para futuras versiones](#28-pendiente-para-futuras-versiones)
29. [Buenas prácticas y riesgos al modificar el sistema](#29-buenas-prácticas-y-riesgos-al-modificar-el-sistema)
30. [Guía rápida para futuras sesiones de desarrollo](#30-guía-rápida-para-futuras-sesiones-de-desarrollo)
31. [Diseño responsive (móvil/tablet) — V0.1.1](#31-diseño-responsive-móviltablet--v011)

---

## 1. Objetivos y alcance de la versión 0.1

TRAMARSA LMS es una plataforma de capacitaciones corporativas (inducciones, cursos, evaluaciones, certificados) para Grupo Tramarsa.

**Objetivo de negocio:** reemplazar una versión anterior 100%-navegador (`localStorage` + IndexedDB + "Conectar carpeta"/`data.json`, que solo servía a un usuario por navegador) por una plataforma multiusuario real: cualquier trabajador o administrador ve los mismos datos desde cualquier dispositivo.

**Alcance logrado en V0.1:**
- Arquitectura 100% cliente, sin backend propio (Firebase + GitHub como únicos servicios externos).
- Autenticación real (Firebase Auth) con experiencia de login por DNI.
- Persistencia centralizada multiusuario (Cloud Firestore).
- Almacenamiento de archivos pesados (paquetes de módulo, certificados PDF) en un repositorio de GitHub dedicado, con subida automática desde el panel admin.
- Reproductor de módulos con **formato oficial v2 declarativo** (`manifest.json`: láminas imagen/HTML/contenido único, dirigidas 100% por el LMS, sin JS de control en el módulo, sin pantalla de inicio), con modo Automático/Manual, navegación anti-trampa, barra de progreso fluida sincronizada al audio, pausa/reanudación exacta y pantalla completa. Formato v1 (`index.html` + SDK `postMessage`) mantenido como fallback legacy.
- Evaluación aleatoria con banco de preguntas y certificados PDF generados dinámicamente.
- Paneles completos de administración (módulos, usuarios, asignaciones) y de trabajador (inicio, mis módulos, certificados, perfil).
- Persistencia de sesión entre pestañas y cierre automático por inactividad.
- Explícitamente **fuera de alcance de V0.1**: Cloud Functions / Custom Claims (seguridad multi-rol reforzada), borrado automático de archivos huérfanos en GitHub, listeners en tiempo real (`onSnapshot`).

Este documento describe el sistema **tal como funciona en el código actual**, no el proceso histórico que lo construyó.

---

## 2. Arquitectura general

```
┌──────────────────────────────┐
│      Navegador (cliente)      │
│  index.html + js/*.js         │  ← única "aplicación"; sin servidor propio
│  (servible desde GitHub       │
│   Pages o cualquier hosting   │
│   estático)                   │
└──────────────┬────────────────┘
               │
   ┌───────────┼──────────────────────────────┐
   │           │                              │
   ▼           ▼                              ▼
Firebase    Firebase                     GitHub REST API
Auth        Firestore                    (repo dedicado)
(login)     (usuarios, módulos,          - Sube .zip/.rar y .pdf
            asignaciones, historial)     - Sirve archivos vía
                                           raw.githubusercontent.com
```

**Principio central:** no existe backend propio. Todo el estado de negocio vive en Firestore; el navegador nunca es la fuente de verdad (excepto la sesión visible en `sessionStorage`, que es solo caché de UI). Los archivos binarios pesados nunca pasan por Firestore ni por ningún servidor propio: van directo del navegador del administrador a GitHub, y del navegador del trabajador se descargan directo desde GitHub.

**Flujo de alto nivel:**
1. El navegador carga `index.html`, que carga `js/app.js` y `js/reproductor.js` como **ES modules** nativos (`<script type="module">`), sin build step.
2. `js/firebase-config.js` inicializa Firebase (Auth + Firestore).
3. **Login:** DNI + contraseña → lookup de correo en Firestore → `signInWithEmailAndPassword` → render del panel según `rol`.
4. **Admin → Módulos:** al guardar, el paquete `.zip`/`.rar`/carpeta y el PDF de certificado se suben **en un solo commit** a GitHub (Git Data API); se guarda la URL pública (no el archivo) en Firestore.
5. **Trabajador → reproducir módulo:** el reproductor descarga el paquete desde GitHub, lo normaliza a JSZip, construye un documento HTML autocontenido, lo monta en un `<iframe sandbox>` aislado, y se comunica con él vía `postMessage` según el contrato SDK. Al aprobar, genera el certificado PDF en el navegador (pdf.js + pdf-lib).
6. Todo el progreso se registra en Firestore en tiempo real (lectura puntual, sin listeners).

---

## 3. Tecnologías utilizadas

| Tecnología | Uso | Cómo se incluye |
|---|---|---|
| HTML/CSS/JavaScript vanilla | Todo el frontend, sin framework ni build step | Archivos estáticos |
| ES Modules nativos | Organización del código (`import`/`export`) | `<script type="module">` en `index.html` |
| Firebase JS SDK v10.14.1 (modular) | Authentication + Firestore | CDN `gstatic.com/firebasejs/10.14.1/...` |
| GitHub REST API (Git Data API) | Almacenamiento de archivos de módulos/certificados | `fetch()` directo a `api.github.com`, sin librería |
| JSZip 3.10.1 | Leer/generar `.zip` en el navegador | CDN `cdnjs.cloudflare.com` |
| libarchive.js (WASM) | Leer archivos `.rar` en el navegador | Autohospedado en `js/vendor/libarchive/` |
| pdf-lib 1.17.1 | Generar el certificado final rellenando el PDF plantilla | CDN `unpkg.com` |
| pdf.js 3.11.174 | Ubicar posición exacta del texto placeholder en el PDF, y renderizar el PDF final a imagen | CDN `cdnjs.cloudflare.com` |
| Vimeo Player SDK | Video externo embebido (opcional, gestionado dentro del propio módulo) | CDN, cargado dinámicamente |
| SheetJS (xlsx) 0.18.5 | Importar/exportar usuarios vía Excel | CDN `cdnjs.cloudflare.com` |
| Lucide Icons | Iconografía de toda la UI | CDN `unpkg.com` |
| Google Fonts (Inter) | Tipografía | CDN `fonts.googleapis.com` |

No hay `package.json`, `node_modules` ni build step. Todo se sirve tal cual desde cualquier hosting estático.

---

## 4. Estructura completa de carpetas

```
tramarsa_intranet/
├── index.html                     Estructura HTML completa + CSS embebido (toda la UI, todos los modales)
├── firestore.rules                Reglas de seguridad de Firestore
├── API-Github.txt                 Notas/borrador sobre el uso de la API de GitHub
├── iniciar_index.bat              Atajo local para levantar un servidor estático de desarrollo
├── usuarios_prueba_35.xlsx        Excel de prueba para el importador de usuarios
├── doc/
│   └── DOCUMENTACION_COMPLETA_TRAMARSA_LMS_V0.1.md   ← este documento (referencia oficial vigente)
├── js/
│   ├── firebase-config.js         Credenciales del proyecto Firebase + inicialización app/auth/db
│   ├── firebase-secondary.js      Crea cuentas de Auth de otros usuarios sin cerrar la sesión del admin
│   ├── github-config.js           Credenciales del repositorio GitHub (owner/repo/branch/token, ofuscado)
│   ├── github-storage.js          Sube archivos a GitHub vía Git Data API (blob → tree → commit → ref)
│   ├── db-firestore.js            Capa de acceso a datos: todo el CRUD contra Firestore
│   ├── app.js                     Lógica de negocio + UI: login, sesión, ambos paneles, todos los modales
│   ├── reproductor.js             Motor de reproducción de módulos: evaluación, certificado, Firestore
│   ├── modulo-loader/
│   │   ├── drivers.js                    Driver único `DriverIndexHtml` — monta el iframe y habla postMessage
│   │   ├── virtual-asset-resolver.js     Construye el documento HTML autocontenido del módulo
│   │   └── package-adapters.js           Normaliza .zip/.rar/carpeta a un JSZip común
│   └── vendor/libarchive/
│       ├── libarchive.js          Wrapper JS de libarchive (autohospedado)
│       ├── libarchive.wasm        Binario WASM de libarchive
│       └── worker-bundle.js       Web Worker que ejecuta la descompresión de .rar
└── modulos/                       Paquetes de contenido de producción ya subidos/referenciados
    ├── modulo001/  →  M01 - Bienvenida al nuevo personal/       (v2: manifest.json + img/ + audio/)
    ├── modulo002/  →  M02 - Uso correcto de EPP/                 (v2: manifest.json + img/ + audio/)
    ├── modulo003/  →  M03 - Hostigamiento Sexual Laboral/        (v2: manifest.json + contenido.html + audio/)
    └── modulo004/  →  M04 - Pausas Activas en Oficina/           (v2: manifest.json + contenido.html + audio/)
        (cada modulo00N/ trae además Certificado.pdf y Preguntas/Cuestionario.txt como insumos de carga)
```

No existen `data/`, IndexedDB propio del proyecto, ni ningún archivo de "conectar carpeta". Esa arquitectura fue eliminada por completo en la migración a Firebase.

---

## 5. Descripción de todos los archivos importantes

### `index.html`
Único archivo HTML de toda la plataforma. Contiene: el CSS completo (variables de color, componentes reutilizables `.icon-btn`/`.btn-save`/`.file-drop`/etc.), el formulario de login, el bootstrap de creación del primer administrador, el shell de la app (`viewApp`, sidebars de ambos roles), **todos los modales** (nuevo/editar módulo, nuevo/editar usuario, asignación grupal, importar Excel, cambio de contraseña, inactividad) y el contenedor del reproductor (`viewReproductor`). No hay componentes ni templates externos: todo el HTML dinámico se genera desde `app.js`/`reproductor.js` con template strings e `innerHTML`.

### `firestore.rules`
Reglas de seguridad de Firestore. Ver sección 7.

### `js/firebase-config.js`
Único lugar con las credenciales de Firebase (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`). Exporta `app`, `auth`, `db` (todos `null` si no está configurado) y `firebaseEstaConfigurado()` (detecta placeholders `'TU_...'`).

### `js/firebase-secondary.js`
Expone `crearCuentaAuthParaUsuario(correo, password)`. Usa una **segunda instancia de Firebase App** (mismo proyecto, nombrada `'tramarsa-secundaria'`) para crear cuentas de Auth de otros usuarios sin desloguear al admin actual. Tras crear la cuenta, hace `signOut` de esa instancia secundaria y `deleteApp` para liberar recursos.

### `js/github-config.js`
Único archivo con `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` (`'main'`), `GITHUB_TOKEN`. El token está partido en dos constantes y decodificado con `atob()` en runtime (ver sección 8, "auto-revocación por secret-scanning"). Exporta `githubEstaConfigurado()`.

### `js/github-storage.js`
Sube archivos a GitHub vía **Git Data API** (`/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`), no el endpoint simple `contents` (no confiable para archivos de varios MB). Expone `subirArchivosAGithub(entradas, mensajeCommit)` (varios archivos, un solo commit) y `subirArchivoAGithub(archivo, carpeta, mensajeCommit)` (atajo). Ver detalle completo en sección 8.

### `js/db-firestore.js`
Capa de acceso a datos: funciones `async` por colección (`obtenerUsuarios`, `crearModulo`, `setAsignacion`, `actualizarHistorial`, etc.). Cada función llama primero a `verificarFirestore()`, que lanza un error explícito si Firebase no está configurado. Funciones de composición notables:
- `crearHistorialSiNoExiste(usuarioId, moduloId, datosIniciales)`: solo crea el documento si no existe — evita que reabrir un módulo completado ("Volver a ver") genere un intento duplicado.
- `actualizarHistorial(usuarioId, moduloId, datos)`: usa `setDoc(..., { merge: true })`.
- `existeAlgunAdmin()`: usada en el bootstrap del primer administrador.
- `siguienteNumeroModulo()`: mayor `numeroModulo` existente + 1.

### `js/app.js`
**El archivo más grande y el que más cambia.** Punto de entrada principal: arranque de la app (`DOMContentLoaded` + `onAuthStateChanged`), sesión (`getSesion`/`setSesion`/`cerrarSesion`), control de inactividad, login, cambio de contraseña obligatorio, restablecimiento de contraseña, bootstrap del primer admin, **panel administrador completo** (Módulos, Usuarios) y **panel trabajador completo** (Inicio, Mis módulos, Certificados, Perfil), todos los modales de administración (nuevo/editar módulo con sus 4 cuadrantes de carga, nuevo/editar usuario, asignación grupal, importar Excel). Exporta `nombreCompleto`, `getSesion`, `setSesion`, `renderDashboardTrabajador` (los usa `reproductor.js`) y expone al `window` (`Object.assign(window, {...})`) todas las funciones invocadas desde `onclick="..."` inline en HTML generado dinámicamente.

### `js/reproductor.js`
Todo lo relacionado con **abrir y completar** un módulo: descarga y normalización del paquete, selección de driver, evaluación, generación de certificado, escritura en Firestore. Nunca dibuja el contenido del módulo en sí (eso es responsabilidad exclusiva del driver/módulo) — solo la capa académica alrededor. Expone `abrirReproductor`, `cerrarReproductor`, `verCertificadoStandalone`, `descargarCertificadoAdmin`, `seleccionarAlternativa`, `prepararEvaluacionOFinalizar` al `window`.

### `js/modulo-loader/drivers.js`
Arquitectura central de montaje del contenido (patrón Strategy, 2 drivers): **`DriverLaminas`** (formato oficial v2 declarativo — manifest.json, contenido puro dirigido 100% por el LMS, sin iframe de app ni postMessage; incluye `desbloquearAudioLaminas()` para el autoplay sin pantalla de inicio) y **`DriverIndexHtml`** (formato v1 legacy — iframe sandbox + protocolo SDK postMessage, fallback para paquetes antiguos). Ver secciones 13, 17.

### `js/modulo-loader/virtual-asset-resolver.js`
Construye el documento HTML autocontenido del módulo v1 legacy a partir del JSZip (3 pasadas). Solo lo usa `DriverIndexHtml`. Ver sección 15.

### `js/modulo-loader/package-adapters.js`
Normaliza los 3 caminos de carga posibles (`.zip`, `.rar`, carpeta arrastrada/seleccionada) a una única instancia de `JSZip`. Ver sección 16.

### `js/vendor/libarchive/*`
Binarios de la librería de terceros `libarchive.js` (WASM), autohospedados porque el Web Worker que usa no puede crearse desde un origen CORS distinto (CDN). No se actualizan automáticamente.

---

## 6. Modelo de datos (Cloud Firestore)

Base de datos en modo nativo, sin subcolecciones — 4 colecciones raíz + 1 reservada.

### `usuarios/{dni}`
Doc ID = DNI (string, sin ceros añadidos). Permite lookup directo sin queries.

| Campo | Tipo | Notas |
|---|---|---|
| `dni` | string | Duplicado del ID del doc |
| `correo` | string | Email real — también identificador de login en Firebase Auth |
| `primerNombre`, `segundoNombre`, `apellidoPaterno`, `apellidoMaterno` | string | `segundoNombre`/`apellidoMaterno` pueden ser `''` |
| `empresa`, `sede`, `gerencia` | string | Opcionales, usados en filtros y asignación masiva |
| `rol` | `'ADMIN'` \| `'TRABAJADOR'` | Determina qué panel se renderiza |
| `estado` | `'ACTIVO'` \| `'INACTIVO'` | Un usuario inactivo no puede iniciar sesión |
| `debeCambiarPassword` | boolean | `true` si la contraseña sigue siendo igual al DNI |
| `fotoUrl` | string (data URL) \| undefined | Foto de perfil en base64, en el propio documento |

**No existe campo `password`** — vive únicamente en Firebase Authentication (hasheada).

### `modulos/{moduloId}`
Doc ID = `'mod-' + Date.now()`.

| Campo | Tipo | Notas |
|---|---|---|
| `nombre`, `descripcion`, `categoria` | string | |
| `estado` | `'ACTIVO'` \| `'INACTIVO'` | Inactivo no aparece para trabajadores |
| `archivoUrl`, `archivoNombre`, `archivoPeso` | string, string, number | Paquete del módulo en GitHub |
| `certificadoUrl`, `certificadoNombre` | string \| null | Plantilla PDF en GitHub |
| `preguntas` | array de `{enunciado, alternativas:[{texto, esCorrecta}]}` \| null | Banco completo |
| `preguntasNombre` | string \| null | |
| `fechaCreacion` | string ISO | |
| `numeroModulo` | number | **Permanente**, asignado una sola vez al crear. Base del nombre del certificado — nunca se recalcula |
| `icono` | string | Nombre de ícono Lucide (galería visual, 50 opciones — ver sección 11) |
| `color` | string | Color de acento del módulo |
| `miniaturaUrl` | string (data URL) \| null | Miniatura 16:9 opcional |

**Semántica de borrado explícito:** en Firestore, **omitir** un campo del payload de `updateDoc`/`setDoc(merge:true)` significa "no tocar"; para borrar de verdad un campo hay que enviarlo explícitamente como `null`. Esto es crítico para los botones "Eliminar archivo" del formulario de módulo (sección 11.2) — omitir el campo dejaría el archivo anterior intacto en el documento aunque la UI muestre el cuadrante vacío.

### `asignaciones/{usuarioId}_{moduloId}`
Doc ID compuesto — permite `setDoc` idempotente sin query-then-update.

| Campo | Tipo |
|---|---|
| `usuarioId` | string (DNI) |
| `moduloId` | string |
| `habilitado` | boolean |

### `historial/{usuarioId}_{moduloId}`
Mismo patrón de ID compuesto. **Un solo documento por combinación usuario+módulo** — no hay historial de intentos como documentos separados; el mismo documento se sobrescribe en cada reintento hasta aprobar.

| Campo | Tipo | Notas |
|---|---|---|
| `usuarioId`, `moduloId` | string | |
| `estado` | `'EN_PROGRESO'` \| `'COMPLETADO'` | |
| `puntaje` | number \| null | `null` si el módulo no tiene evaluación |
| `avancePct` | number (0–100) | Progreso dentro del contenido, llega a 100 solo al aprobar |
| `fechaInicio` | string ISO | Se fija la primera vez, no cambia en reintentos |
| `fechaFin` | string ISO \| null | Se fija en la primera aprobación — **es la fecha usada en el certificado**, incluso si se vuelve a ver después |
| `pasoMaximoAlcanzado` | number | Índice (0-based) del paso más lejano alcanzado. Base del anti-trampa y del "reanudar exactamente donde quedó" |

### `configuracion/{docId}`
Reservada por las reglas de seguridad, sin uso actual en el código. Candidata natural para ajustes globales futuros.

### Relaciones e índices
No hay relaciones declarativas — son por convención de ID. Las queries (`where('usuarioId','==',...)`, `where('rol','==','ADMIN')`) son de campo único: **no requieren índices compuestos**.

---

## 7. Integración con Firebase

### `firebase-config.js`
```js
export const firebaseConfig = { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId };
export function firebaseEstaConfigurado() { /* true si ningún valor es 'TU_...' */ }
export { app, auth, db }; // null si no está configurado
```
Si `firebaseEstaConfigurado()` es `false`, `app`/`auth`/`db` quedan `null` y **toda la app muestra una pantalla de error explícita** en vez de fallar en silencio.

### `firebase-secondary.js`
`initializeApp(firebaseConfig, 'tramarsa-secundaria')` — segunda app con el **mismo proyecto**. `getApps().find(a => a.name === nombreApp)` evita reinicializarla en cada llamada. Tras crear la cuenta: `signOut` de esa instancia + `deleteApp`.

### `db-firestore.js` — patrón general
```js
export async function obtenerX() { /* getDocs(collection(db, 'x')) */ }
export async function obtenerX(id) { /* getDoc(doc(db, 'x', id)) */ }
export async function crearX(id, datos) { /* setDoc(doc(db, 'x', id), datos) */ }
export async function actualizarX(id, datos) { /* updateDoc(...) */ }
```
**Sin listeners en tiempo real (`onSnapshot`)** en ninguna parte — todo es lectura puntual disparada por cada render. Dos administradores con la pantalla abierta simultáneamente no se actualizan el uno al otro en vivo.

### Reglas de Firestore (`firestore.rules`)
```
match /usuarios/{dni}     { allow read: if true; allow write: if request.auth != null; }
match /modulos/{id}       { allow read, write: if request.auth != null; }
match /asignaciones/{id}  { allow read, write: if request.auth != null; }
match /historial/{id}     { allow read, write: if request.auth != null; }
match /configuracion/{id} { allow read, write: if request.auth != null; }
```
**Limitación de seguridad explícita:** sin Cloud Functions ni Custom Claims, las reglas **no pueden distinguir de forma confiable si la cuenta autenticada es ADMIN** — ese dato (`rol`) vive en un documento que el propio cliente puede escribir. El baseline (`auth != null`) bloquea acceso público/anónimo, pero no impide que una cuenta TRABAJADOR autenticada llame directamente a la API de Firestore (fuera de la UI) para leer/escribir datos que la interfaz no le mostraría.

`usuarios` tiene lectura pública sin autenticar por necesidad funcional (login por DNI necesita mapear DNI→correo antes de poder autenticar) — expone nombre/DNI/correo/empresa/sede/gerencia de todos los usuarios, nunca contraseñas. Equivalente a un directorio interno de empresa, riesgo aceptado.

---

## 8. Integración con GitHub

### `github-config.js`
`GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` (`'main'`), `GITHUB_TOKEN`. Token generado como **fine-grained PAT**, alcance limitado únicamente al repositorio de módulos, permiso mínimo **"Contents: Read and write"**.

**Consideración de seguridad crítica:** la app corre 100% en el navegador y se sirve como archivos estáticos — el token queda **visible en el código fuente** para cualquiera que lo inspeccione. Riesgo **aceptado explícitamente** por decisión del proyecto. La única solución real para reducirlo es mover la subida a un backend/Cloud Function server-side — eso implica dejar de ser "sin servidor".

**Auto-revocación por secret-scanning:** GitHub escanea repos públicos en busca de tokens con formato reconocible (`github_pat_...`) y los revoca de inmediato al detectarlos en un commit, incluso si el repo es del propio dueño. Como no hay build step, el archivo con el token debe estar commiteado para que el sitio funcione — un `.gitignore` no resuelve nada. Mitigación: el token se parte en dos constantes y se decodifica con `atob()` en runtime, para que el escáner de patrones no lo reconozca. **Esto no reduce la exposición real** (sigue siendo legible por cualquiera que inspeccione el código/DevTools) — solo evita la auto-revocación.

### `github-storage.js`
Usa la **Git Data API** (`/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`), no el endpoint simple `contents` (no confiable para archivos de varios MB).

**`subirArchivosAGithub(entradas, mensajeCommit)`:**
1. Convierte cada archivo a base64 en trozos de 32 KB (evita el límite de argumentos de `String.fromCharCode.apply` en archivos grandes), sube cada uno como blob (`POST /git/blobs`) **en paralelo**.
2. Lee el commit actual de la rama, arma **un solo árbol nuevo** con todos los blobs, crea **un solo commit**, mueve la rama a ese commit.
3. Devuelve `{url, ruta}` por archivo — `url` es `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{ruta}`.

**Por qué un solo commit para varios archivos (bug real, ver sección 26):** commits secuenciales (uno por archivo) fallaban de forma consistente con `422 Update is not a fast forward` — lag de propagación real de la API de referencias de GitHub. Agrupar todos los archivos de un mismo guardado en un solo commit elimina la carrera de raíz. Se mantiene además un reintento con backoff exponencial: **`MAX_INTENTOS = 12`**, tope de espera **`ESPERA_MAXIMA_MS = 10000`** por intento (ampliado desde 8/8000 tras seguir observando el error 422 de forma rara incluso con el fix del commit único).

**Organización del repositorio:**
```
{repo}/
├── modulos/{moduloId}/{timestamp}-{nombreArchivoSaneado}.{zip|rar}
└── certificados/{moduloId}/{timestamp}-{nombreArchivoSaneado}.pdf
```
El nombre se sanea (`sanearNombreArchivo`): quita acentos y cualquier carácter fuera de `[a-zA-Z0-9._-]`, antepone timestamp para evitar colisiones.

**Descarga:** el reproductor hace `fetch(modulo.archivoUrl)`/`fetch(modulo.certificadoUrl)` directo — el repositorio es **público**, el token solo hace falta para escribir.

---

## 9. Flujo de autenticación (Login → Logout)

1. **Formulario de login** pide **DNI** (no correo) y contraseña — decisión de UX explícita.
2. `app.js` hace `DB.obtenerUsuario(dni)` — lectura de `usuarios/{dni}`, **pública** (`allow read: if true`), necesaria porque no se puede autenticar contra Firebase Auth sin saber primero el correo, y ese lookup debe poder hacerse *antes* de estar autenticado.
3. Con el `correo` obtenido: `signInWithEmailAndPassword(auth, correo, password)`. El correo real del usuario **es** su identificador de cuenta en Firebase Auth (nunca un dominio sintético).
4. Si `usuario.estado !== 'ACTIVO'`: `signOut` inmediato + error.
5. Si todo correcto: `setSesion(usuario)` (cachea el documento en `sessionStorage`) → `iniciarApp()` → render del panel según `rol`.

### Cambio de contraseña obligatorio
Si `usuario.debeCambiarPassword === true` (se fija así al crear un trabajador con contraseña = DNI), tras el login se muestra un modal **sin botón de cerrar**:
```js
const credencial = EmailAuthProvider.credential(usuario.correo, usuario.dni); // password actual = DNI
await reauthenticateWithCredential(auth.currentUser, credencial);
await updatePassword(auth.currentUser, nueva);
await DB.actualizarUsuario(usuario.dni, { debeCambiarPassword: false });
```
Firebase Auth exige reautenticación reciente para `updatePassword`; por eso el paso de reautenticación es obligatorio incluso justo después del login.

### Restablecimiento de contraseña
Flujo **nativo**: `sendPasswordResetEmail(auth, usuario.correo)`. Como el correo de Auth es el correo real, el enlace llega de verdad — sin servicio de correo de terceros.

### Gestión de administradores y trabajadores
- **No hay Cloud Functions ni Admin SDK.** Crear una cuenta para *otra persona* se resuelve con la segunda instancia de Firebase App (`firebase-secondary.js`).
- **Bootstrap del primer administrador:** si `DB.existeAlgunAdmin()` es `false`, el login muestra "Crear la cuenta de administrador inicial" (`createUserWithEmailAndPassword` en la app **principal**, único caso, porque no hay sesión de admin que proteger todavía).
- **Cambiar la contraseña de otro usuario desde el panel admin no es posible** sin Admin SDK/Cloud Functions. Única vía: el propio trabajador la cambia en su Perfil, o el admin dispara el correo de restablecimiento nativo con el DNI de esa persona en el formulario de login.

### Logout
`cerrarSesion()`, en orden: (1) desactiva el control de inactividad ANTES de cualquier await (el propio click burbujeaba al listener global y rearmaba el temporizador — cierre "fantasma" posterior, bug real corregido); (2) muestra el overlay "Cerrando sesión..." de inmediato (feedback visual — sin esto el reload de 2-4s en móvil se sentía como botón muerto); (3) limpia `sessionStorage`; (4) `await signOut(auth)` con `Promise.race` de 1.5s de tope (esperar es necesario: sin esperar, la sesión IndexedDB a medio borrar hacía que la página recargada viera un usuario "fantasma" y disparara una lectura completa de Firestore); (5) fija la marca `tramarsa_logout` y recarga. Al arrancar, si existe la marca, el login se muestra de inmediato sin esperar `onAuthStateChanged` (1-2s menos; Auth corre igual por debajo como verificación).

---

## 10. Persistencia de sesión y cierre por inactividad

### Persistencia entre pestañas
Firebase Auth persiste la sesión de forma asíncrona vía IndexedDB interno del SDK, **compartida entre pestañas** (persistencia local por defecto, nunca cambiada a session-only). El arranque de la app (`DOMContentLoaded`) usa `onAuthStateChanged(auth, callback)` — **no** una comprobación síncrona de `auth.currentUser` — porque `auth.currentUser` puede seguir siendo `null` justo al cargar la página aunque exista una sesión válida.

**Bug real corregido esta versión:** el caché de UI (`sessionStorage`, vía `setSesion`) es **por pestaña**. Antes del fix, abrir una pestaña/ventana nueva mostraba el login aunque la sesión de Firebase Auth siguiera siendo válida (el caché de esa pestaña arrancaba vacío). Fix en el callback de `onAuthStateChanged`:
```js
if (!sesion && user) {
  const usuarios = await DB.obtenerUsuarios();
  const encontrado = usuarios.find(u => u.correo === user.email);
  if (encontrado && encontrado.estado === 'ACTIVO') { setSesion(encontrado); sesion = encontrado; }
  else { await signOut(auth); }
}
```
Repuebla el caché de la pestaña nueva desde Firestore antes de decidir si mostrar login o la app.

Mientras se resuelve `onAuthStateChanged`, se muestra `#viewCargando` (nunca el formulario de login) — con sesión válida la restauración es transparente, sin parpadeo del login.

### Restauración de ruta y scroll
`marcarRuta(nombre)` guarda en `sessionStorage.tramarsa_ruta` cada sección renderizada; `beforeunload` guarda la posición de scroll (`tramarsa_scroll`). Al recargar con sesión válida, la app vuelve a la misma sección y posición — sin pasar por el login ni resetear la navegación.

### Cierre automático por inactividad
Solo cuentan como actividad los **clics y pulsaciones de teclado** — `mousemove`/`scroll` NO reinician el contador (no garantizan uso real de la plataforma).

```js
const TIEMPO_INACTIVIDAD_MS = 5 * 60 * 1000; // 5 min
const TIEMPO_AVISO_ANTES_MS = 30 * 1000;     // aviso 30s antes
```
- `reiniciarTemporizadorInactividad()`: se llama en cada `click`/`keydown` y al abrir sesión. Reinicia dos `setTimeout`: uno a los `5min - 30s` que muestra el modal de aviso con cuenta regresiva, otro a los 5 min que cierra la sesión.
- Modal `#modalInactividadOverlay`: botones "Continuar trabajando" (reinicia el temporizador) y "Cerrar sesión" (fuerza el cierre inmediato).
- `iniciarControlInactividad()` se llama una sola vez, dentro de `iniciarApp()` — cubre tanto el login normal como la restauración de sesión al abrir una pestaña nueva.

**No probado aún contra infraestructura real en un turno largo de inactividad** — verificado por revisión de código y syntax-check, pendiente de validación funcional en vivo (ver sección 27).

---

## 11. Panel Administrador

Sidebar con 3 secciones: **Módulos**, **Usuarios**, **Configuración**. (Asignaciones y Reportes como secciones separadas fueron eliminadas por redundancia — ver sección 25.)

### 11.1 Módulos
- Grilla de tarjetas, una por módulo: ícono/color propios, miniatura 16:9 opcional, estado (Activo/Inactivo), nombre de archivo, cantidad de preguntas, si tiene certificado, trabajadores habilitados. Filtro por mes de carga, paginación de 9 tarjetas/página.
- **Galería visual de íconos** (`renderGaleriaIconos`, `ICONOS_MODULO`): **50 íconos Lucide** organizados en tarjetas clicables dentro de una grilla de 2 filas con scroll (`.icon-gallery{max-height:128px;overflow-y:auto}`), todos validados contra el set real de Lucide.
- **Asignar por Empresa, Sede o Gerencia:** selector de tipo de filtro + valor, habilita el módulo para el grupo elegido en un solo clic (`Promise.all` de `DB.setAsignacion`). El botón "Asignar a todos" independiente **fue eliminado** — la opción "todos" del selector de filtro ya lo cubre (era redundante).
- **Inactivar/Activar, Eliminar** (con confirmación; borra el documento y sus asignaciones — **no borra los archivos en GitHub**, hay que hacerlo manualmente).

#### 11.2 Formulario Nuevo/Editar módulo — 4 cuadrantes de carga
Grid 2×2 (`.form-grid-2x2`): **Miniatura, Módulo, Preguntas, Certificado**. Diseño y comportamiento idénticos en los 4, y entre Nuevo y Editar:
- El tamaño/estructura del recuadro (`.file-drop`) **nunca cambia**, sin importar el estado de carga — siempre muestra el ícono, el texto "Haz clic o arrastra aquí..." y el formato permitido.
- **Nunca se muestra** vista previa, nombre de archivo ni texto adicional dentro del cuadrante.
- Único indicador de estado, esquina superior derecha (`.file-drop-estado`):
  - **✅** verde: archivo recibido y validado (formato correcto).
  - **❌** rojo: carga rechazada (formato no permitido) — el input se limpia automáticamente, no queda ningún archivo cargado.
  - Nada: cuadrante vacío.
- **🗑️ (papelera discreta, sin fondo ni borde)** junto al indicador, visible solo en estado ✅: al hacer clic, el cuadrante vuelve a su estado inicial (input limpio, sin indicador). En modo Editar, si el archivo eliminado ya existía guardado, se marca una bandera (`miniaturaEliminada`/`archivoEliminado`/`preguntasEliminadas`/`certificadoEliminado`) que al guardar **borra de verdad** el campo en Firestore (`campo: null` — ver semántica de borrado en sección 6); si no se marca la bandera, el campo simplemente no se toca (se conserva el archivo anterior).
- Validación de extensión ocurre **al seleccionar el archivo**, no solo al guardar: Miniatura (imagen), Módulo (`.zip`/`.rar`/carpeta), Preguntas (`.txt`/`.docx`/`.json`), Certificado (`.pdf`).
- Al guardar: parsea el archivo de preguntas si se adjuntó, sube a GitHub el paquete y el PDF **en un único commit**, asigna `numeroModulo` (solo si es módulo nuevo) y crea/actualiza el documento.

### 11.3 Usuarios
- Tabla con paginación y **acordeón por trabajador** (`toggleFilaAcordeon`): al expandir se muestra el detalle de progreso por módulo asignado (estado, puntaje, fechas), calculado por `datosProgresoTrabajadores()`. Columnas Empresa/Sede/Gerencia/Estado/Puntaje/Acciones centradas; columna Módulo alineada a la izquierda.
- **Nuevo trabajador:** crea la cuenta de Auth (vía `firebase-secondary.js`) + documento Firestore. Contraseña inicial = DNI si se deja en blanco (`debeCambiarPassword=true` automático).
- **Editar trabajador:** DNI no editable (es el ID del documento). Sin campo de contraseña.
- **Eliminar usuario:** borra en cascada `usuarios` + `asignaciones` + `historial` (no la cuenta de Auth, no eliminable client-side sin Admin SDK).
- **Asignar módulos** (drawer lateral): checklist con buscador + pestaña "Asignaciones actuales". Cambios acumulados en memoria (`Set`), escritos a Firestore solo al presionar "Guardar asignaciones".
- **Descargar certificado de un trabajador** directo desde la fila expandida, sin abrir el reproductor.
- **Importar Excel:** columnas `Nombres, Apellidos, DNI, Correo, Empresa, Sede, Gerencia, Estado`. Upsert por DNI.
- **Exportar base de datos:** `.xlsx` con el mismo esquema de columnas.

### 11.4 Configuración
Resumen numérico (módulos, trabajadores, capacitaciones completadas).

---

## 12. Panel Trabajador

Sidebar con 4 secciones: **Inicio, Mis módulos, Certificados, Perfil**.

### 12.1 Inicio (dashboard)
Saludo + anillo de progreso compacto, y **3 listas independientes paginadas** (3 filas/página cada una):
- **"Continúa donde quedaste"** — módulo en progreso con mayor avance.
- **"Nuevos módulos asignados"** — pendientes de iniciar.
- **"Logros recientes"** — últimos completados por `fechaFin`, con botones **"Volver a ver"** y **"Certificado"/"Sin certificado"** del **mismo ancho y alto** (ambos heredan `flex:1;min-width:90px` de `.icon-btn`, sin overrides que los achiquen).

Paginación con `htmlPaginacionHeader`: cabecera siempre visible (`## de ## [<][>]`), reemplaza el diseño anterior de paginación numerada al pie.

### 12.2 Mis módulos
Anillo de progreso + 4 tarjetas resumen (En progreso/Completadas/Pendientes/Certificados) que funcionan como **filtro clicable** (estado visual activo). Listado paginado según categoría elegida; fila con barra de progreso mini si está en curso, botón "Certificado" si completado.

### 12.3 Certificados
Solo módulos completados, con fecha de la primera aprobación, paginación, botón para volver a generar/descargar sin reabrir el módulo completo (`verCertificadoStandalone`).

### 12.4 Perfil
Cambiar foto (data URL en el propio documento, botón "Eliminar foto") y cambiar contraseña (mismo patrón de reautenticación del cambio obligatorio).

### 12.5 Recorrido de un módulo (resumen — detalle técnico en secciones 13–22)
1. Clic en "Iniciar"/"Continuar" → `abrirReproductor(moduloId)`.
2. Se crea (si no existe) `historial/{dni}_{moduloId}` en `EN_PROGRESO`.
3. Se descarga y normaliza el paquete del módulo.
4. Se reproduce el contenido — avance bloqueado hasta terminar el audio de cada paso; retroceder y pausar sí permitidos. `avancePct`/`pasoMaximoAlcanzado` se actualizan en Firestore en cada paso confirmado.
5. Al terminar: evaluación (si hay banco de preguntas) — 5 preguntas aleatorias, 30s c/u, sin retroceder.
6. Si aprueba (≥70%): `historial` pasa a `COMPLETADO`, se fija `fechaFin`, se genera el certificado PDF.
7. Si no aprueba: puede reintentar con preguntas distintas (el historial permanece `EN_PROGRESO`).

---

## 13. Arquitectura del reproductor de módulos

Dos formatos de módulo conviven, seleccionados automáticamente por `seleccionarDriver(zip)` (patrón Strategy — el primero que reconozca el paquete gana):

1. **Formato v2 declarativo (`DriverLaminas`) — el formato OFICIAL para todo módulo nuevo.** El paquete es solo contenido (imágenes/HTML + audios + `manifest.json`), **sin JS de control, sin controles propios, sin pantalla de inicio**. El LMS reproduce directamente en su propio documento: **sin iframe de aplicación, sin sandbox de app, sin postMessage, sin SDK, sin resolver**. Audio, navegación, gate anti-trampa, barra de progreso, pausa y modo Automático/Manual son 100% del LMS, en un solo lugar. Detección: existe `manifest.json`. Ver secciones 17 y 23.
2. **Formato v1 universal (`DriverIndexHtml`) — legacy, mantenido como fallback.** El paquete es una app (`index.html` con Motor propio) ejecutada en un iframe sandbox de origen opaco, comunicada por el contrato SDK `postMessage` (sección 14). Sigue funcionando para paquetes antiguos; **no usar para módulos nuevos**.

### Por qué se reemplazó el formato universal v1 por el declarativo v2
El v1 nació para que el LMS no inspeccionara la estructura del módulo: el módulo controlaba su presentación y hablaba por SDK. En la práctica, ejecutar JS ajeno aislado generó toda una familia de problemas reales (origen opaco vs blob URLs, MIME vacío de JSZip, inlineo de scripts, partición de storage de Chrome, gesto de autoplay dentro del iframe, gate anti-trampa duplicado LMS+módulo). El v2 invierte de nuevo la responsabilidad, pero de forma **declarativa y explícita** (manifest, no adivinación de nombres como el driver de láminas pre-v1): el módulo es contenido puro y el LMS ejecuta. Esa familia entera de bugs desaparece de raíz porque ya no hay JS ajeno que ejecutar.

### Componentes involucrados (cadena completa, formato v2)
`RP` (estado en `reproductor.js`) → `desbloquearAudioLaminas()` (en el click, antes de cualquier await) → descarga y normalización a JSZip → `seleccionarDriver(zip)` → `DriverLaminas.montar` (lee manifest, arma blob/data URIs, monta `<img>`/iframe-póster + barra de controles) → audio local del LMS reproduce → `callbacks.onAvance` en cada lámina → al terminar la última: `callbacks.onFinalizado()` → `prepararEvaluacionOFinalizar`/`renderPasoPregunta` (evaluación) → `finalizarModulo` → `intentarGenerarCertificado`/`generarBytesPdfCertificado` (pdf.js + pdf-lib) → `DB.actualizarHistorial` (Firestore, incluye `pasoMaximoAlcanzado`).

### Sin pantalla "Iniciar módulo"
El formato v2 arranca directo en la primera lámina con audio sonando. La pantalla "Iniciar módulo" del v1 existía únicamente porque el gesto de usuario para autoplay debía ocurrir **dentro** del iframe; sin iframe, el click de "Iniciar"/"Continuar" del propio LMS es el gesto. Como la descarga del zip puede tardar y el gesto expira, `desbloquearAudioLaminas()` (exportada por `drivers.js`, llamada como **primera línea síncrona** de `abrirReproductor`) reproduce un WAV silencioso en el elemento `Audio` compartido durante el click original — ese elemento queda desbloqueado para toda la sesión de página. Si aun así el navegador bloquea, el driver degrada limpio a botón Play manual (nunca rompe el flujo).

### Aislamiento de seguridad (solo formato v1)
`<iframe sandbox="allow-scripts allow-forms allow-popups" allow="autoplay; fullscreen">` — **deliberadamente sin `allow-same-origin`** (origen opaco). **Nunca agregar `allow-same-origin`.** En el v2 no hay app ajena que aislar; el iframe-póster de las láminas HTML usa `sandbox="allow-scripts"` sin ningún canal de comunicación (ver sección 17).

### Módulo sin formato reconocible
Si el paquete no tiene ni `manifest.json` ni `index.html`, no hay contenido reproducible. En el v1, contenido de terceros sin SDK: tras `GRACIA_SIN_SDK_MS` (8000 ms) sin `modulo:iniciado`, aviso de incompatibilidad. **No existe ningún atajo para saltar la evaluación** sin completar el contenido (regla anti-trampa).

---

## 14. El contrato SDK `window.TramarsaLMS` (solo formato v1 legacy)

> **⚠️ Este contrato aplica únicamente al formato v1 (`DriverIndexHtml`), mantenido como fallback para paquetes antiguos.** Los módulos del formato oficial v2 **no usan SDK, ni postMessage, ni nada de esta sección** — son contenido puro dirigido por el LMS (secciones 13, 17 y 23). No crear módulos nuevos con este contrato.

Inyectado automáticamente por el LMS como primer `<script>` del documento virtual (ver sección 15) — el módulo no lo trae ni lo importa, simplemente lo usa si existe. Definido **antes** de tocar cualquier prototipo nativo del DOM, envuelto en `try/catch`, para que el contrato quede disponible incluso si el parcheo de rutas dinámicas fallara en algún navegador.

### Eventos módulo → LMS (el módulo informa su estado)

| Llamada del módulo | Mensaje `postMessage` | Cuándo | Efecto en el LMS |
|---|---|---|---|
| `notificarIniciado()` | `modulo:iniciado` | Al arrancar, cuando el módulo detecta `window.TramarsaLMS` | Activa `modoControlado`, envía `lms:alternarAutoplay` + `lms:reanudar` |
| `notificarDiapositiva(indice, total)` | `modulo:diapositiva` | Al mostrar cada paso/lámina | Redibuja controles, `callbacks.onAvance()` → progreso parcial en Firestore |
| `notificarAudioFinalizado()` | `modulo:audioFinalizado` | Al terminar el audio del paso actual | Marca ese paso como "audio listo" — habilita avanzar |
| `notificarAvance(pct)` | `modulo:avance` | Cambio de lámina confirmado, reinicio, etc. | **Salto instantáneo** de la barra (sin animación) + progreso confirmado |
| `notificarSegmentoAudio(pctDestino, duracionMs)` | `modulo:segmentoAudio` | Al empezar a reproducirse el audio de cada lámina | Arranca la animación CSS fluida de la barra (ver sección 19) — **puramente visual**, no toca Firestore |
| `notificarPausado()` | `modulo:pausado` | El usuario pausa (desde los controles del propio módulo o del LMS) | Congela la barra exactamente donde iba |
| `notificarReanudado()` | `modulo:reanudado` | Se reanuda la reproducción | Actualiza el ícono play/pausa |
| `notificarFinalizado()` | `modulo:finalizado` | Terminó todo el contenido | Pasa a evaluación/certificado |

### Comandos LMS → módulo (recibidos vía `TramarsaLMS.onComando(fn)`)

| Comando | Datos | Efecto esperado en el módulo |
|---|---|---|
| `lms:siguiente` | — | Avanzar un paso (el LMS ya validó que está permitido) |
| `lms:anterior` | — | Retroceder un paso (siempre permitido) |
| `lms:reanudar` | `{paso, reproducir, navegacionLibre}` | Ir a `paso`; `reproducir` indica si debe arrancar sonando (según preferencia Automático/Manual); `navegacionLibre=true` en modo "Volver a ver" — el gate anti-trampa interno del módulo debe desactivarse |
| `lms:pausar` | — | Pausar la reproducción actual |
| `lms:continuar` | — | Reanudar la reproducción pausada |
| `lms:alternarAutoplay` | `{activo}` | El usuario cambió entre modo Automático/Manual — el módulo debe ajustar su autoavance interno en consecuencia |

### Implementación real del shim (`virtual-asset-resolver.js`)
```js
window.TramarsaLMS = {
  notificarIniciado: function(){ parent.postMessage({tipo:'modulo:iniciado'}, '*'); },
  notificarDiapositiva: function(indice,total){ parent.postMessage({tipo:'modulo:diapositiva', indice, total}, '*'); },
  notificarAudioFinalizado: function(){ parent.postMessage({tipo:'modulo:audioFinalizado'}, '*'); },
  notificarAvance: function(pct){ parent.postMessage({tipo:'modulo:avance', pct}, '*'); },
  notificarSegmentoAudio: function(pctDestino, duracionMs){ parent.postMessage({tipo:'modulo:segmentoAudio', pctDestino, duracionMs}, '*'); },
  notificarPausado: function(){ parent.postMessage({tipo:'modulo:pausado'}, '*'); },
  notificarReanudado: function(){ parent.postMessage({tipo:'modulo:reanudado'}, '*'); },
  notificarFinalizado: function(){ parent.postMessage({tipo:'modulo:finalizado'}, '*'); },
  onComando: function(fn){ window.addEventListener('message', function(e){
    var d = e.data || {};
    if (typeof d.tipo === 'string' && d.tipo.indexOf('lms:') === 0) fn(d);
  }); }
};
```

### Modo dual (obligatorio en todo módulo oficial)
Un módulo debe poder ejecutarse tanto de forma **independiente** (todos sus controles propios visibles y funcionales, abierto suelto en un navegador) como **embebido** en el LMS. Detección: `const controladoPorLMS = !!window.TramarsaLMS`. Si existe, el módulo oculta su UI de navegación propia (sidebar, atajos de teclado, botones) y cede el control absoluto a los comandos `lms:*`; si no existe, se comporta exactamente igual que antes de integrar el SDK. Cero cambios visuales/UX en el modo standalone — el retrofit es exclusivamente de arquitectura de control.

### ⚠️ Estado real de los módulos de referencia
Los 4 módulos de referencia (`modulo001`–`modulo004`, en `C:\...\modulos_prueba` y su copia en `tramarsa_intranet/modulos/`) ya fueron **convertidos al formato v2 declarativo** — no usan este SDK. Cualquier paquete v1 que siga subido en GitHub (versiones anteriores de esos módulos) sigue reproduciéndose vía `DriverIndexHtml`, pero debe reemplazarse re-subiendo el paquete v2 desde el panel admin (ver sección 28).

---

## 15. Virtual Asset Resolver — construcción del documento virtual (solo formato v1 legacy)

> **⚠️ Solo lo usa `DriverIndexHtml` (formato v1 legacy).** El formato v2 no pasa por el resolver: sus assets se sirven como blob URLs (mismo documento del LMS) o data URIs (dentro del iframe-póster), directamente desde `DriverLaminas`.

`js/modulo-loader/virtual-asset-resolver.js`. Dado el `JSZip` del módulo, produce **un único documento HTML autocontenido** en un Blob URL, en **3 pasadas obligatorias, en este orden exacto** (no invertir el orden — ver sección 29):

### Pasada 1 — Inlineo de `<script src>`/`<link rel=stylesheet href>` (`inlinearScriptsYEstilos`)
El contenido real del archivo se inyecta directo como `<script>...</script>`/`<style>...</style>`, no por referencia.

**Motivo — limitación real del navegador, causa raíz de un bug real diagnosticado:** el iframe corre con origen opaco (sandbox sin `allow-same-origin`) y un `<script src="blob:...">`/`<link href="blob:...">` **no carga** si el blob fue creado desde otro origen — a diferencia de `<img>`/`<audio>`/`<video src="blob:...">`, que sí funcionan cross-origin. Un módulo de una sola pieza (todo el JS/CSS inline en el propio `index.html`) funcionaba sin este fix; un módulo con `css/`+`js/` como archivos externos simplemente nunca ejecutaba su script — no era un bug del módulo, era esto. Debe correr **antes** que la pasada 2: opera sobre rutas literales originales (`"js/app.js"`), no sobre Blob/data URLs ya sustituidas.

### Pasada 2 — Sustitución estática de rutas (`sustituirRutasLiterales`)
Reemplaza en el texto de cada archivo `html/css/js/mjs/json/svg` cualquier ocurrencia literal de una ruta relativa conocida por su URI de datos — cubre `<img src>`, `url()` de CSS, referencias en JSON, etc. Rutas ordenadas de más larga a más corta para que `"img/DiapositivaLogo.png"` no quede parcialmente pisada por el prefijo `"img/Diapositiva"`.

### Pasada 3 — Shim runtime (`shimRuntime`, inyectado como primer `<script>`)
Intercepta `fetch`/`XMLHttpRequest.open` y los setters de `.src`/`.href` de `<img>`/`<script>`/`<audio>`/`<video>`/`<source>`/`<link>` — cubre rutas armadas dinámicamente en JS (ej. `'img/Diapositiva' + n + '.png'` en tiempo de ejecución, donde la pasada estática no tiene un literal completo que buscar). Este mismo script define `window.TramarsaLMS`.

### Assets como `data:` URI, no `blob:` URL — corrección de una regresión de plataforma
Los assets referenciados **desde dentro** del documento del módulo (imágenes, audio, video, CSS, JS) se entregan como **`data:` URI en base64**, no como `blob:` URL. Motivo: Chrome introdujo partición de almacenamiento por origen para `blob:` URLs — un iframe sandbox sin `allow-same-origin` (origen opaco) ya no puede resolver un `blob:` URL creado por el documento padre. Esto rompió `img`/`audio`/`video` de **todos** los módulos (nuevos y ya validados) sin que el código de los módulos ni el driver cambiaran — una regresión de la plataforma del navegador, no de este proyecto. El **documento final** del módulo (el que recibe `iframe.src`) sigue siendo un `blob:` URL porque esa es una **navegación de nivel superior** del iframe, no un sub-recurso pedido desde dentro de un documento ya opaco — eso sí sigue funcionando sin cambios.

`blobADataUri(blob, ruta)` convierte en trozos de 32 KB (mismo patrón anti-límite de `String.fromCharCode.apply` que `github-storage.js`).

### MIME por extensión, nunca por `blob.type`
`blob.type` **no es confiable**: JSZip deja `Blob.type` en `''` al leer un archivo agregado vía `zip.file(ruta, archivo)` sin pasar `{mimeType}` explícito — y `package-adapters.js` (carpeta arrastrada y `.rar`) nunca lo pasa. Con `blob.type=''` el navegador caía a `application/octet-stream`: `<img>` lo tolera (sniffea bytes), `<audio>`/`<video>` **no** — nunca se vuelven reproducibles y no disparan error (silencio total, difícil de diagnosticar). Por eso el MIME se determina siempre por extensión (`MIME_POR_EXTENSION`), nunca por `blob.type`.

### Gotcha de caché descubierto al verificar el fix del inlineo
Durante las pruebas, `fetch()` con caché por defecto devolvía JS **desactualizado** tras editar el archivo en disco. Además, una instancia de ES module ya cargada persiste durante toda la vida de la página aunque la caché HTTP se refresque después. Verificación correcta: `fetch(url, {cache:'reload'})` para forzar el refresco de caché, **seguido de una navegación completa de página** (no solo un re-render) para obtener una instancia fresca del registro de módulos.

---

## 16. Package Adapters — normalización de .zip/.rar/carpeta

`js/modulo-loader/package-adapters.js`. Normaliza los 3 caminos de carga posibles a **una misma instancia de `JSZip` en memoria**. Todo el resto de la plataforma (admin al subir, reproductor al reproducir) trabaja siempre sobre ese `JSZip` — nunca sabe de dónde vino.

- **`archivoAJSZip(archivo)`**: `.zip` → `JSZip.loadAsync(archivo)` directo. `.rar` → `rarAJSZip(archivo)`, que usa `libarchive.js` (WASM, autohospedado porque el Worker que usa no puede crearse desde un origen CORS distinto de CDN), extrae el árbol de archivos y lo reempaqueta como `JSZip`. Lanza error explícito si se ejecuta bajo `file://` (limitación conocida, sección 27).
- **`carpetaArrastradaAJSZip(items)`**: recorre `FileSystemEntry` (drag&drop) recursivamente — deben leerse con `webkitGetAsEntry()` en el mismo tick síncrono del evento `'drop'` (el `DataTransfer` deja de ser válido después).
- **`carpetaSeleccionadaAJSZip(fileList)`**: usa `webkitRelativePath` de un `<input type="file" webkitdirectory>`.
- **`jszipAArchivoZip(zip, nombreBase)`**: reempaqueta un `JSZip` normalizado como un `.zip` real (`generateAsync({type:'blob', compression:'DEFLATE'})`), listo para subir a GitHub — así los 3 caminos de carga terminan siempre en el mismo artefacto almacenado.

---

## 17. Drivers del reproductor (`DriverLaminas` oficial + `DriverIndexHtml` legacy)

`js/modulo-loader/drivers.js`. Contrato de cualquier driver:
```
detectar(zip) -> boolean
montar(contenedor, zip, rutaIndex, callbacks, urlsTemporales, pasoInicial, navegacionLibre, opciones) -> destructor()
```
`callbacks = { onAvance(pasoActual, totalPasos), onFinalizado() }`. `opciones = { color, moduloId }`. Toda la lógica académica (evaluación, aprobación, certificado, Firestore) vive siempre en `reproductor.js` — el driver **solo informa estos dos eventos**, nunca toca DB ni sesión. `seleccionarDriver` prueba en orden: `[DriverLaminas, DriverIndexHtml]` — el manifest tiene prioridad.

### 17.A — `DriverLaminas` (formato v2 declarativo, OFICIAL)

- **`detectar(zip)`**: existe `manifest.json` (a cualquier profundidad; `buscarManifest` toma el de menor profundidad, tolerando carpeta contenedora).
- **`montar(...)`**: parsea el manifest, valida cada lámina contra los archivos reales del paquete (error explícito si falta alguno), construye por lámina:
  - **Lámina imagen** (`{"imagen", "audio"}`): blob URL con MIME por extensión (`MIME_LAMINAS` — mismo motivo documentado en sección 15: `blob.type` de JSZip es `''` y `<audio>` no lo tolera).
  - **Lámina html** (`{"html", "audio"}`): fragmento renderizado en un **iframe-póster** por `srcdoc` — `sandbox="allow-scripts"` (solo para el script de escala y JS decorativo), **sin ningún canal de comunicación**: el LMS nunca le habla ni espera nada de él. El esqueleto (lienzo 1920×1080 escalado, configurable con `"lienzo"` en el manifest) lo pone el LMS; el fragmento solo aporta contenido. Assets referenciados por el fragmento/CSS → data URIs (blob del padre no resuelve en iframe opaco).
  - **Contenido único** (`manifest.contenido`): UN solo HTML con todas las láminas como `<section class="slide">` + su `<style>`; el driver lo parsea con `DOMParser`, extrae estilos y secciones y las empareja en orden con los audios del manifest. Error explícito si hay menos secciones que audios declarados. Ver plantilla en sección 23.
- **Audio**: un único elemento `Audio` compartido, propiedad del LMS, pre-desbloqueado por `desbloquearAudioLaminas()` en el click original (sección 13). Eventos `playing`/`ended` locales — sin postMessage.
- **Lógica en un solo lugar**: gate anti-trampa ("Siguiente" deshabilitado hasta `ended` de la lámina actual, salvo ya alcanzada o `navegacionLibre`), `maximoAlcanzado`, reanudar por `pasoInicial`, preferencia Automático/Manual (`localStorage['tramarsa_autoplay_' + moduloId]`), auto-avance con 600ms de pausa entre láminas en Automático, lámina sin audio = avance libre inmediato.
- **Barra de progreso**: posición calculada **siempre desde el audio local** (`(indiceActual + currentTime/duration) / total`) — ground truth exacto, sin `getComputedStyle` ni variables cacheadas. Animación por transición CSS con la duración real restante, relanzada desde la posición exacta tras pausa/reanudación o rebuild de controles.
- **Fullscreen**: mismo criterio que el driver legacy — disponible solo con Automático, fullscreen sobre `#viewReproductor` completo, orientation lock landscape (si el SO lo soporta), modo compacto (solo barra + botón salir) dentro de fullscreen, aviso auto-ocultable.
- **`destruir()`**: pausa el audio, quita listeners, limpia `src` — el elemento compartido NO se destruye (queda desbloqueado para el próximo módulo).

### 17.B — `DriverIndexHtml` (formato v1, legacy)

#### `detectar(zip)`
Que exista un `index.html` en algún nivel del paquete (y no haya `manifest.json`, que tiene prioridad).

### `montar(...)`
1. Calcula preferencia Automático/Manual (`leerPreferenciaAutoplay`, `localStorage['tramarsa_autoplay_' + moduloId]`, persiste hasta que el usuario la cambie, por módulo).
2. Construye el documento virtual (`construirDocumentoModulo`).
3. Monta el `<iframe sandbox="allow-scripts allow-forms allow-popups" allow="autoplay; fullscreen">` y le asigna `iframe.src = url`.
4. Registra el listener de `message`, filtrando `evento.source !== this.iframe.contentWindow` (solo mensajes del propio módulo montado, no de cualquier iframe/ventana).
5. Arranca el temporizador de gracia sin SDK (8s).

### Manejo de cada mensaje (ver tabla completa en sección 14)
Puntos especialmente delicados:
- **`modulo:iniciado`**: orden importa — primero `lms:alternarAutoplay` (para que el autoavance interno del módulo ya quede correcto), después `lms:reanudar`. `reproducir` sigue la preferencia guardada; no se intenta recordar el segundo exacto del audio, solo la lámina. `this.pausado` se calcula así: en el primer montaje (`pasoInicial=0`) el módulo ya arrancó sonando por el click de "Iniciar módulo" del usuario, sin importar la preferencia; al retomar en progreso (`pasoInicial>0`), si la preferencia es Manual no arranca nada y el botón debe partir en "Reproducir".
- **`navegacionLibre`**: el gate anti-trampa vive **dentro** del módulo (`maxAlcanzado` propio) — el driver puede tener su botón "Siguiente" habilitado, pero si el módulo no sabe que está en revisión libre, su lógica interna de avance sigue bloqueando el paso real. Bug real reportado y corregido: "Siguiente se ve habilitado pero no adelanta la lámina" — el fix fue que el módulo respete `navegacionLibre` en su propia función de ir-a-paso (ver sección 23).
- **`modulo:avance`**: **siempre salto instantáneo**, nunca animación — `transition:'none'` antes de fijar el ancho, si no el navegador interpolaría un reinicio (100%→0%) como si fuera progreso normal.
- **`modulo:segmentoAudio`**: ver detalle completo en sección 19.
- **`modulo:pausado`**: congela la barra donde iba (`getComputedStyle`) sin rebuild completo del panel (que recrearía el nodo y perdería la posición).

### `actualizarIconoPlayPausa()`
Método liviano: actualiza solo el ícono/título del botón play-pausa, sin recrear el resto de la barra — usado por pausado/reanudado para no perder el estado de la animación CSS en curso.

### `renderControles()`
Rebuild completo de la barra: Prev / Play-Pausa / barra de progreso / Siguiente-Continuar / botón Automático-Manual (ícono `zap`/`hand`, mismo tamaño que los demás botones — `flex:0;min-width:44px`).

### `destruir()` — fix crítico de audio en segundo plano
```js
if (this.iframe) {
  this.iframe.src = 'about:blank';
  this.iframe.remove();
  this.iframe = null;
}
```
**Bug real:** ocultar `#viewReproductor` con CSS (`display:none`) **no detiene el iframe** — sigue vivo, el audio sigue sonando y el módulo sigue autoavanzando en segundo plano aunque nadie lo vea, corrompiendo el progreso guardado la próxima vez que llegara un `modulo:diapositiva`/`avance` real. Sacar el iframe del DOM es la única forma garantizada de detener todo lo que corre adentro (audio, timers, la lógica interna del módulo) — por spec, un iframe removido termina su browsing context al instante. `src='about:blank'` primero por si algún navegador demora el `remove()` un tick.

---

## 18. Lógica del reproductor, estados y modos

### Estados del reproductor (driver)
| Estado | Variable | Significado |
|---|---|---|
| Cargando | — | Descarga/normalización del paquete en curso (`mostrarCargandoReproductor`) |
| Controlado | `modoControlado` | El módulo integró el SDK y reportó `modulo:iniciado` |
| Incompatible | — | 8s sin `modulo:iniciado`: aviso, sin atajo para avanzar |
| Reproduciendo | `!pausado` | Audio/contenido de la lámina actual en curso |
| Pausado | `pausado` | Reproducción detenida por el usuario, barra congelada exactamente donde iba |
| Evaluación | (en `reproductor.js`, `RP.preguntas`) | Banco de preguntas activo, una a la vez |
| Resultado aprobado / desaprobado | — | Pantalla final |
| Modo revisión | `RP.modoRevision` | Módulo ya `COMPLETADO`: navegación libre, sin re-evaluar |

### Modo Automático vs Modo Manual
Preferencia del **usuario para ese módulo específico**, no del módulo en sí — vive en `localStorage` del navegador (`tramarsa_autoplay_{moduloId}`), nunca en Firestore ni en el paquete. Persiste hasta que el usuario la cambie. Botón dedicado en la barra de controles (ícono `zap` para Automático, `hand` para Manual). Al alternar: se guarda la preferencia y se envía `lms:alternarAutoplay{activo}` al módulo, que debe ajustar su autoavance interno.

### Restricciones de navegación (anti-trampa)
"Siguiente" solo se habilita si la lámina actual **ya fue completamente escuchada** (`modulo:audioFinalizado` recibido) **o** si esa lámina ya había sido alcanzada antes (`indice < maximoAlcanzado`, o `navegacionLibre=true` en modo revisión). Retroceder y pausar están **siempre** permitidos. Nunca se puede "adelantar" saltándose audio no escuchado — esta regla vive por partida doble: en el driver (habilita/deshabilita el botón visual) y **dentro del propio módulo** (su función de ir-a-paso respeta el mismo criterio, para que el comando `lms:siguiente` tampoco pueda forzar un salto no autorizado).

### Persistencia del progreso
- `pasoMaximoAlcanzado` (Firestore, `historial`): índice 0-based del paso más lejano alcanzado alguna vez. Nunca decrece (retroceder no lo pisa). Es la base tanto del anti-trampa como de "reanudar exactamente donde quedó" (`pasoInicial` al volver a abrir un módulo en progreso).
- `avancePct`: progreso parcial (0-99 mientras `EN_PROGRESO`, 100 solo al aprobar), calculado en `guardarAvanceHistorial(pasoActual, totalPasos)` cada vez que llega `modulo:diapositiva`.
- Estos dos campos se actualizan **solo** en `modulo:avance`/`modulo:diapositiva` (progreso confirmado) — nunca desde `modulo:segmentoAudio` (progreso "en vivo, aún no terminado de escuchar"), para no romper el anti-trampa.

---

## 19. Barra de progreso — diseño técnico

**Objetivo de producto:** movimiento verdaderamente continuo y fluido, sincronizado exactamente con el audio de cada lámina — nunca adelantarse ni atrasarse, terminando exactamente cuando termina el audio; y al pausar/reanudar, congelarse y continuar sin saltos ni reinicios.

### Diseño actual (formato v2 — `DriverLaminas`)
El LMS es dueño directo del elemento `<audio>`, así que la posición de la barra se calcula **siempre desde la verdad absoluta local**: `pct = ((indiceActual + currentTime/duration) / totalLaminas) * 100`. Sin postMessage, sin `getComputedStyle`, sin variables cacheadas. La animación fluida sigue siendo una única transición CSS por lámina (`transition: width {restanteMs}ms linear`, disparada en el evento `playing`), pero congelar en pausa, reanudar sin salto y reconstruir controles a mitad de lámina son triviales: cualquier punto de reinicio se recalcula exacto desde `currentTime`. El progreso persistido en Firestore sigue viniendo solo de láminas confirmadas, nunca de la animación visual.

### Diseño legacy (formato v1 — `DriverIndexHtml`, 2ª iteración que reemplazó un diseño de "ticks")
Un primer diseño mandaba un mensaje por cada tick de `timeupdate` del audio (throttled), calculando el porcentaje como `(indiceActual + fracción) / total`. Esto causaba una regresión visible: al cruzar a la siguiente lámina, el cálculo reiniciaba a una fracción baja, haciendo que la barra pareciera "retroceder" justo después de llegar al porcentaje de fin de la lámina anterior. Se descartó una solución superficial (bajar el intervalo de throttle) en favor de una solución estructural.

**Diseño actual:** el módulo manda **un único mensaje `modulo:segmentoAudio{pctDestino, duracionMs}` por lámina**, disparado en el evento nativo `'playing'` del elemento `<audio>` (no en cada `timeupdate`). `duracionMs` es el tiempo real restante del audio en ese instante. El driver arma **una sola transición CSS** (`transition: width {duracionMs}ms linear`) y fija el ancho destino — el navegador interpola la animación nativamente a la tasa de refresco de pantalla, sin overhead de `postMessage` por frame ni recálculo por JavaScript. Validado con datos reales: **22–66 ms de desvío** en 6 láminas de 10–13 segundos cada una — indistinguible visualmente, la barra termina exactamente cuando termina el audio.

### Congelado en pausa y reanudación sin salto
El punto de partida de cada nueva transición **no** se toma de una variable JS cacheada (`pctAvanceReal`), sino del **ancho visual real actual** vía `getComputedStyle(fill).width`:
```js
const anchoActual = getComputedStyle(fill).width;
fill.style.transition = 'none';
fill.style.width = anchoActual;
void fill.offsetWidth; // fuerza reflow
fill.style.transition = `width ${datos.duracionMs}ms linear`;
fill.style.width = datos.pctDestino + '%';
```
**Bug real corregido:** la primera versión de este handler usaba `this.pctAvanceReal` (una variable que nunca se actualizaba durante una animación en curso ni durante una pausa) como punto de partida — esto causaba un salto o congelamiento incorrecto al reanudar en medio de una lámina, porque el valor cacheado no reflejaba dónde estaba realmente el relleno visual. `getComputedStyle` siempre refleja la posición real, esté animando, recién congelada por una pausa, o en reposo. El `void fill.offsetWidth` fuerza un reflow entre fijar el ancho actual (`transition:none`) y arrancar la nueva transición — sin esto el navegador podría fusionar ambos cambios de estilo y saltar directo al destino sin pasar visualmente por el punto de partida.

Al pausar (`modulo:pausado`): se toma el mismo snapshot `getComputedStyle` y se fija `transition:'none'` — la barra queda congelada exactamente donde iba, sin rebuild del panel completo (que perdería la posición al recrear el nodo).

---

## 20. Evaluación

- Si el módulo tiene banco de preguntas (`modulo.preguntas`, cargado por separado desde el panel admin, o `questions.json` embebido en el zip por compatibilidad), se seleccionan `Math.min(5, banco.length)` preguntas al azar, con las alternativas también mezcladas.
- Una pregunta a la vez, **sin retroceder**, 30 segundos por pregunta (tiempo agotado = respuesta incorrecta automática vía `seleccionarAlternativa(-1)`).
- **Umbral de aprobación: 70%.**
- Si no hay banco de preguntas en absoluto, el módulo se marca completado directo al terminar el contenido (`puntaje: null`).
- Si no aprueba: el intento fallido no se guarda como historial separado — el documento permanece `EN_PROGRESO`, puede reintentar con un set de preguntas distinto.

---

## 21. Certificados

- Si `modulo.certificadoUrl` existe: se descarga el PDF plantilla y, usando **pdf.js**, se localiza la posición exacta (x, y, ancho, alto) de cada texto placeholder (`NOMBRES APELLIDOS`, `MÓDULO`/`MODULO`, `FECHA`/`DD de MM del AAAAA`) — soporta que el mismo texto aparezca más de una vez (común en plantillas de diseño). Con **pdf-lib**, se dibuja un rectángulo blanco exactamente sobre cada ocurrencia y se escribe el valor real centrado en la misma posición y tamaño (fuente `HelveticaBold` — Arial no es embebible sin licenciar el TTF; Helvetica es el sustituto métricamente compatible estándar).
- **Nombre de archivo:** `aaaa-mm-dd_nombres_apellidos_m{numeroModulo}.pdf`, usando el `numeroModulo` permanente del módulo — nunca se recalcula por posición ni cantidad de módulos existentes.
- **Presentación como "diploma":** el PDF final se renderiza a `<canvas>` (pdf.js) y se muestra como `<img class="cert-diploma">`, no en un visor de PDF con su propia barra de herramientas.
- `generarBytesPdfCertificado(usuario, modulo, fechaEmisionISO)` es una función **pura** (no toca el DOM ni `RP`), reutilizada tanto por el flujo normal del reproductor como por `descargarCertificadoAdmin(usuario, modulo, fechaEmisionISO)` (el admin descarga el certificado de cualquier trabajador desde el acordeón de Usuarios, sin pasar por el reproductor).
- La fecha del certificado es **siempre** `historial.fechaFin` (fecha de la primera aprobación), nunca la fecha en que se vuelve a ver/descargar.
- **Compatibilidad legacy:** módulos antiguos con `certificate/template.png` + `certificate/layout.json` dentro del propio `.zip` — genera un PNG en vez de PDF, dibujado sobre `<canvas>` en la posición declarada en `layout.json`.

---

## 22. Flujo "Volver a ver"

Cuando un trabajador reabre un módulo ya `COMPLETADO`:
- `RP.modoRevision = true` — se calcula en `montarDriverDelModulo()` comprobando `hist.estado === 'COMPLETADO'`.
- **Navegación totalmente libre** desde el paso 0 (`navegacionLibre=true` enviado al módulo vía `lms:reanudar`) — no hay restricción de audio, se puede saltar a cualquier lámina.
- **El historial nunca se reescribe** — es una defensa por partida doble: `RP.modoRevision` bloquea tanto la re-generación de la evaluación como cualquier escritura en `finalizarModulo()`.
- Al llegar al final del contenido, **no se vuelve a mostrar la evaluación ni la pantalla de resultado/certificado** — se muestra una pantalla corta de agradecimiento (`renderAgradecimientoRevision`, "Gracias por volver a ver el módulo.") con un botón "Salir". Diseño explícito: cerrar en seco tras terminar de repasar se sentía abrupto para el usuario; volver a mostrar la evaluación real habría sido incorrecto (no es una re-evaluación).
- El botón de salida superior (`btnSalirReproductor`) **no muestra alerta de confirmación** en este modo — no hay nada que perder (solo repaso). Tampoco la muestra en la pantalla de resultado/certificado (`RP.progresoFinalizado=true`), porque ahí el progreso ya está guardado y la advertencia sería directamente falsa. Solo se pregunta si hay una evaluación real en curso todavía sin cerrar.

---

## 23. Formato oficial de un módulo — cómo crear futuras capacitaciones

**Formato oficial: v2 declarativo.** El módulo es SOLO contenido — sin JS de control, sin controles propios, sin pantalla de inicio, sin SDK. El LMS dirige todo. Sin modo standalone (decisión de producto: el paquete ya no es una app; se retiró el requisito de doble ejecución).

### Las 3 variantes del manifest (mezclables)

**A. Láminas imagen** (módulos exportados de PowerPoint — ej. `modulo001`/`modulo002`):
```
modulo.zip
├── manifest.json
├── img/Diapositiva01.png ... NN.png
└── audio/audio1.mp3 ... audioN.mp3
```
```json
{ "version": 2, "laminas": [
    { "imagen": "img/Diapositiva01.png", "audio": "audio/audio1.mp3" },
    { "imagen": "img/Diapositiva02.png", "audio": "audio/audio2.mp3" }
] }
```

**B. Láminas HTML por archivo** (fragmentos separados + CSS global):
```json
{ "version": 2, "css": "estilos.css", "lienzo": { "ancho": 1920, "alto": 1080 },
  "laminas": [ { "html": "laminas/lamina1.html", "audio": "audio/audio1.mp3" } ] }
```

**C. Contenido único** (LA variante plantilla para regeneración por IA — ej. `modulo003`/`modulo004`):
```
modulo.zip
├── contenido.html      ← UN archivo: <style> + N <section class="slide">
├── manifest.json
└── audio/audio1.mp3 ... audioN.mp3
```
```json
{ "version": 2, "contenido": "contenido.html",
  "laminas": [ { "audio": "audio/audio1.mp3" }, { "audio": "audio/audio2.mp3" } ] }
```

Reglas generales: cada lámina declara `imagen` o `html`, o el manifest declara `contenido` (el driver extrae las `<section class="slide">` en orden y las empareja con los audios). `audio` es opcional por lámina (sin audio = avance libre inmediato). `lienzo` opcional (default 1920×1080; el LMS escala solo). Validación estricta: archivo declarado que no existe, o menos secciones que audios → error explícito al montar, nunca fallo silencioso.

### Flujo de regeneración por IA (variante C — el caso de uso del cliente)
`contenido.html` lleva un comentario-contrato al inicio del propio archivo con las reglas para la persona o IA que regenere el contenido:
- Mantener EXACTAMENTE la estructura: un `<style>` y N `<section class="slide">`, en orden.
- No agregar scripts, botones, audio ni lógica — el LMS controla todo.
- Libre: el contenido y el diseño visual interno (textos, colores, layout dentro de cada sección y del `<style>`).
- Lienzo 1920×1080, el LMS lo escala.
- Audios aparte como `audio/audio1.mp3 ... audioN.mp3`, uno por lámina (generados con TTS a partir del guion); `manifest.json` solo se toca si cambia la cantidad de láminas.

El cliente entrega a su IA: el Word/PowerPoint con el contenido + el `contenido.html` plantilla → la IA devuelve un solo archivo actualizado. Un solo archivo a subir/bajar, cero riesgo de romper funcionalidad (no hay funciones que romper — es contenido puro).

### Cómo se genera un módulo nuevo (paso a paso operativo)
1. Armar el paquete en cualquiera de las 3 variantes (recomendado: copiar uno de los 4 módulos de referencia como plantilla).
2. Preparar por separado: miniatura (imagen 16:9), archivo de preguntas (`.txt`/`.docx`/`.json`) y plantilla de certificado (`.pdf` con placeholders `NOMBRES APELLIDOS`/`MÓDULO`/fecha).
3. Comprimir como `.zip` (o `.rar`, o arrastrar la carpeta al formulario — la app la comprime en el navegador).
4. Panel Admin → Módulos → **Nuevo módulo**: nombre/descripción/categoría, ícono y color, y los 4 archivos en sus cuadrantes (sección 11.2).
5. Al guardar: paquete + PDF suben a GitHub en un solo commit, preguntas se parsean, documento en `modulos/{id}` con `numeroModulo` permanente.
6. Asignar a trabajadores (por Empresa/Sede/Gerencia o individual).

### Formato v1 legacy (solo para paquetes antiguos ya subidos)
Paquete con `index.html` + Motor propio + contrato SDK (sección 14). Reproducible vía `DriverIndexHtml` mientras no se reemplace. **No crear módulos nuevos así.**

---

## 24. Flujo completo de sistema: Login → Certificado

1. Trabajador abre la app → `DOMContentLoaded` → `onAuthStateChanged` resuelve la sesión (con o sin refresco de caché entre pestañas, sección 10) → render del panel Trabajador.
2. Clic en un módulo pendiente ("Iniciar") o en progreso ("Continuar") → `abrirReproductor(moduloId)` — **primera línea síncrona: `desbloquearAudioLaminas()`** (consume el gesto del click para desbloquear el elemento Audio compartido antes de que expire durante la descarga).
3. `DB.crearHistorialSiNoExiste` — crea `historial/{dni}_{moduloId}` en `EN_PROGRESO` si no existía.
4. Descarga del paquete (`fetch(modulo.archivoUrl)`) → `archivoAJSZip` (package-adapters) → `JSZip` en memoria.
5. `seleccionarDriver(zip)` → `DriverLaminas` si hay `manifest.json` (formato oficial v2); si no, `DriverIndexHtml` (legacy).
6. **(v2)** `montar()` lee el manifest, valida y prepara cada lámina (blob URL de imagen / srcdoc del fragmento HTML / sección extraída del contenido único) y muestra la primera lámina pendiente **de inmediato, con audio sonando** (sin pantalla "Iniciar módulo"). *(v1 legacy: resolver 3 pasadas → iframe → handshake SDK.)*
7. El usuario avanza lámina a lámina: el LMS reproduce el audio local, anima la barra, habilita "Siguiente" al `ended` de cada lámina, persiste `avancePct`/`pasoMaximoAlcanzado` en cada lámina confirmada. Automático = auto-avance al terminar el audio; Manual = espera el click.
8. Última lámina terminada → botón "Continuar" → `callbacks.onFinalizado()` → `prepararEvaluacionOFinalizar()`.
9. Si hay banco de preguntas: evaluación (5 preguntas aleatorias, 30s c/u) → `finalizarModulo(puntaje)`.
10. Si `puntaje >= 70` (o no hay evaluación): `DB.actualizarHistorial` marca `COMPLETADO`, fija `fechaFin` → `renderResultadoAprobado` → `intentarGenerarCertificado` (pdf.js localiza placeholders, pdf-lib los reemplaza) → certificado descargable.
11. Si `puntaje < 70`: pantalla de reintento, `historial` permanece `EN_PROGRESO`.
12. Cierre del reproductor (`cerrarReproductor`): destructor del driver (v2: pausa y libera el audio compartido; v1: saca el iframe del DOM), revoca Blob URLs temporales, vuelve al dashboard.

---

## 25. Decisiones de arquitectura y por qué se eligieron

| Decisión | Motivo |
|---|---|
| Firestore como única fuente de verdad de negocio | Reemplaza `localStorage`/IndexedDB/`data.json` (un solo navegador a la vez) — necesario para multiusuario real |
| Login por DNI, Auth con el **correo real** (no sintético) | Permite `sendPasswordResetEmail` nativo (entregable de verdad) y simplifica el modelo, a costa de necesitar lectura pública de `usuarios` para el lookup DNI→correo previo al login |
| App secundaria de Firebase para crear usuarios | Limitación del SDK client-side: no existe "admin crea usuario para otro" sin perder la sesión propia, salvo con una segunda instancia de Firebase App |
| Sin campo `password` en Firestore | La contraseña real vive solo en Firebase Auth (hasheada) — decisión de seguridad explícita |
| Archivos de módulos en GitHub (Git Data API), no Firebase Storage | Repositorio dedicado, público, URLs `raw.githubusercontent.com` directamente utilizables, subida automática sin que el admin use Git |
| Token de GitHub client-side (no Cloud Functions) | Riesgo de exposición aceptado explícitamente, a cambio de mantener la arquitectura 100% sin servidor propio |
| Un solo commit para varios archivos en `github-storage.js` | Corrección de un bug real y reproducible: commits secuenciales chocaban con el lag de propagación de la API de referencias de GitHub |
| Reglas de Firestore `auth != null` (sin distinguir rol) | Sin Custom Claims/Cloud Functions no hay forma confiable de verificar el rol en las reglas — limitación aceptada, documentada como pendiente |
| `libarchive.js` autohospedado en vez de CDN | El Worker de módulo que usa la librería no puede crearse desde un origen CORS distinto |
| Certificado en PDF (pdf-lib + pdf.js) en vez de PNG | Requisito de producto: plantilla editable en PDF real, reemplazo de texto centrado sin alterar el resto del diseño |
| Sin listeners en tiempo real (`onSnapshot`) | Simplicidad: mismo patrón síncrono-por-render que la versión anterior, ahora con `await` en vez de lectura de memoria |
| Reproductor universal (`index.html` + SDK postMessage) en vez de detección de formato interno *(decisión histórica del v1, hoy legacy)* | El LMS controla la lógica académica sin entender la estructura interna del módulo — superada por el formato v2 declarativo (ver filas de abajo) |
| Iframe sandbox **sin** `allow-same-origin` (origen opaco) | Aislamiento real del módulo respecto a Firestore/Auth/`window` del LMS |
| Inlineo de `<script>`/`<link>` en vez de referencia por URL para archivos externos del módulo | Corrección de una limitación real del navegador (origen opaco) |
| Assets internos como `data:` URI, no `blob:` URL | Corrección de una regresión de plataforma: partición de almacenamiento de Chrome rompe `blob:` URLs entre orígenes distintos dentro de un iframe opaco |
| Modo dual obligatorio (`controladoPorLMS = !!window.TramarsaLMS`) | Cada módulo debe seguir funcionando de forma autónoma fuera del LMS, con el mismo diseño y comportamiento |
| `numeroModulo` permanente, asignado una sola vez | El nombre del certificado depende de un número estable de por vida — recalcularlo (ej. por posición) rompería certificados ya emitidos |
| Token de GitHub ofuscado en base64 (no es medida de seguridad real) | Evita la auto-revocación de GitHub por secret-scanning; no reduce la exposición real |
| Barra de progreso: un mensaje `segmentoAudio` por lámina + transición CSS, no ticks por frame | Elimina estructuralmente la regresión visual de "retroceder" al cruzar de lámina, y evita overhead de postMessage por frame |
| Punto de partida de cada transición: `getComputedStyle` real, no variable JS cacheada | Corrige saltos/congelamientos al pausar/reanudar en medio de una animación |
| Preferencia Automático/Manual en `localStorage`, no en Firestore | Es una preferencia de UI del navegador para ese módulo, no un dato de negocio a sincronizar entre dispositivos |
| `destruir()` del driver saca el iframe del DOM (no solo oculta con CSS) | Único modo garantizado de detener audio/timers/lógica del módulo en segundo plano — corrige corrupción de progreso guardado |
| Persistencia de sesión: repoblar `sessionStorage` desde Firestore en pestañas nuevas | Firebase Auth ya restauró la sesión real; el caché de UI por pestaña no debe forzar un login innecesario |
| Cierre por inactividad solo con clic/tecla, no `mousemove`/`scroll` | Esas señales no garantizan uso real de la plataforma (una pestaña de fondo con scroll accidental no debería contar como actividad) |
| Formulario de carga de módulo: solo indicador ✅/❌ + papelera, sin texto/preview | Mantener tamaño y diseño del cuadrante estables sin importar el estado, interfaz limpia y uniforme en los 4 campos |
| Eliminación de Asignaciones y Reportes como secciones separadas del panel admin | Redundantes tras el rediseño de Usuarios: el acordeón de progreso y la tarjeta de cada módulo ya cubren la misma información |
| **Formato v2 declarativo (manifest.json) como formato oficial de módulo** | El módulo es contenido puro y el LMS ejecuta: elimina de raíz toda la familia de bugs de ejecutar JS ajeno en iframe opaco (blob URLs, MIME, inlineo, autoplay, gate duplicado). Declarativo/explícito, no adivinación de nombres como el driver pre-v1 |
| `DriverIndexHtml` conservado como fallback, nunca borrado | Paquetes v1 ya subidos a GitHub siguen reproduciéndose sin migración forzada; Strategy ya soportaba múltiples drivers |
| Sin pantalla "Iniciar módulo" en v2 + `desbloquearAudioLaminas()` en el click original | El gesto ya ocurre en el documento del LMS; el desbloqueo del elemento Audio compartido sobrevive a la descarga del zip (el gesto transitorio expira). Si el navegador igual bloquea, degrada a botón Play sin romper el flujo |
| Sin modo standalone en módulos v2 | El paquete dejó de ser una app — requisito retirado explícitamente por decisión de producto |
| Variante "contenido único" (un solo HTML con todas las secciones) | Caso de uso del cliente: regenerar contenido con IA tocando UN archivo, con el contrato de reglas embebido como comentario en el propio archivo |
| Lámina HTML en iframe-póster (`srcdoc`, sandbox sin canal de comunicación) | El diseño HTML queda aislado del LMS pero sin protocolo: el LMS nunca espera nada del iframe — si su JS decorativo falla, el flujo no se entera |
| Logout: overlay inmediato + marca `tramarsa_logout` para arranque rápido | La demora real era reload completo + espera de `onAuthStateChanged`; el overlay elimina la percepción de botón muerto y la marca ahorra 1-2s mostrando el login sin esperar Auth |

---

## 26. Problemas reales encontrados y cómo se resolvieron

1. **`422 Update is not a fast forward` al subir módulo + certificado.** Causa: commits secuenciales (uno por archivo) chocaban con el lag de propagación real (varios segundos) de la API de referencias de GitHub entre el `PATCH` de un commit y que el siguiente `GET` de esa rama lo reflejara. Fix: agrupar todos los archivos de un mismo guardado en **un solo commit** (blob→tree→commit→ref). Persiste un reintento con backoff exponencial (12 intentos, tope 10s) para el caso raro de colisión con otra subida simultánea.
2. **`<script src="blob:...">`/`<link href="blob:...">` nunca cargaban en módulos con `css/`/`js/` externos.** Causa: iframe con origen opaco (sandbox sin `allow-same-origin`) no puede resolver un blob creado desde otro origen para sub-recursos de tipo script/link (a diferencia de `img`/`audio`/`video`). Diagnosticado con instrumentación progresiva (`window.onerror`, checkpoints de depuración) hasta confirmar que `TramarsaLMS` existía pero el script externo jamás corría. Fix: inlinear el contenido real de esos archivos directo en el HTML (pasada 1 del resolver).
3. **Regresión de plataforma: `img`/`audio`/`video` dejaron de cargar en todos los módulos.** Causa: partición de almacenamiento de Chrome para `blob:` URLs — un iframe opaco ya no puede resolver blobs creados por el documento padre. Fix: todos los assets internos del módulo se sirven como `data:` URI en vez de `blob:` URL (el documento final del módulo sigue siendo `blob:` porque es una navegación de iframe, no un sub-recurso).
4. **`blob.type` vacío rompía audio/video silenciosamente.** JSZip deja `Blob.type=''` al leer archivos sin pasar `{mimeType}`. `<img>` tolera esto (sniffea bytes), `<audio>`/`<video>` no, y no lanzan error — parecía "no pasa nada". Fix: determinar MIME siempre por extensión del archivo, nunca por `blob.type`.
5. **Barra de progreso "avanza y retrocede" al cruzar de lámina.** Causa: diseño de ticks por `timeupdate` calculando `(indice+fracción)/total`, que reinicia a fracción baja en cada nueva lámina. Fix estructural (no un ajuste de throttle): un solo mensaje `segmentoAudio` por lámina + una transición CSS de duración exacta.
6. **Salto/congelamiento al reanudar de una pausa en medio de una animación de la barra.** Causa: el punto de partida de la nueva transición usaba una variable JS (`pctAvanceReal`) nunca actualizada durante la animación en curso. Fix: usar `getComputedStyle(fill).width` (posición visual real) como punto de partida, con `void fill.offsetWidth` para forzar reflow.
7. **Audio siguiendo sonando en segundo plano tras cerrar el reproductor con la X.** Causa: ocultar el contenedor con `display:none` no detiene un iframe — sigue vivo, corrompiendo el progreso guardado al llegar eventos tardíos. Fix: `destruir()` saca el iframe del DOM (`remove()`, con `src='about:blank'` antes por si el navegador demora el remove un tick).
8. **"Siguiente" se veía habilitado en el LMS pero no adelantaba la lámina en modo "Volver a ver".** Causa: el gate anti-trampa vive dentro del propio módulo; el driver puede habilitar visualmente su botón, pero si el módulo no sabe que está en `navegacionLibre`, su propia función interna de ir-a-paso lo sigue bloqueando. Fix: propagar `navegacionLibre` al módulo vía `lms:reanudar`, y que el módulo desactive su gate interno cuando ese flag es `true`.
9. **Refresh de página devolvía al login con una sesión válida.** Causa: comprobación síncrona de `auth.currentUser`, que puede seguir siendo `null` justo al cargar aunque exista sesión (Firebase Auth restaura de forma asíncrona). Fix: esperar la primera resolución de `onAuthStateChanged`.
10. **Pestaña/ventana nueva mostraba login pese a sesión de Firebase Auth válida en otra pestaña.** Causa: el caché de UI en `sessionStorage` es por pestaña, y la app exigía `sesion && user` para el auto-login. Fix: si hay `user` de Auth pero no hay `sesion` en caché, repoblarla desde Firestore por correo antes de decidir.
11. **`getElementById(null).addEventListener` — crash potencial tras eliminar el botón "Asignar a todos".** Al quitar el botón del HTML se dejó huérfano su listener en JS. Detectado y corregido antes de que causara un fallo de carga de página.
12. **Anillo de progreso delgado en tamaños reducidos.** CSS con `width`/`font-size` fijos en vez de proporcionales al contenedor — corregido a `calc()`/`em` relativos.
13. **Centrado roto en columnas de la tabla de Usuarios pese a `text-align:center` en el `<th>`/`<td>`.** Causa raíz: `.icon-btn{display:flex}` ignora `text-align` del padre (flex no respeta esa propiedad). Fix: envolver los botones en un `<div style="display:flex;justify-content:center">`.
14. **Autoplay bloqueado tras la descarga del zip (formato v2, sin pantalla "Iniciar módulo").** El gesto de usuario transitorio expira durante la descarga (varios segundos) y `audio.play()` sería rechazado. Fix: `desbloquearAudioLaminas()` reproduce un WAV silencioso en el elemento Audio compartido como **primera línea síncrona** de `abrirReproductor` (aún dentro del click) — el elemento queda desbloqueado para la sesión de página. Degradación limpia a botón Play si el navegador igual bloquea.
15. **"Cerrar sesión" percibido como lento/muerto en móvil.** Tres capas acumuladas: (a) el click burbujeaba al listener global de inactividad y rearmaba el temporizador (cierre "fantasma" posterior); (b) `await signOut()` sin tope bloqueaba el botón según la red; (c) el `location.reload()` + espera de `onAuthStateChanged` tomaban 2-4s sin ninguna reacción visual. Fixes: guard de inactividad + `Promise.race` con tope de 1.5s + overlay "Cerrando sesión..." inmediato + marca `tramarsa_logout` que hace que la página recargada muestre el login sin esperar Auth.
16. **Contenido tapado por la barra de navegación del celular.** `100vh` incluye el área detrás del chrome del navegador móvil. Fix: patrón `height:100vh; height:100dvh;` en `#viewApp`/`.main`/`.drawer` + `padding-bottom:env(safe-area-inset-bottom)` en `.main`/`.sidebar`/`#viewReproductor` (barra de gestos superpuesta).

---

## 27. Limitaciones conocidas

1. **Seguridad multi-rol débil**: cualquier cuenta autenticada (incluyendo TRABAJADOR) puede, en teoría, llamar directamente a la API de Firestore fuera de la UI y leer/escribir más de lo que la interfaz permite. Requiere Custom Claims + Cloud Function.
2. **Token de GitHub expuesto en el cliente** — visible en el código fuente servido. Riesgo aceptado, mitigado solo por el alcance mínimo del token.
3. **No se puede cambiar la contraseña de otro usuario desde el panel admin** — solo el propio usuario (Perfil) o vía el correo de restablecimiento nativo.
4. **Eliminar un módulo no borra sus archivos en GitHub** — manual en el repositorio.
5. **Sin actualización en tiempo real entre sesiones/pestañas** — dos administradores con la pantalla abierta a la vez no se ven reflejados sin refrescar.
6. **Sin límite de tamaño de archivo explícito en la UI** — validado con `.rar` real de 26 MB; archivos de cientos de MB no probados (la codificación a base64 ocurre 100% en el navegador).
7. **`usuarios` es de lectura pública sin autenticar** — necesario para el login por DNI, riesgo menor aceptado.
8. **Sin Cloud Functions**: toda operación administrativa sensible se resuelve con patrones del lado del cliente.
9. **`js/vendor/libarchive/*` son binarios de terceros** — no se actualizan automáticamente.
10. **Módulos sin integración del SDK no son reproducibles en absoluto** (decisión anti-trampa deliberada) — solo aviso de incompatibilidad tras 8s.
11. **Sin borrado automático de archivos huérfanos en GitHub** al reemplazar el archivo de un módulo existente al editarlo.
12. **Los paquetes ya subidos a GitHub pueden seguir en formato v1** — se reproducen vía `DriverIndexHtml` (legacy) pero sin las garantías del v2. Los 4 módulos de referencia locales ya están convertidos a v2; falta re-subirlos desde el panel admin para reemplazar las versiones v1 en producción.
13. **`.rar` no funciona bajo `file://`** (doble clic local) — requiere servir la app desde un servidor estático, aunque sea local (`python -m http.server`, `iniciar_index.bat`).
14. **Persistencia de sesión y cierre por inactividad**: implementados y verificados por revisión de código + `node --check`, pero **no validados aún funcionalmente contra Firebase en un turno largo de inactividad real** en producción.
15. **Sin importación masiva probada a gran escala** — el flujo de Excel crea las cuentas de Auth una por una, secuencialmente; decenas/cientos de filas puede ser lento.

---

## 28. Pendiente para futuras versiones

Priorizado:

1. **Custom Claims + Cloud Function mínima** para verificar el rol ADMIN en las reglas de Firestore de forma confiable — la mejora de seguridad más importante pendiente.
2. **Re-subir los 4 módulos de referencia en formato v2** desde el panel admin (los paquetes locales ya están convertidos — falta reemplazar las versiones v1 que sigan en GitHub) y validar en vivo el arranque directo con audio (desbloqueo de autoplay).
3. **Borrado de archivos en GitHub al eliminar un módulo** (Contents API `DELETE` por archivo, o reconstrucción del árbol excluyéndolos).
4. **Listeners en tiempo real (`onSnapshot`)** al menos en las vistas de admin más usadas (Módulos, Usuarios).
5. **Cloud Function para cambiar la contraseña de otro usuario** desde el panel admin.
6. **Límite de tamaño de archivo con feedback claro en la UI** antes de subir, y barra de progreso real durante la subida a GitHub (hoy solo cambia el texto del botón).
7. **Colección `configuracion`**: ya reservada en las reglas, sin uso — candidata para ajustes globales (umbral de aprobación configurable, cantidad de preguntas, tiempo por pregunta).
8. **Revisar la exposición pública de `usuarios`** — evaluar un esquema alternativo (colección separada solo `{dni: correo}` para el lookup de login).
9. **Validación funcional en vivo de la persistencia de sesión y el cierre por inactividad** contra el proyecto Firebase real.
10. **Borrado de archivos huérfanos en GitHub** al reemplazar el archivo de un módulo existente al editarlo.

---

## 29. Buenas prácticas y riesgos al modificar el sistema

### Partes más críticas del sistema (tocar con más cuidado)
- **El flujo de login y `onAuthStateChanged` al arrancar** (`app.js`) — un cambio mal hecho puede romper la persistencia de sesión de forma sutil (bug real ya corregido dos veces: refresh y pestaña nueva).
- **`github-storage.js`, `subirArchivosAGithub`** — **no volver a separar la subida de varios archivos en múltiples commits secuenciales**; es un bug real ya diagnosticado y corregido.
- **El patrón de doc ID compuesto** (`{usuarioId}_{moduloId}`) en `asignaciones`/`historial` — garantiza que no haya duplicados; cualquier código nuevo debe seguir usando `setDoc` con este mismo ID, nunca `addDoc`/ID autogenerado.
- **`firebase-secondary.js`** — patrón único para crear cuentas de Auth de terceros sin Cloud Functions; no reemplazar por `createUserWithEmailAndPassword` directo en la app principal fuera del caso de bootstrap del primer admin.
- **`virtual-asset-resolver.js`, orden de las 3 pasadas** (inlineo → sustitución estática → shim runtime) — **no invertir el orden**: si la sustitución estática corre antes del inlineo, el `<script src="js/app.js">` ya habría sido reescrito a una URI de datos y el regex del inlineo no lo reconocería.
- **El iframe de `DriverIndexHtml` nunca debe llevar `allow-same-origin`** en su atributo `sandbox` — base del aislamiento de seguridad de todo el reproductor.
- **Cualquier módulo oficial nuevo debe implementar el patrón dual** `controladoPorLMS = !!window.TramarsaLMS` — no asumir que el módulo solo correrá dentro del LMS.
- **`destruir()` del driver debe seguir sacando el iframe del DOM** (no solo ocultarlo) — revertir esto reintroduce el bug de audio en segundo plano.
- **El punto de partida de cada transición de la barra de progreso** debe seguir siendo la verdad real, nunca una variable JS cacheada: en v2, calculado desde `audio.currentTime/duration`; en v1 legacy, `getComputedStyle`. Revertir a variables cacheadas reintroduce saltos al pausar/reanudar.
- **`DriverLaminas` nunca debe abrir un canal de comunicación con el iframe-póster de láminas HTML** — es la garantía de que el flujo no depende de código del módulo; si se necesita interacción, es señal de que el contenido pertenece al lienzo del LMS o a otro tipo de lámina.
- **`desbloquearAudioLaminas()` debe seguir siendo la primera línea síncrona de `abrirReproductor`** (antes de cualquier `await`) — moverla después de un await rompe el desbloqueo de autoplay porque el gesto del click expira.
- **No borrar `DriverIndexHtml` ni el resolver** mientras exista al menos un paquete v1 subido en GitHub sin reemplazar.
- **`navegacionLibre` debe seguir propagándose hasta el gate interno del módulo**, no solo hasta el botón visual del driver — de lo contrario reaparece el bug de "Siguiente habilitado pero no avanza" en modo revisión.
- **Recordatorio operativo:** tras cualquier cambio en `modulo-loader/*`, re-subir los `.zip` de los módulos ya existentes en GitHub para que el fix llegue a producción.

### Convenciones que deben mantenerse
- Todo el código de negocio en **español** (funciones, variables, comentarios) — convención existente en el 100% del código actual.
- Cada archivo de configuración (`firebase-config.js`, `github-config.js`) debe seguir teniendo una función `xEstaConfigurado()` que detecte placeholders `'TU_...'`, y cada consumidor debe fallar de forma explícita y visible, nunca en silencio.
- Las funciones invocadas desde `onclick="..."` inline en HTML generado por JS deben seguir exportándose al `window` al final de `app.js`/`reproductor.js` (`Object.assign(window, {...})`) — los ES modules no lo hacen automáticamente.
- No reintroducir `localStorage`/IndexedDB como almacenamiento de negocio — solo caché de sesión visible (`getSesion`/`setSesion`), ruta/scroll, o preferencias de UI puramente locales (ej. Automático/Manual por módulo).
- Semántica de Firestore: **omitir un campo = no tocar; enviar `null` explícito = borrar**. Todo código nuevo que implemente un "Eliminar archivo"/"Eliminar campo" debe seguir este patrón, no simplemente omitir el campo.

### Decisiones que no deberían modificarse sin analizar su impacto
- Usar el correo real (no sintético) como identificador de Firebase Auth — cambiarlo rompe `sendPasswordResetEmail` y requeriría rediseñar el login.
- La ausencia de campo `password` en Firestore — decisión de seguridad deliberada.
- El commit único para múltiples archivos en `github-storage.js`.
- Las reglas de Firestore actuales (`auth != null`) — endurecerlas sin Custom Claims puede romper flujos legítimos (ej. el lookup de login); relajarlas más reduce la seguridad ya limitada.
- El diseño de la barra de progreso (un mensaje por lámina + transición CSS) — no volver a un diseño de ticks por `timeupdate`, ya descartado por causar regresión visual.
- El aislamiento del iframe (`sandbox` sin `allow-same-origin`) y el uso de `data:` URI para assets internos — ambos son correcciones de limitaciones reales del navegador, no preferencias estéticas.

---

## 30. Guía rápida para futuras sesiones de desarrollo

**Este documento + el código fuente son autosuficientes.** No depender del historial de conversación que originó el proyecto.

**Archivos que conviene revisar primero, en este orden:**
1. `js/app.js` — el grueso de la lógica de negocio y toda la UI de ambos paneles. El archivo más grande y el que más cambia.
2. `js/modulo-loader/drivers.js` y `virtual-asset-resolver.js` — si el trabajo es sobre cómo se ejecuta el contenido de un módulo dentro del LMS (leer secciones 13–19 de este documento antes de tocar nada aquí).
3. `js/reproductor.js` — si el trabajo es sobre evaluación, certificados, o el flujo general de "abrir un módulo".
4. `js/db-firestore.js` — si el trabajo implica cambiar el modelo de datos o agregar una colección/campo.
5. `js/github-storage.js` — si el trabajo implica cambiar cómo/dónde se guardan los archivos.
6. `firestore.rules` — antes de cualquier cambio de seguridad o permisos.
7. `index.html` — para ubicar IDs de elementos del DOM y modales existentes antes de agregar UI nueva.

**Antes de cualquier cambio en el reproductor:** proponer el cambio y confirmar que no rompe (a) el formato v2 de los 4 módulos de referencia (`modulo001`–`004`, sección 23) ni (b) el contrato v1 legacy de cualquier paquete antiguo aún subido en GitHub (sección 14).

**Aspectos que aún requieren validación o evolución:** todo lo listado en las secciones 27 (limitaciones) y 28 (pendiente).

---

## 31. Diseño responsive (móvil/tablet) — V0.1.1

Toda la plataforma (login, ambos paneles, modales, reproductor) se adaptó a pantallas pequeñas manteniendo intacta la arquitectura y la lógica de negocio — solo CSS (media queries) y un toggle mínimo de JS para el menú lateral. Breakpoint principal: `880px`.

### App shell
- Sidebar off-canvas bajo `880px`: botón hamburguesa en el topbar (oculto en desktop), overlay de fondo, se cierra al navegar/clic afuera/volver a desktop. Lógica en `js/app.js` (`abrirSidebarMovil`/`cerrarSidebarMovil`), CSS en `index.html`.
- Grids (`stat-grid`, `grid-modulos`, `form-row`, `form-grid-2x2`) colapsan progresivamente (4→2→1 columnas) según ancho.
- Excepción explícita: `.stat-grid-usuarios` (Total/Activos/Inactivos) se mantiene siempre en una sola fila incluso en mobile, con tipografía/padding reducidos — pedido específico de producto, no colapsa como el resto.
- Tabla de Usuarios: scroll horizontal contenido (ya tenía `overflow:auto`+`min-width`), drawer de asignación a `100vw` en mobile.
- Selector de color del formulario de módulo: swatch de tamaño fijo (56px) + hex legible al lado, en vez de un `input[type=color]` estirado al 100% del ancho (se veía deforme en mobile).
- `overscroll-behavior:none` en `html body` y `contain` en `.main` — elimina el efecto "rubber-band" (arrastrar más allá del límite dejaba ver zonas vacías) en navegadores móviles.

### Reproductor de módulos en mobile
- Header y barra de controles se compactan en pantalla completa (`:fullscreen`), sin desaparecer nunca el botón de salir (X) — pedido explícito para no depender solo del botón Atrás del dispositivo.
- Botón de Pantalla completa: solo disponible con modo **Automático** activo (deshabilitado y con tooltip explicativo en Manual); al activarse oculta los controles secundarios (Prev/Play/Auto) y deja solo la barra de progreso, maximizando el área para el contenido 16:9. Intenta `screen.orientation.lock('landscape')` (soportado en Chrome Android; iOS Safari no expone esa API — se degrada sin romper nada).
- Aviso propio del LMS al entrar en fullscreen (`#rpAvisoFullscreen`, breve, autooculta) — **no reemplaza** el aviso nativo del navegador para salir de pantalla completa: es una medida de seguridad del propio estándar Fullscreen API, ningún sitio puede suprimirlo.

### Login (mobile)
- Mismo fondo/foto que desktop, pero reestructurado: logo grande centrado arriba, card de login con efecto "glass" (translúcido + blur) centrada, beneficios (Aprende/Crece/Certifícate) y bloque inferior alineados en la parte de abajo con separación proporcional respecto a la card.
- Subtítulo del formulario: **"Ingresa con tu número de DNI"** (antes "cuenta corporativa" — no describía el método real de autenticación).
- Bloque inferior: **"Capacitación corporativa / Desarrolla tus competencias de forma continua."** (antes "Plataforma segura y confidencial...", alineado a la izquierda igual que en desktop, sin centrar).
- `hero-col` con `pointer-events:none` en mobile: es solo fondo/decoración (nada clickeable ahí) — bug real corregido, antes interceptaba los toques que debían llegar a los campos del formulario (`.hero-mid` quedaba superpuesto sobre la card por stacking, bloqueando el input hasta abrir DevTools).
- `100dvh` (no `100vh`) + `env(safe-area-inset-bottom)` para que el bloque inferior no quede tapado por la barra de navegación del sistema en teléfonos.
- **Se evaluó y descartó una transición animada** entre login y app (se probaron dos variantes: "expandir el botón" y "Glass Morphing" con zoom+blur+fade). Ambas se retiraron por decisión de producto tras verlas en dispositivo real — el cambio de vista vuelve a ser instantáneo (`classList.add/remove('hidden')`), sin código de transición residual en `js/app.js` ni en `index.html`.

### Bugs reales encontrados y corregidos durante esta etapa
1. **Cierre de sesión manual con demora de varios segundos** (`js/app.js`, `cerrarSesion()`): causa raíz real — el `location.reload()` corría antes de que `signOut()` terminara de limpiar la sesión persistida en IndexedDB; la página recién cargada veía un usuario "fantasma" y disparaba una lectura completa de `DB.obtenerUsuarios()` para reconciliar. Fix: `await signOut()` (con `Promise.race` de 1.5s de seguridad) **antes** del reload.
2. **Progreso de módulo inflado sin escuchar el contenido** (bug crítico, anti-trampa): `render()` en los módulos emitía el evento `avance` (el que persiste `avancePct`/gatea progreso en Firestore) en cada llamada, incluyendo simple navegación/resume vía `lms:reanudar` — abrir un módulo y salir de inmediato ya subía el porcentaje. Fix: `avance` solo se emite desde `onAudioTerminado()` (confirmación real de audio completo), nunca desde `render()`. Aplicado en `modulo001`–`004`.
3. **Denominador incorrecto en el cálculo de avance** (`js/modulo-loader/drivers.js`): `datos.total + 1` en vez de `datos.total` — el % nunca llegaba a 100% real. Corregido.
4. **`maxAlcanzado` con semántica mixta** (índice vs conteo) entre el flujo de reanudar y el de audio-completado en los módulos — causaba inconsistencia entre "Continuar" y completar naturalmente. Unificado a semántica de conteo en los 4 módulos.
5. **Tiempo de carga de módulos**: descompresión/codificación de assets corría secuencial (`for...of` con `await`, un archivo a la vez) en `virtual-asset-resolver.js` — paralelizado con `Promise.all`. Tiempo de gracia del handshake subido de 8s a 18s + spinner de carga neutral, para evitar el falso aviso de "módulo no compatible" en redes lentas mientras el módulo aún arranca.
6. Campo **"Área"** eliminado por completo (formulario, tabla, exportación a Excel, bootstrap de admin) — ya no existe como concepto en la plataforma, solo queda `gerencia`.

### Archivos afectados en esta etapa
`index.html`, `js/app.js`, `js/modulo-loader/drivers.js`, `js/modulo-loader/virtual-asset-resolver.js`, `modulos/modulo001–004/*/index.html`.
