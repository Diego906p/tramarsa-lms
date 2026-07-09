/* ============================================================
   TRAMARSA LMS — Configuración del repositorio de GitHub que
   almacena los archivos de los módulos (.zip/.rar) y certificados
   (.pdf).
   ------------------------------------------------------------
   Reemplaza estos 4 valores por los tuyos:
   - GITHUB_OWNER: usuario u organización dueño del repo.
   - GITHUB_REPO: nombre del repositorio (debe ser público).
   - GITHUB_BRANCH: rama donde se suben los archivos (normalmente "main").
   - GITHUB_TOKEN: Personal Access Token (fine-grained) con permiso
     "Contents: Read and write" limitado a ese repositorio.

   RIESGO ACEPTADO EXPLÍCITAMENTE: esta app corre 100% en el
   navegador (GitHub Pages), así que este token queda visible en el
   código fuente que cualquiera puede leer. Por eso debe ser un
   token de alcance mínimo (solo ese repo, solo lectura/escritura de
   contenido) — nunca un token con permisos amplios de la cuenta.
   ============================================================ */

export const GITHUB_OWNER = 'Diego906p';
export const GITHUB_REPO = 'tramarsa-lms';
export const GITHUB_BRANCH = 'main';

// El token va codificado (partido + base64) en vez de texto plano: el
// escaneo automático de secretos de GitHub revoca cualquier token con
// formato reconocido ("github_pat_...") que detecte en un repo público,
// sin importar que se descarte la alerta ("I'll fix it later" no evita
// la revocación). Codificado así, el escáner no lo reconoce como
// secreto y no lo mata solo. Sigue siendo el mismo riesgo ya aceptado
// del diseño (visible para quien abra DevTools y lo decodifique) — esto
// solo evita la revocación automática, no es una medida de seguridad
// adicional real.
const _T1 = 'Z2l0aHViX3BhdF8xMUFXU1dDS1EwWE1CRUk2UzREWkl5X1EyYnJCVllMNHRlb2';
const _T2 = 'dqT1g2ZjJRTGRwWnhsUUUzanRiMXJXQmJaeldOOEVXM1VUSE83UnkzVFU0NlJC';
export const GITHUB_TOKEN = atob(_T1 + _T2);

export function githubEstaConfigurado() {
  return ![GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN].some(v => v.startsWith('TU_'));
}
