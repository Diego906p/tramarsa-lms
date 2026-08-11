import { auth } from './firebase-config.js';
import { WORKER_URL, workerEstaConfigurado } from './github-config.js';

function baseWorker() {
  if (!workerEstaConfigurado()) throw new Error('El acceso por DNI todavía no está configurado. Usa tu correo para ingresar.');
  return WORKER_URL.replace(/\/+$/, '');
}
async function responderError(response) {
  let mensaje = '';
  try { mensaje = (await response.json()).error || ''; } catch (_) { /* respuesta vacía */ }
  throw new Error(mensaje || 'No se pudo validar el acceso.');
}

export async function resolverCorreoParaLogin(identificador, password) {
  const valor = identificador.trim();
  if (!/^\d{8}$/.test(valor)) throw new Error('Ingresa un DNI válido de 8 dígitos.');
  const response = await fetch(`${baseWorker()}/v1/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dni: valor, password })
  });
  if (!response.ok) await responderError(response);
  return (await response.json()).correo;
}

export async function solicitarRecuperacionPorDni(dni) {
  const valor = dni.trim();
  if (!/^\d{8}$/.test(valor)) throw new Error('Ingresa un DNI válido de 8 dígitos.');
  const response = await fetch(`${baseWorker()}/v1/password-reset`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dni: valor })
  });
  if (!response.ok) await responderError(response);
}

async function tokenAdmin() {
  if (!auth.currentUser) throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');
  return auth.currentUser.getIdToken();
}
export async function sincronizarAccesoDni(dni, correo) {
  const response = await fetch(`${baseWorker()}/v1/login-index`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenAdmin()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dni, correo })
  });
  if (!response.ok) await responderError(response);
}
export async function eliminarAccesoDni(dni) {
  const response = await fetch(`${baseWorker()}/v1/login-index?${new URLSearchParams({ dni })}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${await tokenAdmin()}` }
  });
  if (!response.ok) await responderError(response);
}
