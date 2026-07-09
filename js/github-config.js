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
export const GITHUB_TOKEN = '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';

export function githubEstaConfigurado() {
  return ![GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN].some(v => v.startsWith('TU_'));
}
