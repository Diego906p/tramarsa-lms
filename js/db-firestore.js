/* ============================================================
   TRAMARSA LMS — Data-access-layer sobre Cloud Firestore.
   Reemplaza al antiguo getDB()/saveDB() síncrono sobre localStorage.
   Todas las funciones son async: cualquier código que las use debe
   estar dentro de una función async y usar await.
   ============================================================ */

import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db, firebaseEstaConfigurado } from './firebase-config.js';

function verificarFirestore() {
  if (!firebaseEstaConfigurado() || !db) {
    throw new Error('Firebase no está configurado todavía (js/firebase-config.js). La plataforma no puede leer ni guardar datos hasta que se complete la configuración.');
  }
  return db;
}

function idAsignacion(usuarioId, moduloId) { return `${usuarioId}_${moduloId}`; }
function idHistorial(usuarioId, moduloId) { return `${usuarioId}_${moduloId}`; }

async function obtenerColeccion(nombre) {
  const dbase = verificarFirestore();
  const snap = await getDocs(collection(dbase, nombre));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ---------------------------------------------------------------
// Usuarios — doc ID = DNI
// ---------------------------------------------------------------
export async function obtenerUsuarios() {
  return obtenerColeccion('usuarios');
}
export async function existeAlgunAdmin() {
  const dbase = verificarFirestore();
  const snap = await getDocs(query(collection(dbase, 'usuarios'), where('rol', '==', 'ADMIN')));
  return !snap.empty;
}
export async function obtenerUsuario(dni) {
  const dbase = verificarFirestore();
  const snap = await getDoc(doc(dbase, 'usuarios', dni));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export async function obtenerUsuarioPorUid(uid) {
  const dbase = verificarFirestore();
  const perfil = await getDoc(doc(dbase, 'perfiles', uid));
  if (!perfil.exists() || !perfil.data().dni) return null;
  return obtenerUsuario(perfil.data().dni);
}
export async function crearUsuario(dni, datos) {
  const dbase = verificarFirestore();
  const usuario = { ...datos, dni };
  const batch = writeBatch(dbase);
  batch.set(doc(dbase, 'usuarios', dni), usuario);
  if (datos.uid) batch.set(doc(dbase, 'perfiles', datos.uid), usuario);
  if (datos.uid && datos.rol === 'ADMIN') {
    batch.set(doc(dbase, 'administradores', datos.uid), {
      uid: datos.uid, correo: datos.correo, creadoEn: new Date().toISOString()
    });
  }
  await batch.commit();
  return { id: dni, ...datos, dni };
}
export async function registrarAdministrador(uid, correo) {
  const dbase = verificarFirestore();
  await setDoc(doc(dbase, 'administradores', uid), { uid, correo, creadoEn: new Date().toISOString() });
}
export async function actualizarUsuario(dni, datos) {
  const dbase = verificarFirestore();
  const actual = await getDoc(doc(dbase, 'usuarios', dni));
  if (!actual.exists()) throw new Error('El usuario no existe.');
  // El perfil privado solo resuelve UID -> DNI durante el inicio de sesión.
  // Mantenerlo inmutable evita que el trabajador requiera permiso para
  // modificar una segunda copia de su ficha al cambiar la contraseña.
  await updateDoc(doc(dbase, 'usuarios', dni), datos);
}
// Borra el documento del usuario y sus asignaciones/historial en Firestore.
// No puede borrar la cuenta de Firebase Auth de otra persona (requiere
// Admin SDK, fuera de alcance — misma limitación ya documentada para los
// archivos de GitHub al eliminar un módulo): queda huérfana en Auth.
export async function eliminarUsuario(dni) {
  const dbase = verificarFirestore();
  const usuario = await getDoc(doc(dbase, 'usuarios', dni));
  const [asignaciones, historial] = await Promise.all([obtenerAsignacionesUsuario(dni), obtenerHistorialUsuario(dni)]);
  const batch = writeBatch(dbase);
  batch.delete(doc(dbase, 'usuarios', dni));
  if (usuario.exists() && usuario.data().uid) batch.delete(doc(dbase, 'perfiles', usuario.data().uid));
  asignaciones.forEach(a => batch.delete(doc(dbase, 'asignaciones', a.id)));
  historial.forEach(h => batch.delete(doc(dbase, 'historial', h.id)));
  await batch.commit();
}

// ---------------------------------------------------------------
// Módulos — doc ID = moduloId (mismo esquema de ids que ya usaba la app)
// ---------------------------------------------------------------
export async function obtenerModulos() {
  return obtenerColeccion('modulos');
}
export async function obtenerModulo(moduloId) {
  const dbase = verificarFirestore();
  const snap = await getDoc(doc(dbase, 'modulos', moduloId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
// Número correlativo para el nombre del certificado ("...m3.pdf"). Se asigna
// una sola vez al crear el módulo y queda fijo en el documento: borrar un
// módulo intermedio no corre los números de los que ya existían.
export async function siguienteNumeroModulo() {
  const modulos = await obtenerModulos();
  const maximo = modulos.reduce((max, m) => Math.max(max, Number(m.numeroModulo) || 0), 0);
  return maximo + 1;
}
export async function crearModulo(moduloId, datos) {
  const dbase = verificarFirestore();
  await setDoc(doc(dbase, 'modulos', moduloId), datos);
  return { id: moduloId, ...datos };
}
export async function actualizarModulo(moduloId, datos) {
  const dbase = verificarFirestore();
  await updateDoc(doc(dbase, 'modulos', moduloId), datos);
}
export async function eliminarModulo(moduloId) {
  const dbase = verificarFirestore();
  await deleteDoc(doc(dbase, 'modulos', moduloId));
  // La eliminación es definitiva: evita asignaciones e historiales huérfanos.
  const [asignaciones, historial] = await Promise.all([
    obtenerAsignacionesDeModulo(moduloId),
    obtenerColeccion('historial').then(items => items.filter(h => h.moduloId === moduloId))
  ]);
  const batch = writeBatch(dbase);
  asignaciones.forEach(a => batch.delete(doc(dbase, 'asignaciones', a.id)));
  historial.forEach(h => batch.delete(doc(dbase, 'historial', h.id)));
  await batch.commit();
}

// ---------------------------------------------------------------
// Asignaciones — doc ID = `${usuarioId}_${moduloId}` (upsert directo)
// ---------------------------------------------------------------
export async function obtenerAsignaciones() {
  return obtenerColeccion('asignaciones');
}
export async function obtenerAsignacionesUsuario(usuarioId) {
  const dbase = verificarFirestore();
  const snap = await getDocs(query(collection(dbase, 'asignaciones'), where('usuarioId', '==', usuarioId)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function obtenerAsignacionesDeModulo(moduloId) {
  const dbase = verificarFirestore();
  const snap = await getDocs(query(collection(dbase, 'asignaciones'), where('moduloId', '==', moduloId)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function setAsignacion(usuarioId, moduloId, habilitado) {
  const dbase = verificarFirestore();
  await setDoc(doc(dbase, 'asignaciones', idAsignacion(usuarioId, moduloId)), { usuarioId, moduloId, habilitado });
}

// ---------------------------------------------------------------
// Historial — doc ID = `${usuarioId}_${moduloId}`: un solo registro por
// usuario+módulo (mismo criterio que ya evitaba el bug de duplicados
// en la versión local).
// ---------------------------------------------------------------
export async function obtenerHistorial() {
  return obtenerColeccion('historial');
}
export async function obtenerHistorialUsuario(usuarioId) {
  const dbase = verificarFirestore();
  const snap = await getDocs(query(collection(dbase, 'historial'), where('usuarioId', '==', usuarioId)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function obtenerHistorialRegistro(usuarioId, moduloId) {
  const dbase = verificarFirestore();
  const snap = await getDoc(doc(dbase, 'historial', idHistorial(usuarioId, moduloId)));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export async function crearHistorialSiNoExiste(usuarioId, moduloId, datosIniciales) {
  const existente = await obtenerHistorialRegistro(usuarioId, moduloId);
  if (existente) return existente;
  const dbase = verificarFirestore();
  const datos = { usuarioId, moduloId, ...datosIniciales };
  await setDoc(doc(dbase, 'historial', idHistorial(usuarioId, moduloId)), datos);
  return { id: idHistorial(usuarioId, moduloId), ...datos };
}
export async function actualizarHistorial(usuarioId, moduloId, datos) {
  const dbase = verificarFirestore();
  await setDoc(doc(dbase, 'historial', idHistorial(usuarioId, moduloId)), datos, { merge: true });
}

// ---------------------------------------------------------------
// Migración de un solo uso: sube lo que haya en localStorage
// (tramarsa_db_v2, versión anterior a Firebase) a Firestore.
// ---------------------------------------------------------------
export async function importarDatosLocalesAFirestore() {
  const dbase = verificarFirestore();
  const raw = localStorage.getItem('tramarsa_db_v2');
  if (!raw) throw new Error('No hay datos locales guardados en este navegador para importar.');
  const local = JSON.parse(raw);
  const batch = writeBatch(dbase);
  let contador = 0;

  (local.usuarios || []).forEach(u => {
    if (!u.dni) return;
    const { password, ...resto } = u; // la contraseña no se migra: vive en Firebase Auth
    batch.set(doc(dbase, 'usuarios', u.dni), resto);
    contador++;
  });
  (local.modulos || []).forEach(m => {
    if (!m.id) return;
    const { id, ...resto } = m;
    batch.set(doc(dbase, 'modulos', id), resto);
    contador++;
  });
  (local.asignaciones || []).forEach(a => {
    batch.set(doc(dbase, 'asignaciones', idAsignacion(a.usuarioId, a.moduloId)), a);
    contador++;
  });
  (local.historial || []).forEach(h => {
    batch.set(doc(dbase, 'historial', idHistorial(h.usuarioId, h.moduloId)), h);
    contador++;
  });

  await batch.commit();
  return { contador, avisoArchivos: 'Los archivos .zip/.rar/certificados guardados localmente NO se migran: vuelve a subirlos editando cada módulo para que se guarden en GitHub.' };
}
