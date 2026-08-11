/*
 * Puerta de archivos privados.
 *
 * GitHub nunca se llama desde el navegador: el Worker verifica el ID token
 * de Firebase y conserva el token de GitHub como secreto de servidor.
 */
import { auth } from './firebase-config.js';
import { WORKER_URL, workerEstaConfigurado } from './github-config.js';

async function tokenFirebase() {
  const user = auth && auth.currentUser;
  if (!user) throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');
  return user.getIdToken();
}

function baseWorker() {
  if (!workerEstaConfigurado()) {
    throw new Error('El gateway privado de archivos todavía no está configurado. Contacta al administrador.');
  }
  return WORKER_URL.replace(/\/+$/, '');
}

async function respuestaError(resp) {
  const cuerpo = await resp.text().catch(() => '');
  let mensaje = cuerpo;
  try { mensaje = JSON.parse(cuerpo).error || cuerpo; } catch (_) { /* texto plano */ }
  throw new Error(mensaje || `No se pudo completar la operación (${resp.status}).`);
}

function rutaSegura(carpeta, nombre) {
  const limpio = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${carpeta.replace(/^\/+|\/+$/g, '')}/${Date.now()}-${crypto.randomUUID()}-${limpio}`;
}

export async function subirArchivosAGithub(entradas, mensajeCommit) {
  if (!entradas.length) return [];
  const token = await tokenFirebase();
  const resultados = [];

  for (const { file, carpeta, tipo = 'archivo', moduloId = '' } of entradas) {
    const ruta = rutaSegura(carpeta, file.name);
    const resp = await fetch(`${baseWorker()}/v1/assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': file.type || 'application/octet-stream',
        'X-Tramarsa-Path': ruta,
        'X-Tramarsa-Kind': tipo,
        'X-Tramarsa-Module': moduloId,
        'X-Tramarsa-Message': mensajeCommit || 'Actualiza archivos del LMS'
      },
      body: file
    });
    if (!resp.ok) await respuestaError(resp);
    const data = await resp.json();
    resultados.push({ ruta: data.ruta || ruta, url: data.ruta || ruta }); // url se conserva por compatibilidad de esquema.
  }
  return resultados;
}

export async function subirArchivoAGithub(archivo, carpeta, mensajeCommit, opciones = {}) {
  const [resultado] = await subirArchivosAGithub([{ file: archivo, carpeta, ...opciones }], mensajeCommit);
  return resultado;
}

export async function descargarArchivoPrivado(ruta, nombre, { moduloId = '', usuarioId = '', tipo = 'archivo' } = {}) {
  // Compatibilidad de lectura para registros anteriores que aún contienen
  // una URL pública. Los registros nuevos almacenan una ruta privada.
  if (/^https?:\/\//i.test(ruta)) {
    const respPublica = await fetch(ruta);
    if (!respPublica.ok) throw new Error(`No se pudo descargar el archivo (${respPublica.status}).`);
    return new File([await respPublica.blob()], nombre || ruta.split('/').pop());
  }
  const token = await tokenFirebase();
  const query = new URLSearchParams({ ruta, moduloId, usuarioId, tipo });
  const resp = await fetch(`${baseWorker()}/v1/assets?${query}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) await respuestaError(resp);
  return new File([await resp.blob()], nombre || 'archivo');
}

export async function eliminarArchivoPrivado(ruta, { moduloId = '', tipo = 'archivo' } = {}) {
  if (!ruta || /^https?:\/\//i.test(ruta)) return; // referencia histórica sin gateway administrable
  const token = await tokenFirebase();
  const query = new URLSearchParams({ ruta, moduloId, tipo });
  const resp = await fetch(`${baseWorker()}/v1/assets?${query}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) await respuestaError(resp);
}
