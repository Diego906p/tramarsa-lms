# TRAMARSA LMS — Plataforma de Gestión de Capacitaciones e Inducciones

**Versión definitiva del MVP** — sin servidor, corre abriendo `index.html` en Chrome o Edge.

---

## 1. Qué es esta versión

Una plataforma de capacitaciones corporativas que corre **100% en el navegador**, sin necesidad de instalar Node.js, npm, ni levantar un servidor. Se abre con doble clic sobre `index.html`.

Diferencia clave frente a la primera versión (backend Node/Express): esa arquitectura quedó descartada por complejidad de instalación para el uso real que se necesitaba. Esta versión logra el mismo objetivo funcional usando únicamente el navegador como motor.

---

## 2. Estructura de archivos

```
tramarsa-v2/
├── index.html                       # estructura y estilos de toda la plataforma
├── js/
│   ├── app.js                       # datos, autenticación, admin (usuarios/módulos/asignaciones)
│   └── reproductor.js               # motor que reproduce el contenido de un módulo
├── data/
│   └── data.json                    # base de datos (usuarios, módulos, asignaciones, historial)
└── modulo-ejemplo-para-probar.zip   # módulo de muestra para probar el reproductor de inmediato
```

---

## 3. Cómo se guardan los datos

- **localStorage** del navegador: respaldo inmediato, siempre activo, no requiere configuración.
- **`data/data.json`** (guardado automático real): usando la *File System Access API* de Chrome/Edge, el administrador conecta la carpeta `data` del proyecto una sola vez (botón **"Conectar carpeta"** en el panel admin) y desde ese momento cada cambio (crear usuario, subir módulo, habilitar capacitación, completar evaluación) se escribe automáticamente en ese archivo. Al subir el proyecto a un repositorio, ese `data.json` ya actualizado sube con el resto del código.
- Los **archivos .zip/.rar de los módulos** se guardan en **IndexedDB** (no en `data.json`, porque pueden pesar demasiado para un archivo de texto).

**Limitación conocida:** la conexión automática de carpeta solo funciona en Chrome/Edge. En otros navegadores, la plataforma sigue funcionando con localStorage, pero sin guardado automático en disco.

---

## 4. Roles y acceso

| Rol | Accede a |
|---|---|
| **Administrador** | Gestión de Capacitaciones (módulos) y Usuarios (trabajadores) |
| **Trabajador** | Su propio panel: solo ve los módulos que el admin le habilitó |

**Cuentas de prueba incluidas:**

| Rol | Correo | Contraseña |
|---|---|---|
| Administrador | `admin@tramarsa.com.pe` | `Admin2026*` |
| Trabajador | `juan.perez@tramarsa.com.pe` | `12345678` |

---

## 5. Funcionalidades del panel Administrador

### Capacitaciones (Módulos)
- Crear módulo: nombre, descripción, categoría, y **subida real del archivo .zip/.rar** (se guarda de verdad en el navegador, no es una simulación).
- Activar / inactivar / eliminar módulo.
- **Asignar por Área o Sede**: habilita un módulo de forma masiva a todos los trabajadores que compartan esa Área o Sede, en un solo clic.

### Usuarios
- Tabla con: nombre completo, correo, DNI, sede, área, **contraseña visible** (con botón de mostrar/ocultar), estado y acciones.
- Crear / editar trabajador (contraseña por defecto = DNI, tal como se definió desde el inicio).
- Activar / inactivar trabajador.
- **Habilitar/deshabilitar módulos por usuario individual** (ícono de libro en cada fila → modal con un switch por cada módulo existente).
- **Importar Excel** con las columnas: `Primer Nombre, Segundo Nombre, Apellido Paterno, Apellido Materno, Sede, Área, DNI, Contraseña, Estado` (+ `Correo` opcional; si no se incluye, se genera automáticamente). Lógica *upsert*: si el DNI ya existe, actualiza; si no, crea.
- **Exportar base de datos** completa de trabajadores a un archivo Excel descargable.

---

## 6. El reproductor de módulos (para el Trabajador)

Cuando el trabajador tiene un módulo habilitado, puede darle **"Continuar"**. Ahí ocurre lo siguiente, en orden:

1. **Contenido**: se lee el `.zip` del módulo y se muestra su contenido (HTML autocontenido, o imágenes/audio/video en secuencia). El botón para avanzar permanece deshabilitado un tiempo mínimo — no se puede saltar el contenido.
2. **Evaluación**: si el módulo trae un banco de preguntas, se seleccionan aleatoriamente algunas de ellas, en orden aleatorio, con las alternativas también mezcladas. Una pregunta a la vez, sin poder retroceder, con temporizador (30 segundos por pregunta).
3. **Resultado**:
   - Si aprueba (≥70%): se marca el módulo como **completado** en el historial real, y si el módulo trae plantilla de certificado, se genera el certificado con el nombre del trabajador superpuesto y un botón de descarga.
   - Si desaprueba: puede reintentar con un set de preguntas distinto.

### Contrato del archivo .zip que debe subir el administrador

```
modulo.zip
├── manifest.json            # metadatos del módulo (opcional)
├── content/
│   ├── index.html            # contenido autocontenido (opcional)
│   └── assets/                # imágenes/recursos que use ese index.html
│       └── ...
│   (o, en su lugar, imágenes/video/audio sueltos directamente en content/)
├── questions.json            # banco de preguntas (opcional)
└── certificate/
    ├── template.png           # plantilla base del certificado (opcional)
    └── layout.json             # coordenadas donde se inserta el nombre/fecha
```

Ejemplo de `questions.json`:
```json
[
  {
    "enunciado": "¿Qué debes hacer antes de operar maquinaria pesada?",
    "alternativas": [
      { "texto": "Verificar el equipo de protección personal", "esCorrecta": true },
      { "texto": "Ignorar las señales de seguridad", "esCorrecta": false }
    ]
  }
]
```

Ejemplo de `certificate/layout.json`:
```json
{ "x": 450, "y": 300, "fontSize": 40, "color": "#061E4E", "align": "center", "fontFamily": "Arial" }
```

El archivo `modulo-ejemplo-para-probar.zip` incluido en el proyecto ya trae esta estructura completa y sirve para probar el flujo de punta a punta sin tener que armar contenido propio primero.

---

## 7. Qué NO incluye esta versión (pendiente, no oculto)

- El **dashboard visual del administrador** (gráficos, indicadores tipo dona, tablas de actividad reciente) — hoy el admin entra directo a Capacitaciones.
- **Encuestas de satisfacción** al finalizar el módulo.
- **Reportes filtrables y exportables** desde el panel admin.
- **Recuperación de contraseña por correo** y login con Microsoft (SSO).
- Sincronización entre distintos equipos/navegadores en tiempo real: cada navegador tiene su propia copia hasta que se sincroniza manualmente vía `data.json` conectado a la misma carpeta (por ejemplo, a través del repositorio Git).
- Los certificados generados se descargan al dispositivo del trabajador, pero no quedan archivados centralmente más allá del registro de historial (estado + puntaje).

---

## 8. Resumen de decisiones técnicas clave

| Decisión | Motivo |
|---|---|
| Sin servidor (Node/Express descartado) | Simplicidad de uso: un solo doble clic, sin instalación |
| localStorage + IndexedDB como base de datos | Persisten datos y archivos pesados sin backend |
| File System Access API para `data.json` | Es la única forma de que un HTML sin servidor escriba en disco automáticamente; funciona en Chrome/Edge |
| JSZip para leer los módulos | Permite abrir el `.zip` del módulo directamente en el navegador, sin descomprimir en servidor |
| Certificado generado con `<canvas>` | Permite superponer el nombre sobre la plantilla sin necesidad de un backend de generación de PDFs |
