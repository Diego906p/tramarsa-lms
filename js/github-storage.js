/* ============================================================
   TRAMARSA LMS — Subida de archivos al repositorio de GitHub
   dedicado a módulos (.zip/.rar) y certificados (.pdf).
   ------------------------------------------------------------
   Usa la Git Data API (blob → tree → commit → ref) en vez del
   endpoint simple de "contents", porque ese último no es confiable
   para archivos de varios MB (típico en módulos con audio/imágenes).
   Todo corre desde el navegador con el token de github-config.js.
   ============================================================ */

import { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, GITHUB_TOKEN, githubEstaConfigurado } from './github-config.js';

const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

function headersGithub() {
  return {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function llamarGithub(ruta, opciones = {}) {
  const resp = await fetch(`${API_BASE}${ruta}`, {
    ...opciones,
    headers: { ...headersGithub(), ...(opciones.headers || {}) }
  });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => '');
    throw new Error(`GitHub API ${resp.status} en ${ruta}: ${texto.slice(0, 300)}`);
  }
  return resp.json();
}

// Convierte un Blob/File a base64 en trozos, para no romper con
// String.fromCharCode.apply en archivos grandes (límite de argumentos).
async function blobABase64(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binario = '';
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binario += String.fromCharCode.apply(null, buffer.subarray(i, i + CHUNK));
  }
  return btoa(binario);
}

function sanearNombreArchivo(nombre) {
  return nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Sube uno o más archivos EN UN SOLO COMMIT (un tree con todos los blobs,
// un solo movimiento de rama). Antes se hacía un commit por archivo, y
// guardar un módulo sube 2 seguidos (el .zip/.rar y el certificado): la
// API de referencias de GitHub tiene lag de propagación real (no solo
// unos cientos de ms — se midió hasta varios segundos) entre el PATCH de
// un commit y que el siguiente GET de esa misma rama lo refleje, así que
// dos "subirArchivoAGithub" seguidos chocaban con "not a fast forward"
// incluso reintentando. Agrupar todo en un solo commit elimina la carrera
// de raíz en vez de tapiarla con reintentos.
export async function subirArchivosAGithub(entradas, mensajeCommit) {
  if (!githubEstaConfigurado()) {
    throw new Error('El repositorio de GitHub para módulos no está configurado todavía (js/github-config.js). Contacta al administrador de la plataforma.');
  }
  if (!entradas.length) return [];

  // Los blobs no dependen del estado de la rama: se suben en paralelo.
  const blobs = await Promise.all(entradas.map(async ({ file, carpeta }) => {
    const nombreArchivo = `${Date.now()}-${sanearNombreArchivo(file.name)}`;
    const ruta = `${carpeta}/${nombreArchivo}`.replace(/^\/+/, '');
    const contenidoBase64 = await blobABase64(file);
    const blob = await llamarGithub('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: contenidoBase64, encoding: 'base64' })
    });
    return { ruta, sha: blob.sha };
  }));

  // Mover la rama sí depende de su estado actual. Cada intento vuelve a
  // leer la rama y reconstruye árbol+commit desde ahí (nunca reutiliza
  // el commit/tree de un intento anterior) — pero aun así puede fallar
  // varias veces seguidas: la API de referencias de GitHub tiene lag de
  // propagación real (lectura justo después de una escritura puede
  // devolver el sha viejo), medido hasta varios segundos. Por eso son
  // más intentos con más margen de espera que un caso "choque entre 2
  // pestañas" típico necesitaría.
  // Subido de 8 a 12 intentos (y el tope de espera de 8s a 10s): el lag de
  // propagación de la API de referencias de GitHub rara vez pero a veces
  // supera el presupuesto anterior — con esto el usuario ya no necesita
  // volver a presionar "Guardar módulo" a mano en esos casos.
  const MAX_INTENTOS = 12;
  const ESPERA_MAXIMA_MS = 10000;
  let ultimoError = null;
  for (let intento = 0; intento < MAX_INTENTOS; intento++) {
    try {
      const ref = await llamarGithub(`/git/ref/heads/${GITHUB_BRANCH}`);
      const commitActualSha = ref.object.sha;
      const commitActual = await llamarGithub(`/git/commits/${commitActualSha}`);

      const nuevoTree = await llamarGithub('/git/trees', {
        method: 'POST',
        body: JSON.stringify({
          base_tree: commitActual.tree.sha,
          tree: blobs.map(b => ({ path: b.ruta, mode: '100644', type: 'blob', sha: b.sha }))
        })
      });

      const nuevoCommit = await llamarGithub('/git/commits', {
        method: 'POST',
        body: JSON.stringify({
          message: mensajeCommit || `Sube ${blobs.map(b => b.ruta).join(', ')}`,
          tree: nuevoTree.sha,
          parents: [commitActualSha]
        })
      });

      await llamarGithub(`/git/refs/heads/${GITHUB_BRANCH}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: nuevoCommit.sha })
      });

      return blobs.map(b => ({
        ruta: b.ruta,
        url: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${b.ruta}`
      }));
    } catch (e) {
      ultimoError = e;
      if (!/(not a fast forward|reference cannot be updated)/i.test(e.message)) throw e;
      const espera = Math.min(ESPERA_MAXIMA_MS, 500 * Math.pow(2, intento)) + Math.random() * 300;
      await new Promise(r => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}

// Atajo para un solo archivo (lo usa cualquier caller que solo suba uno).
export async function subirArchivoAGithub(archivo, carpeta, mensajeCommit) {
  const [resultado] = await subirArchivosAGithub([{ file: archivo, carpeta }], mensajeCommit);
  return resultado;
}
