/* ============================================================
   TRAMARSA LMS — Lógica de la aplicación
   Arquitectura Firebase: Cloud Firestore (usuarios, módulos,
   asignaciones, historial) + Firebase Authentication (login) +
   repositorio de GitHub (archivos .zip/.rar/.pdf de los módulos).
   No hay más data.json, localStorage como base de datos, ni
   "Conectar carpeta". localStorage solo se usa para cachear la
   sesión visible del navegador (ver getSesion/setSesion) — nunca
   como fuente de verdad del negocio.
   ============================================================ */

import { auth, firebaseEstaConfigurado } from './firebase-config.js';
import {
  signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, onAuthStateChanged,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import * as DB from './db-firestore.js';
import { crearCuentaAuthParaUsuario } from './firebase-secondary.js';
import { subirArchivosAGithub } from './github-storage.js';
import { archivoAJSZip, carpetaArrastradaAJSZip, jszipAArchivoZip } from './modulo-loader/package-adapters.js';
import { descargarCertificadoAdmin } from './reproductor.js';

export function nombreCompleto(u) {
  return [u.primerNombre, u.segundoNombre, u.apellidoPaterno, u.apellidoMaterno].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------
// Feedback global de operaciones lentas: loader con mensaje de la
// acción en curso + toasts de éxito/error. Usado por toda operación
// perceptible (guardar módulo, crear/editar usuario, asignar, importar
// Excel, generar certificado...) para que nunca parezca que la app se
// quedó bloqueada.
// ---------------------------------------------------------------
export function mostrarCargando(mensaje) {
  document.getElementById('loaderGlobalMensaje').textContent = mensaje || 'Procesando...';
  document.getElementById('loaderGlobal').classList.remove('hidden');
  lucide.createIcons();
}
function actualizarCargando(mensaje) {
  const el = document.getElementById('loaderGlobalMensaje');
  if (el) el.textContent = mensaje;
}
export function ocultarCargando() {
  document.getElementById('loaderGlobal').classList.add('hidden');
}
export function toast(tipo, mensaje, duracionMs = 4000) {
  const cont = document.getElementById('toastContainer');
  const icono = tipo === 'exito' ? 'check-circle-2' : tipo === 'error' ? 'alert-triangle' : 'info';
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.innerHTML = `<i data-lucide="${icono}" size="18"></i><span>${mensaje}</span>`;
  cont.appendChild(el);
  lucide.createIcons();
  setTimeout(() => el.remove(), duracionMs);
}
// Envuelve una operación async: muestra el loader con `mensaje`, la
// ejecuta, y al terminar muestra un toast de éxito o error. Devuelve lo
// que devuelva `fn`, o relanza el error tras avisar (para que el
// llamador siga manejando su propio catch si lo necesita).
async function conFeedback(mensaje, fn, { exito, error } = {}) {
  mostrarCargando(mensaje);
  try {
    const resultado = await fn();
    ocultarCargando();
    if (exito) toast('exito', exito);
    return resultado;
  } catch (e) {
    ocultarCargando();
    toast('error', error || e.message || 'Ocurrió un error inesperado.');
    throw e;
  }
}

function mostrarErrorFirebaseNoConfigurado() {
  document.getElementById('viewLogin').innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px;background:var(--gray-50);">
      <div style="max-width:520px;background:white;border-radius:16px;padding:32px;box-shadow:var(--shadow-md);text-align:center;">
        <i data-lucide="alert-triangle" size="36" style="color:var(--orange-500);"></i>
        <h2 style="margin-top:14px;color:var(--navy-900);font-size:1.2rem;font-weight:800;">Firebase no está configurado</h2>
        <p style="margin-top:8px;color:var(--gray-500);font-size:.88rem;">
          Falta completar <code>js/firebase-config.js</code> (y opcionalmente <code>js/github-config.js</code>) con los datos reales del proyecto antes de poder usar la plataforma.
        </p>
      </div>
    </div>`;
  lucide.createIcons();
}

// ---------------------------------------------------------------
// Parser de preguntas: .txt/.docx con el formato "1. pregunta" /
// "a. alternativa" / "c. alternativa (correcta)", o .json ya armado.
// ---------------------------------------------------------------
function parsearPreguntasDesdeTexto(texto) {
  const QUESTION_RE = /^\s*\d+[.)]\s*(.+)$/;
  const OPTION_RE = /^\s*[a-dA-D][.)]\s*(.+)$/;
  const lineas = texto.split(/\r?\n/);
  const preguntas = [];
  let actual = null;
  let ultimaAlternativa = null;

  for (const raw of lineas) {
    const linea = raw.trim();
    if (!linea) continue;
    const mQ = linea.match(QUESTION_RE);
    const mO = !mQ ? linea.match(OPTION_RE) : null;
    if (mQ) {
      actual = { enunciado: mQ[1].trim(), alternativas: [] };
      preguntas.push(actual);
      ultimaAlternativa = null;
    } else if (mO && actual) {
      let textoAlt = mO[1].trim();
      const esCorrecta = /\(correcta\)\s*$/i.test(textoAlt);
      if (esCorrecta) textoAlt = textoAlt.replace(/\(correcta\)\s*$/i, '').trim();
      ultimaAlternativa = { texto: textoAlt, esCorrecta };
      actual.alternativas.push(ultimaAlternativa);
    } else if (actual) {
      if (ultimaAlternativa) ultimaAlternativa.texto += ' ' + linea;
      else actual.enunciado += ' ' + linea;
    }
  }
  return preguntas.filter(p => p.alternativas.length >= 2 && p.alternativas.some(a => a.esCorrecta));
}

function decodificarEntidadesHtml(texto) {
  const ta = document.createElement('textarea');
  ta.innerHTML = texto;
  return ta.value;
}

async function extraerTextoDocx(file) {
  const zip = await JSZip.loadAsync(file);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('El .docx no tiene el formato esperado.');
  const xml = await entry.async('text');
  const conSaltos = xml.replace(/<\/w:p>/g, '\n').replace(/<w:br\s*\/>/g, '\n').replace(/<w:tab\s*\/>/g, ' ');
  const sinEtiquetas = conSaltos.replace(/<[^>]+>/g, '');
  return decodificarEntidadesHtml(sinEtiquetas);
}

async function parsearArchivoPreguntas(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'json') {
    const texto = await file.text();
    const data = JSON.parse(texto);
    if (!Array.isArray(data)) throw new Error('El JSON debe ser un arreglo de preguntas.');
    return data;
  }
  if (ext === 'docx') return parsearPreguntasDesdeTexto(await extraerTextoDocx(file));
  if (ext === 'txt') return parsearPreguntasDesdeTexto(await file.text());
  throw new Error('Formato de preguntas no soportado. Usa .txt, .docx o .json.');
}

// ---------------------------------------------------------------
// Sesión — cache de solo lectura del usuario ya autenticado, para no
// releer Firestore en cada render. La fuente de verdad sigue siendo
// Firestore + Firebase Auth; esto es una preferencia de navegador, no
// el almacenamiento del negocio.
// ---------------------------------------------------------------
export function getSesion() {
  const raw = sessionStorage.getItem('tramarsa_sesion');
  return raw ? JSON.parse(raw) : null;
}
export function setSesion(usuario) { sessionStorage.setItem('tramarsa_sesion', JSON.stringify(usuario)); }
async function cerrarSesion() {
  // Desactivar el control de inactividad ANTES de cualquier operación
  // async: el propio clic en "Cerrar sesión" burbujea hasta el listener
  // global de document (reiniciarTemporizadorInactividad) y, sin este
  // guard, rearmaba un temporizador nuevo de 5 min mientras el logout
  // seguía en curso — causaba un cierre de sesión "fantasma" más tarde
  // y la sensación de que el botón manual "no funcionaba".
  controlInactividadActivo = false;
  limpiarTemporizadoresInactividad();
  document.getElementById('modalInactividadOverlay').classList.remove('show');
  sessionStorage.removeItem('tramarsa_sesion');
  sessionStorage.removeItem('tramarsa_ruta');
  sessionStorage.removeItem('tramarsa_scroll');
  // signOut(auth) es una llamada de red (revoca el token en el servidor de
  // Firebase) — puede tardar varios segundos según la conexión. El cierre
  // visible NO debe depender de eso: la sesión de la app ya terminó en
  // cuanto se limpia sessionStorage arriba, así que el signOut real corre
  // en segundo plano (fire-and-forget) y el reload es inmediato. Bug real
  // corregido: antes el "await" bloqueaba el botón "Cerrar sesión" hasta
  // que esa llamada de red resolviera, dando la sensación de que no
  // respondía (varios segundos de espera, dependiente de la red, no del
  // estado del temporizador de inactividad).
  // Esperar signOut (operación LOCAL de Firebase Auth, normalmente casi
  // instantánea) ANTES de recargar. Bug real encontrado al reinvestigar
  // este mismo síntoma: si no se espera, el reload puede llegar antes de
  // que Firebase termine de borrar la sesión persistida en IndexedDB —
  // en la página recién cargada, onAuthStateChanged ve un usuario
  // "fantasma" todavía autenticado y dispara una lectura COMPLETA de
  // Firestore (DB.obtenerUsuarios(), en el arranque de la app) para
  // intentar reconciliar la sesión, lo cual toma varios segundos — eso
  // era el retraso, no signOut() en sí. Con Promise.race como límite de
  // seguridad: si signOut() tardara anormalmente (red caída, etc.), no
  // bloquea para siempre.
  await Promise.race([
    signOut(auth).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 1500))
  ]);
  location.reload();
}

// ---------------------------------------------------------------
// Cierre automático de sesión por inactividad (5 min). Solo cuentan como
// actividad los clics/toques del mouse y las pulsaciones de teclado —
// mousemove/scroll NO reinician el contador (no garantizan que el usuario
// siga usando la plataforma de verdad, a diferencia de un clic o una
// tecla). Aviso 30s antes del cierre, con opción de seguir trabajando.
// ---------------------------------------------------------------
const TIEMPO_INACTIVIDAD_MS = 5 * 60 * 1000;
const TIEMPO_AVISO_ANTES_MS = 30 * 1000;
let timeoutAvisoInactividad = null;
let timeoutCierreInactividad = null;
let intervalCuentaRegresivaInactividad = null;
let controlInactividadActivo = false;

function limpiarTemporizadoresInactividad() {
  clearTimeout(timeoutAvisoInactividad);
  clearTimeout(timeoutCierreInactividad);
  clearInterval(intervalCuentaRegresivaInactividad);
}

function mostrarAvisoInactividad() {
  let restantes = TIEMPO_AVISO_ANTES_MS / 1000;
  const span = document.getElementById('segundosRestantesInactividad');
  if (span) span.textContent = restantes;
  document.getElementById('modalInactividadOverlay').classList.add('show');
  intervalCuentaRegresivaInactividad = setInterval(() => {
    restantes--;
    if (span) span.textContent = Math.max(0, restantes);
    if (restantes <= 0) clearInterval(intervalCuentaRegresivaInactividad);
  }, 1000);
}

// Se llama tanto al detectar actividad real (clic/tecla) como al abrir
// sesión — reinicia el reloj desde cero y oculta el aviso si estaba abierto
// (cualquier clic, incluido el de "Continuar trabajando", cuenta como
// actividad real).
function reiniciarTemporizadorInactividad() {
  if (!controlInactividadActivo) return;
  limpiarTemporizadoresInactividad();
  document.getElementById('modalInactividadOverlay').classList.remove('show');
  timeoutAvisoInactividad = setTimeout(mostrarAvisoInactividad, TIEMPO_INACTIVIDAD_MS - TIEMPO_AVISO_ANTES_MS);
  timeoutCierreInactividad = setTimeout(async () => {
    document.getElementById('modalInactividadOverlay').classList.remove('show');
    await cerrarSesion();
  }, TIEMPO_INACTIVIDAD_MS);
}

function iniciarControlInactividad() {
  if (controlInactividadActivo) return; // ya activo (ej. re-entrada por login sin recargar)
  controlInactividadActivo = true;
  document.addEventListener('click', reiniciarTemporizadorInactividad);
  document.addEventListener('keydown', reiniciarTemporizadorInactividad);
  reiniciarTemporizadorInactividad();
}

document.getElementById('btnContinuarTrabajando').addEventListener('click', () => {
  reiniciarTemporizadorInactividad();
});
document.getElementById('btnCerrarSesionInactividad').addEventListener('click', async () => {
  limpiarTemporizadoresInactividad();
  await cerrarSesion();
});

// ---------------------------------------------------------------
// Restauración de estado tras refrescar (cualquier método: F5, Ctrl+F5,
// botón recargar, Enter en la barra...). Cada render de sección guarda
// su nombre; al arrancar con sesión válida se vuelve a esa misma sección
// y a la misma posición de scroll, sin pasar por el login.
// ---------------------------------------------------------------
function marcarRuta(nombre) {
  try { sessionStorage.setItem('tramarsa_ruta', nombre); } catch (e) {}
}
function elementoScroll() {
  // el contenedor que realmente scrollea: .main si existe, si no la ventana
  return document.querySelector('.main') || document.scrollingElement;
}
window.addEventListener('beforeunload', () => {
  try {
    const el = elementoScroll();
    sessionStorage.setItem('tramarsa_scroll', String(el ? el.scrollTop : 0));
  } catch (e) {}
});
function restaurarScroll() {
  const guardado = parseInt(sessionStorage.getItem('tramarsa_scroll') || '0', 10);
  if (!guardado) return;
  sessionStorage.removeItem('tramarsa_scroll');
  requestAnimationFrame(() => {
    const el = elementoScroll();
    if (el) el.scrollTop = guardado;
  });
}

// ---------------------------------------------------------------
// Sidebar off-canvas (mobile/tablet ≤880px). En desktop la clase
// 'abierta' nunca se agrega ni tiene efecto (fuera del media query).
// ---------------------------------------------------------------
function cerrarSidebarMovil() {
  document.getElementById('sidebar').classList.remove('abierta');
  document.getElementById('sidebarOverlay').classList.remove('show');
}
function abrirSidebarMovil() {
  document.getElementById('sidebar').classList.add('abierta');
  document.getElementById('sidebarOverlay').classList.add('show');
}
document.getElementById('btnAbrirSidebar').addEventListener('click', abrirSidebarMovil);
document.getElementById('sidebarOverlay').addEventListener('click', cerrarSidebarMovil);
// Cualquier clic dentro del sidebar (navegar o cerrar sesión) lo cierra
// en mobile — en desktop no tiene efecto visual (ya está siempre visible).
document.getElementById('sidebar').addEventListener('click', (e) => {
  if (e.target.closest('.nav-item, .logout-item')) cerrarSidebarMovil();
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 880) cerrarSidebarMovil();
});

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------
document.getElementById('togglePass').addEventListener('click', () => {
  const input = document.getElementById('loginPassword');
  const btn = document.getElementById('togglePass');
  const oculto = input.type === 'password';
  input.type = oculto ? 'text' : 'password';
  btn.innerHTML = oculto ? '<i data-lucide="eye" size="17"></i>' : '<i data-lucide="eye-off" size="17"></i>';
  lucide.createIcons();
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dni = document.getElementById('loginDni').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorBox = document.getElementById('errorMsg');
  const errorText = document.getElementById('errorText');
  errorBox.classList.remove('show');

  try {
    const usuario = await DB.obtenerUsuario(dni);
    if (!usuario || !usuario.correo) throw { code: 'auth/user-not-found' };
    await signInWithEmailAndPassword(auth, usuario.correo, password);
    if (usuario.estado !== 'ACTIVO') {
      await signOut(auth);
      errorText.textContent = 'Tu cuenta está inactiva. Contacta al administrador.';
      errorBox.classList.add('show');
      return;
    }
    setSesion(usuario);
    await iniciarApp();
  } catch (err) {
    console.error('Login:', err);
    const credencialesInvalidas = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(err.code);
    errorText.textContent = credencialesInvalidas ? 'DNI o contraseña incorrectos.' : (err.message || 'No se pudo iniciar sesión.');
    errorBox.classList.add('show');
  }
});

// ---------------------------------------------------------------
// Arranque de la app tras login
// ---------------------------------------------------------------
async function iniciarApp() {
  const usuario = getSesion();
  if (!usuario) return;

  document.getElementById('viewLogin').classList.add('hidden');
  // Transición suave de entrada (fade), no un cambio brusco de pantalla —
  // puramente visual, no toca la lógica de autenticación de ningún modo.
  const appEl = document.getElementById('viewApp');
  appEl.classList.remove('hidden');
  appEl.classList.add('fade-in');
  requestAnimationFrame(() => requestAnimationFrame(() => appEl.classList.remove('fade-in')));
  iniciarControlInactividad();

  document.getElementById('nombreUsuario').textContent = nombreCompleto(usuario);
  document.getElementById('correoUsuario').textContent = usuario.correo;
  const avatar = document.getElementById('avatarIniciales');
  if (usuario.fotoUrl) {
    avatar.textContent = '';
    avatar.style.backgroundImage = `url('${usuario.fotoUrl}')`;
    avatar.style.backgroundSize = 'cover';
  } else {
    avatar.textContent = (usuario.primerNombre[0] + usuario.apellidoPaterno[0]).toUpperCase();
    avatar.style.backgroundImage = '';
  }

  // Restaura la sección exacta donde estaba el usuario antes de refrescar
  // (guardada por marcarRuta en cada render de sidebar).
  const ruta = sessionStorage.getItem('tramarsa_ruta');
  const rutasAdmin = {
    capacitaciones: renderCapacitaciones, usuarios: renderUsuarios,
    configuracion: renderConfiguracion
  };
  const rutasTrabajador = {
    inicio: renderDashboardTrabajador, modulos: renderMisModulosTrabajador,
    certificados: renderCertificadosTrabajador, perfil: renderPerfilTrabajador
  };
  const mapa = usuario.rol === 'ADMIN' ? rutasAdmin : rutasTrabajador;
  const renderRuta = mapa[ruta] || (usuario.rol === 'ADMIN' ? renderCapacitaciones : renderDashboardTrabajador);
  await renderRuta();
  restaurarScroll();
  lucide.createIcons();
  verificarCambioPasswordObligatorio();
}

// ---------------------------------------------------------------
// Cambio de contraseña obligatorio en el primer ingreso (contraseña
// por defecto = DNI). No tiene botón de cerrar: hay que completarlo
// para poder seguir usando la plataforma.
// ---------------------------------------------------------------
function verificarCambioPasswordObligatorio() {
  const usuario = getSesion();
  if (!usuario || !usuario.debeCambiarPassword) return;
  document.getElementById('formErrorCambioObligatorio').classList.remove('show');
  document.getElementById('formCambioObligatorio').reset();
  document.getElementById('modalCambioObligatorioOverlay').classList.add('show');
}

document.getElementById('formCambioObligatorio').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nueva = document.getElementById('cNueva').value;
  const confirmar = document.getElementById('cConfirmar').value;
  const errorBox = document.getElementById('formErrorCambioObligatorio');
  errorBox.classList.remove('show');

  const usuario = getSesion();
  if (nueva.length < 4) { errorBox.textContent = 'La contraseña debe tener al menos 4 caracteres.'; errorBox.classList.add('show'); return; }
  if (nueva === usuario.dni) { errorBox.textContent = 'La nueva contraseña no puede ser igual a tu DNI.'; errorBox.classList.add('show'); return; }
  if (nueva !== confirmar) { errorBox.textContent = 'Las contraseñas no coinciden.'; errorBox.classList.add('show'); return; }

  try {
    const credencial = EmailAuthProvider.credential(usuario.correo, usuario.dni);
    await reauthenticateWithCredential(auth.currentUser, credencial);
    await updatePassword(auth.currentUser, nueva);
    await DB.actualizarUsuario(usuario.dni, { debeCambiarPassword: false });
    usuario.debeCambiarPassword = false;
    setSesion(usuario);
    document.getElementById('modalCambioObligatorioOverlay').classList.remove('show');
  } catch (err) {
    console.error('Cambio de contraseña obligatorio:', err);
    errorBox.textContent = 'No se pudo actualizar la contraseña. Intenta de nuevo.';
    errorBox.classList.add('show');
  }
});

// ---------------------------------------------------------------
// Recuperar contraseña: enlace nativo de Firebase Auth al correo real
// del usuario (ya no se guarda ni se envía la contraseña en texto
// plano por ningún medio).
// ---------------------------------------------------------------
document.getElementById('btnOlvidoPassword').addEventListener('click', () => {
  document.getElementById('rDni').value = '';
  document.getElementById('formErrorRecuperar').classList.remove('show');
  document.getElementById('formSuccessRecuperar').classList.remove('show');
  document.getElementById('modalRecuperarOverlay').classList.add('show');
});
document.getElementById('btnCancelarRecuperar').addEventListener('click', () => document.getElementById('modalRecuperarOverlay').classList.remove('show'));

document.getElementById('btnEnviarRecuperar').addEventListener('click', async () => {
  const dni = document.getElementById('rDni').value.trim();
  const errorBox = document.getElementById('formErrorRecuperar');
  const successBox = document.getElementById('formSuccessRecuperar');
  errorBox.classList.remove('show'); successBox.classList.remove('show');

  try {
    const usuario = await DB.obtenerUsuario(dni);
    if (!usuario) { errorBox.textContent = 'No se encontró un usuario con ese DNI.'; errorBox.classList.add('show'); return; }
    if (!usuario.correo) { errorBox.textContent = 'Este usuario no tiene un correo registrado.'; errorBox.classList.add('show'); return; }
    await sendPasswordResetEmail(auth, usuario.correo);
    successBox.textContent = `Se envió un enlace para restablecer tu contraseña a ${usuario.correo}.`;
    successBox.classList.add('show');
  } catch (err) {
    console.error('Restablecer contraseña:', err);
    errorBox.textContent = 'No se pudo enviar el enlace. Intenta más tarde o contacta al administrador.';
    errorBox.classList.add('show');
  }
});

function logoDeSidebar() {
  return `
    <div class="logo">
      <div class="flag-icon"><img src="https://raw.githubusercontent.com/Diego906p/imagenes/refs/heads/main/images/logo_tram_white.png" alt="Grupo Tramarsa"></div>
    </div>`;
}

// ---------------------------------------------------------------
// TRABAJADOR
// ---------------------------------------------------------------
function renderSidebarTrabajador(activo) {
  marcarRuta(activo);
  const items = [
    { key:'inicio', label:'Inicio', icon:'home', fn:'renderDashboardTrabajador' },
    { key:'modulos', label:'Mis módulos', icon:'book-open', fn:'renderMisModulosTrabajador' },
    { key:'certificados', label:'Certificados', icon:'award', fn:'renderCertificadosTrabajador' },
    { key:'perfil', label:'Perfil', icon:'user', fn:'renderPerfilTrabajador' }
  ];
  document.getElementById('sidebar').innerHTML = `
    ${logoDeSidebar()}
    <span class="role-tag">Panel del trabajador</span>
    <nav class="nav-group">
      ${items.map(it => `<a class="nav-item ${it.key===activo?'active':''}" onclick="${it.fn}()"><i data-lucide="${it.icon}" size="17"></i> ${it.label}</a>`).join('')}
    </nav>
    <a class="logout-item" onclick="cerrarSesion()"><i data-lucide="log-out" size="17"></i> Cerrar sesión</a>
  `;
  lucide.createIcons();
}

// Reúne, en un solo lugar, el cruce módulos habilitados + historial del
// trabajador. Lo usan Inicio, Mis módulos, Certificados y Mi progreso.
async function datosCapacitacionesTrabajador() {
  const usuario = getSesion();
  const [asignacionesUsuario, historialUsuario] = await Promise.all([
    DB.obtenerAsignacionesUsuario(usuario.dni),
    DB.obtenerHistorialUsuario(usuario.dni)
  ]);

  const modulos = await Promise.all(
    asignacionesUsuario.filter(a => a.habilitado).map(a => DB.obtenerModulo(a.moduloId))
  );
  const modulosHabilitados = modulos.filter(m => m && m.estado === 'ACTIVO');

  const historialPorModulo = new Map(historialUsuario.map(h => [h.moduloId, h]));
  const items = modulosHabilitados.map(m => {
    const hist = historialPorModulo.get(m.id) || null;
    const estado = hist ? hist.estado : 'PENDIENTE';
    const avance = estado === 'COMPLETADO' ? 100 : (hist ? (hist.avancePct || 0) : 0);
    return { modulo: m, hist, estado, avance };
  });

  return {
    usuario, items,
    completados: items.filter(i => i.estado === 'COMPLETADO'),
    enProgreso: items.filter(i => i.estado === 'EN_PROGRESO'),
    pendientes: items.filter(i => i.estado === 'PENDIENTE')
  };
}

const COLOR_POR_ESTADO = {
  COMPLETADO: { bg: 'var(--green-100)', fg: 'var(--green-500)' },
  EN_PROGRESO: { bg: 'var(--blue-100)', fg: 'var(--blue-600)' },
  PENDIENTE: { bg: 'var(--orange-100)', fg: 'var(--orange-500)' }
};

// ---------------------------------------------------------------
// Identidad visual del módulo (ícono + color + miniatura elegidos al
// crearlo): se reutiliza igual en TODAS las vistas donde aparezca un
// módulo — admin y trabajador, actuales y futuras.
// ---------------------------------------------------------------
export function chipModulo(m, size = 36, iconSize = 17, strokeWidth = null) {
  return `<div class="mod-chip" style="width:${size}px;height:${size}px;background:${m.color || 'var(--blue-600)'};"><i data-lucide="${m.icono || 'book-open'}" size="${iconSize}"${strokeWidth ? ` stroke-width="${strokeWidth}"` : ''}></i></div>`;
}
export function coverModulo(m, iconSize = 26) {
  if (m.miniaturaUrl) return `<div class="modulo-cover" style="background-image:url('${m.miniaturaUrl}');"></div>`;
  return `<div class="modulo-cover" style="background:${m.color || 'var(--blue-100)'};color:#fff;"><i data-lucide="${m.icono || 'book-open'}" size="${iconSize}"></i></div>`;
}

function filaModuloTrabajador(item, conCertificado) {
  const m = item.modulo;
  const color = COLOR_POR_ESTADO[item.estado] || COLOR_POR_ESTADO.PENDIENTE;
  const estadoTexto = item.estado === 'COMPLETADO'
    ? `Completado — puntaje ${item.hist.puntaje ?? '-'}%`
    : item.estado === 'EN_PROGRESO'
      ? `En progreso — ${item.avance}%`
      : (m.archivoUrl ? 'No iniciado' : 'El administrador aún no subió el contenido');

  let boton = '';
  if (item.estado === 'COMPLETADO') {
    boton = conCertificado
      ? `<button class="icon-btn primary-outline" onclick="verCertificadoStandalone('${m.id}', renderMisModulosTrabajador)"><i data-lucide="award" size="13"></i> Certificado</button>`
      : `<button disabled style="background:var(--gray-200);color:var(--gray-500);border:none;padding:8px 16px;border-radius:9px;font-size:.8rem;font-weight:700;cursor:default;">Completado</button>`;
  } else if (m.archivoUrl) {
    boton = `<button onclick="abrirReproductor('${m.id}')" style="background:var(--blue-600);color:white;border:none;padding:8px 16px;border-radius:9px;font-size:.8rem;font-weight:700;">${item.estado === 'EN_PROGRESO' ? 'Continuar' : 'Iniciar'}</button>`;
  }

  return `
    <div class="modulo-asignado-item">
      ${chipModulo(m, 40, 18)}
      <div style="flex:1;min-width:0;">
        <h4>${m.nombre}</h4>
        <p>${m.categoria ? m.categoria + ' · ' : ''}${estadoTexto}</p>
        ${item.estado !== 'COMPLETADO' && item.avance > 0 ? `<div class="barra-progreso-mini"><div class="barra-progreso-mini-fill" style="width:${item.avance}%;background:${color.fg};"></div></div>` : ''}
      </div>
      ${boton}
    </div>`;
}

// Tarjeta moderna de módulo para el trabajador: miniatura (o cover con el
// color+ícono del módulo), chip de identidad, estado, avance y acciones
// según el estado. La usan Mis módulos, Certificados y Mi progreso.
function tarjetaModuloTrabajador(item, vista) {
  const m = item.modulo;
  const color = COLOR_POR_ESTADO[item.estado] || COLOR_POR_ESTADO.PENDIENTE;
  const estadoLabel = item.estado === 'COMPLETADO' ? 'Completado' : item.estado === 'EN_PROGRESO' ? 'En progreso' : 'No iniciado';
  const badge = `<span class="badge-mini" style="background:${color.bg};color:${color.fg};">${estadoLabel}</span>`;

  let cuerpoExtra = '';
  let acciones = '';

  if (vista === 'certificados') {
    cuerpoExtra = `
      <div class="modulo-meta"><i data-lucide="target" size="13"></i> Puntaje: ${item.hist && item.hist.puntaje != null ? item.hist.puntaje + '%' : 'Sin evaluación'}</div>
      <div class="modulo-meta"><i data-lucide="calendar" size="13"></i> Emitido: ${item.hist && item.hist.fechaFin ? new Date(item.hist.fechaFin).toLocaleDateString('es-PE') : '-'}</div>`;
    acciones = m.certificadoUrl
      ? `<button class="btn-save" style="width:100%;justify-content:center;display:flex;align-items:center;gap:7px;" onclick="verCertificadoStandalone('${m.id}', renderCertificadosTrabajador)"><i data-lucide="download" size="14"></i> Descargar certificado</button>`
      : `<button class="btn-save" disabled style="width:100%;justify-content:center;display:flex;align-items:center;gap:7px;background:var(--gray-200);color:var(--gray-500);cursor:default;">Sin certificado</button>`;
  } else {
    cuerpoExtra = `
      <div style="display:flex;align-items:center;gap:10px;margin-top:4px;">
        <div class="barra-progreso-mini" style="flex:1;"><div class="barra-progreso-mini-fill" style="width:${item.avance}%;background:${color.fg};"></div></div>
        <span style="font-size:.78rem;font-weight:800;color:var(--gray-700);min-width:38px;text-align:right;">${item.avance}%</span>
      </div>`;
    if (vista === 'modulos') {
      if (item.estado === 'COMPLETADO') {
        acciones = `<button class="icon-btn" onclick="abrirReproductor('${m.id}')"><i data-lucide="rotate-ccw" size="13"></i> Volver a ver</button>`
          + (m.certificadoUrl ? `<button class="icon-btn primary-outline" onclick="verCertificadoStandalone('${m.id}', renderMisModulosTrabajador)"><i data-lucide="award" size="13"></i> Certificado</button>` : '');
      } else if (m.archivoUrl) {
        acciones = `<button class="btn-save" style="width:100%;justify-content:center;" onclick="abrirReproductor('${m.id}')">${item.estado === 'EN_PROGRESO' ? 'Continuar' : 'Iniciar'}</button>`;
      } else {
        acciones = `<span style="font-size:.76rem;color:var(--gray-400);">El administrador aún no subió el contenido</span>`;
      }
    }
  }

  return `
    <div class="modulo-card">
      ${coverModulo(m)}
      <div class="modulo-body">
        <div style="display:flex;align-items:center;gap:10px;">
          ${chipModulo(m)}
          <div style="flex:1;min-width:0;">
            <h3 style="margin:0;">${m.nombre}</h3>
            <p style="margin:0;font-size:.76rem;">${m.categoria || 'Sin categoría'}</p>
          </div>
          ${badge}
        </div>
        ${cuerpoExtra}
      </div>
      ${acciones ? `<div class="modulo-actions">${acciones}</div>` : ''}
    </div>`;
}

// Inicio: dashboard de novedades (no repite Mis módulos) — avisos de
// módulos recién asignados, el módulo en curso más avanzado para
// retomarlo directo, y los últimos certificados obtenidos.
const FILAS_INICIO_POR_PAGINA = 3;
let paginaContinuarInicio = 1;
let paginaPendientesInicio = 1;
let paginaLogrosInicio = 1;

// Paginación numerada (1, 2, 3, … Anterior/Siguiente) — usada por las 3
// listas de Inicio, cada una con su propio estado de página independiente.
// Paginación integrada al encabezado de la tarjeta (esquina superior
// derecha, junto al título): "## de ##" + flechas. Siempre visible, incluso
// con una sola página — las flechas quedan deshabilitadas en vez de
// desaparecer. Reemplaza los botones inferiores Anterior/Siguiente +
// numeración centrada que se usaban antes.
function htmlPaginacionHeader(pagina, totalPaginas, fnCambiar) {
  return `
    <div style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--gray-500);flex-shrink:0;">
      <span>${pagina} de ${totalPaginas}</span>
      <button class="icon-btn" style="flex:0;min-width:26px;width:26px;height:26px;padding:0;" ${pagina <= 1 ? 'disabled' : ''} onclick="${fnCambiar}(${pagina - 1})"><i data-lucide="chevron-left" size="14"></i></button>
      <button class="icon-btn" style="flex:0;min-width:26px;width:26px;height:26px;padding:0;" ${pagina >= totalPaginas ? 'disabled' : ''} onclick="${fnCambiar}(${pagina + 1})"><i data-lucide="chevron-right" size="14"></i></button>
    </div>`;
}
function paginar(lista, pagina) {
  const totalPaginas = Math.max(1, Math.ceil(lista.length / FILAS_INICIO_POR_PAGINA));
  const paginaClamp = Math.min(pagina, totalPaginas);
  const inicio = (paginaClamp - 1) * FILAS_INICIO_POR_PAGINA;
  return { pagina: paginaClamp, totalPaginas, items: lista.slice(inicio, inicio + FILAS_INICIO_POR_PAGINA) };
}

export async function renderDashboardTrabajador() {
  renderSidebarTrabajador('inicio');
  document.getElementById('pageTitle').textContent = 'Inicio';
  document.getElementById('pageSubtitle').textContent = '';
  const { usuario, items, completados, enProgreso, pendientes } = await datosCapacitacionesTrabajador();
  const total = items.length;
  const pctGeneral = total ? Math.round((completados.length / total) * 100) : 0;

  // "Última actividad": el modelo de historial solo guarda fechaInicio
  // (fija desde el primer intento) y fechaFin — no hay un timestamp de
  // "última vez tocado". fechaInicio es la mejor aproximación disponible
  // sin agregar un campo nuevo al esquema de Firestore.
  const continuarLista = enProgreso.slice()
    .sort((a, b) => new Date((b.hist && b.hist.fechaInicio) || 0) - new Date((a.hist && a.hist.fechaInicio) || 0));
  const logrosLista = completados.slice()
    .sort((a, b) => new Date(b.hist.fechaFin) - new Date(a.hist.fechaFin));

  const pagContinuar = paginar(continuarLista, paginaContinuarInicio);
  const pagPendientes = paginar(pendientes, paginaPendientesInicio);
  const pagLogros = paginar(logrosLista, paginaLogrosInicio);
  paginaContinuarInicio = pagContinuar.pagina;
  paginaPendientesInicio = pagPendientes.pagina;
  paginaLogrosInicio = pagLogros.pagina;

  document.getElementById('content').innerHTML = `
    <div class="welcome-row" style="display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;">
      <div>
        <h1>¡Bienvenido, ${usuario.primerNombre}!</h1>
        <p>Continúa con tu desarrollo profesional. Tu progreso nos impulsa a seguir creciendo.</p>
      </div>
      ${total ? `<div class="progreso-ring" style="--pct:${pctGeneral};width:74px;height:74px;font-size:.9rem;"><span>${pctGeneral}%</span></div>` : ''}
    </div>

    ${continuarLista.length ? `
    <div class="panel" style="margin-top:16px;">
      <div class="panel-head"><h2>Continúa donde quedaste</h2>${htmlPaginacionHeader(pagContinuar.pagina, pagContinuar.totalPaginas, 'cambiarPaginaContinuarInicio')}</div>
      <div id="listaContinuarInicio"></div>
    </div>` : ''}

    ${pendientes.length ? `
    <div class="panel" style="margin-top:16px;">
      <div class="panel-head"><h2>Nuevos módulos asignados</h2>${htmlPaginacionHeader(pagPendientes.pagina, pagPendientes.totalPaginas, 'cambiarPaginaPendientesInicio')}</div>
      <div id="listaAvisosPendientes"></div>
    </div>` : ''}

    ${logrosLista.length ? `
    <div class="panel" style="margin-top:16px;">
      <div class="panel-head"><h2>Logros recientes</h2>${htmlPaginacionHeader(pagLogros.pagina, pagLogros.totalPaginas, 'cambiarPaginaLogrosInicio')}</div>
      <div id="listaLogros"></div>
    </div>` : ''}

    ${total === 0 ? `
    <div class="panel" style="margin-top:16px;"><div class="empty-state">
      <i data-lucide="inbox" size="30"></i>
      <p>No existen módulos asignados.<br>Cuando el administrador te habilite una capacitación, aparecerá aquí.</p>
    </div></div>` : ''}
  `;

  if (continuarLista.length) {
    document.getElementById('listaContinuarInicio').innerHTML = pagContinuar.items.map(i => filaModuloTrabajador(i, false)).join('');
  }
  if (pendientes.length) {
    document.getElementById('listaAvisosPendientes').innerHTML = pagPendientes.items.map(i => filaModuloTrabajador(i, false)).join('');
  }
  if (logrosLista.length) {
    document.getElementById('listaLogros').innerHTML = pagLogros.items.map(i => `
        <div class="modulo-asignado-item">
          ${chipModulo(i.modulo, 40, 18)}
          <div style="flex:1;min-width:0;">
            <h4>${i.modulo.nombre}</h4>
            <p>Completado el ${new Date(i.hist.fechaFin).toLocaleDateString('es-PE')} — puntaje ${i.hist.puntaje ?? '-'}%</p>
          </div>
          <div class="fila-logro-acciones" style="display:flex;gap:8px;flex-shrink:0;">
            <button class="icon-btn" style="white-space:nowrap;" onclick="abrirReproductor('${i.modulo.id}')"><i data-lucide="rotate-ccw" size="13"></i> Volver a ver</button>
            ${i.modulo.certificadoUrl
              ? `<button class="icon-btn primary-outline" style="white-space:nowrap;" onclick="verCertificadoStandalone('${i.modulo.id}', renderDashboardTrabajador)"><i data-lucide="award" size="13"></i> Certificado</button>`
              : `<button class="icon-btn" disabled style="white-space:nowrap;opacity:.5;cursor:default;">Sin certificado</button>`}
          </div>
        </div>`).join('');
  }
  lucide.createIcons();
}
function cambiarPaginaContinuarInicio(n) { paginaContinuarInicio = n; renderDashboardTrabajador(); }
function cambiarPaginaPendientesInicio(n) { paginaPendientesInicio = n; renderDashboardTrabajador(); }
function cambiarPaginaLogrosInicio(n) { paginaLogrosInicio = n; renderDashboardTrabajador(); }

let filtroMisModulos = 'todos';
async function renderMisModulosTrabajador(filtro) {
  if (filtro) { filtroMisModulos = filtro; paginaMisModulos = 1; }
  renderSidebarTrabajador('modulos');
  document.getElementById('pageTitle').textContent = 'Mis módulos';
  document.getElementById('pageSubtitle').textContent = 'Todos tus módulos asignados';

  const { items, completados, enProgreso, pendientes } = await datosCapacitacionesTrabajador();
  const total = items.length;
  const pctGeneral = total ? Math.round((completados.length / total) * 100) : 0;
  const tarjetas = [
    { key:'todos', label:'Todos', num: items.length, bg: 'var(--gray-100)', fg: 'var(--gray-500)', icon: 'layout-grid' },
    { key:'progreso', label:'En progreso', num: enProgreso.length, bg: 'var(--blue-100)', fg: 'var(--blue-600)', icon: 'graduation-cap' },
    { key:'completados', label:'Completadas', num: completados.length, bg: 'var(--green-100)', fg: 'var(--green-500)', icon: 'check-circle-2' },
    { key:'pendientes', label:'Pendientes', num: pendientes.length, bg: 'var(--orange-100)', fg: 'var(--orange-500)', icon: 'clock' }
  ];
  const filtrados = filtroMisModulos === 'progreso' ? enProgreso
    : filtroMisModulos === 'pendientes' ? pendientes
    : filtroMisModulos === 'completados' ? completados
    : items;

  const totalPaginasMis = Math.max(1, Math.ceil(filtrados.length / TARJETAS_POR_PAGINA));
  paginaMisModulos = Math.min(paginaMisModulos, totalPaginasMis);

  document.getElementById('content').innerHTML = `
    ${total ? `
    <div class="panel" style="display:flex;align-items:center;gap:24px;margin-bottom:20px;flex-wrap:wrap;">
      <div class="progreso-ring" style="--pct:${pctGeneral};"><span>${pctGeneral}%</span></div>
      <div>
        <h2 style="font-size:1rem;font-weight:800;color:var(--navy-900);">Progreso general</h2>
        <p style="font-size:.85rem;color:var(--gray-500);">${completados.length} de ${total} módulo(s) completado(s)</p>
      </div>
    </div>` : ''}
    <div class="stat-grid">
      ${tarjetas.map(t => `
        <div class="stat-card stat-filtro ${filtroMisModulos===t.key?'active':''}" style="--activo-color:${t.fg};" onclick="renderMisModulosTrabajador('${t.key}')">
          <div class="stat-icon" style="background:${t.bg};color:${t.fg};"><i data-lucide="${t.icon}" size="18"></i></div>
          <div><div class="num">${t.num}</div><div class="label">${t.label}</div></div>
        </div>`).join('')}
    </div>
    ${filtrados.length ? `<div style="display:flex;justify-content:flex-end;margin:14px 0 8px;">${htmlPaginacionHeader(paginaMisModulos, totalPaginasMis, 'cambiarPaginaMisModulos')}</div>` : ''}
    <div class="grid-modulos" id="listaMisModulos"></div>
  `;

  if (filtrados.length) {
    const inicio = (paginaMisModulos - 1) * TARJETAS_POR_PAGINA;
    document.getElementById('listaMisModulos').innerHTML =
      filtrados.slice(inicio, inicio + TARJETAS_POR_PAGINA).map(i => tarjetaModuloTrabajador(i, 'modulos')).join('');
  } else {
    document.getElementById('listaMisModulos').innerHTML = `<div class="empty-modulos"><i data-lucide="inbox" size="30"></i><p>No hay módulos en esta categoría.</p></div>`;
  }
  lucide.createIcons();
}
let paginaMisModulos = 1;
function cambiarPaginaMisModulos(n) { paginaMisModulos = n; renderMisModulosTrabajador(); }

let paginaCertificados = 1;
async function renderCertificadosTrabajador() {
  renderSidebarTrabajador('certificados');
  document.getElementById('pageTitle').textContent = 'Certificados';
  document.getElementById('pageSubtitle').textContent = 'Certificados obtenidos por módulos completados';
  const { completados } = await datosCapacitacionesTrabajador();

  const totalPaginasCert = Math.max(1, Math.ceil(completados.length / TARJETAS_POR_PAGINA));
  paginaCertificados = Math.min(paginaCertificados, totalPaginasCert);
  document.getElementById('content').innerHTML = `
    ${completados.length ? `<div style="display:flex;justify-content:flex-end;margin-bottom:10px;">${htmlPaginacionHeader(paginaCertificados, totalPaginasCert, 'cambiarPaginaCertificados')}</div>` : ''}
    <div class="grid-modulos" id="listaCertificados"></div>`;
  if (completados.length) {
    const inicio = (paginaCertificados - 1) * TARJETAS_POR_PAGINA;
    document.getElementById('listaCertificados').innerHTML =
      completados.slice(inicio, inicio + TARJETAS_POR_PAGINA).map(i => tarjetaModuloTrabajador(i, 'certificados')).join('');
  } else {
    document.getElementById('listaCertificados').innerHTML = `<div class="empty-modulos"><i data-lucide="award" size="30"></i><p>Todavía no tienes certificados. Completa una capacitación para obtener el primero.</p></div>`;
  }
  lucide.createIcons();
}
function cambiarPaginaCertificados(n) { paginaCertificados = n; renderCertificadosTrabajador(); }

function renderPerfilTrabajador() {
  renderSidebarTrabajador('perfil');
  document.getElementById('pageTitle').textContent = 'Perfil';
  document.getElementById('pageSubtitle').textContent = '';
  const usuario = getSesion();

  document.getElementById('content').innerHTML = `
    <div class="panel" style="max-width:480px;">
      <div class="panel-head"><h2>Foto de perfil</h2></div>
      <div style="display:flex;align-items:center;gap:16px;">
        <div class="avatar" id="perfilAvatarPreview" style="width:64px;height:64px;font-size:1.2rem;${usuario.fotoUrl ? `background-image:url('${usuario.fotoUrl}');background-size:cover;` : ''}">${usuario.fotoUrl ? '' : (usuario.primerNombre[0] + usuario.apellidoPaterno[0]).toUpperCase()}</div>
        <label class="btn-outline" style="cursor:pointer;">
          <input type="file" id="fFotoPerfil" accept="image/*" style="display:none;">
          Cambiar foto
        </label>
        ${usuario.fotoUrl ? `<button type="button" class="btn-cancel" id="btnEliminarFotoPerfil">Eliminar</button>` : ''}
      </div>
    </div>
    <div class="panel" style="max-width:480px;margin-top:20px;">
      <div class="panel-head"><h2>Cambiar contraseña</h2></div>
      <div class="form-error" id="formErrorPerfil"></div>
      <div class="form-success" id="formSuccessPerfil"></div>
      <form id="formPerfilPassword">
        <div class="form-group"><label>Contraseña actual</label><input type="password" id="pActual" required></div>
        <div class="form-group"><label>Nueva contraseña</label><input type="password" id="pNueva" required></div>
        <div class="form-group"><label>Confirmar nueva contraseña</label><input type="password" id="pConfirmar" required></div>
        <button type="submit" class="btn-save">Actualizar contraseña</button>
      </form>
    </div>
  `;
  lucide.createIcons();

  document.getElementById('fFotoPerfil').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      await DB.actualizarUsuario(usuario.dni, { fotoUrl: reader.result });
      usuario.fotoUrl = reader.result;
      setSesion(usuario);
      renderPerfilTrabajador();
    };
    reader.readAsDataURL(f);
  });

  const btnEliminarFoto = document.getElementById('btnEliminarFotoPerfil');
  if (btnEliminarFoto) btnEliminarFoto.addEventListener('click', async () => {
    await conFeedback('Eliminando foto...', async () => {
      await DB.actualizarUsuario(usuario.dni, { fotoUrl: '' });
      usuario.fotoUrl = '';
      setSesion(usuario);
      renderPerfilTrabajador();
    }, { exito: 'Foto eliminada.', error: 'No se pudo eliminar la foto.' });
  });

  document.getElementById('formPerfilPassword').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('formErrorPerfil');
    const successBox = document.getElementById('formSuccessPerfil');
    errorBox.classList.remove('show'); successBox.classList.remove('show');
    const actual = document.getElementById('pActual').value;
    const nueva = document.getElementById('pNueva').value;
    const confirmar = document.getElementById('pConfirmar').value;

    if (nueva.length < 4) { errorBox.textContent = 'La nueva contraseña debe tener al menos 4 caracteres.'; errorBox.classList.add('show'); return; }
    if (nueva !== confirmar) { errorBox.textContent = 'Las contraseñas no coinciden.'; errorBox.classList.add('show'); return; }

    try {
      const credencial = EmailAuthProvider.credential(usuario.correo, actual);
      await reauthenticateWithCredential(auth.currentUser, credencial);
      await updatePassword(auth.currentUser, nueva);
      await DB.actualizarUsuario(usuario.dni, { debeCambiarPassword: false });
      usuario.debeCambiarPassword = false;
      setSesion(usuario);
      successBox.textContent = 'Contraseña actualizada correctamente.';
      successBox.classList.add('show');
      document.getElementById('formPerfilPassword').reset();
    } catch (err) {
      console.error('Cambiar contraseña:', err);
      errorBox.textContent = err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential' ? 'La contraseña actual no es correcta.' : 'No se pudo actualizar la contraseña.';
      errorBox.classList.add('show');
    }
  });
}

// ---------------------------------------------------------------
// Sidebar ADMIN
// ---------------------------------------------------------------
function renderSidebarAdmin(activo) {
  marcarRuta(activo);
  const items = [
    { key:'capacitaciones', label:'Módulos', icon:'book-open', fn:'renderCapacitaciones' },
    { key:'usuarios', label:'Usuarios', icon:'users', fn:'renderUsuarios' },
    { key:'configuracion', label:'Configuración', icon:'settings', fn:'renderConfiguracion' }
  ];
  document.getElementById('sidebar').innerHTML = `
    ${logoDeSidebar()}
    <span class="role-tag">Panel de administrador</span>
    <nav class="nav-group">
      ${items.map(it => `<a class="nav-item ${it.key===activo?'active':''}" onclick="${it.fn}()"><i data-lucide="${it.icon}" size="17"></i> ${it.label}</a>`).join('')}
    </nav>
    <a class="logout-item" onclick="cerrarSesion()"><i data-lucide="log-out" size="17"></i> Cerrar sesión</a>
  `;
  lucide.createIcons();
}

// ---------------------------------------------------------------
// ADMIN: Asignaciones — vista consolidada de qué módulo tiene
// habilitado cada trabajador.
// ---------------------------------------------------------------


// ---------------------------------------------------------------
// ADMIN: Configuración
// ---------------------------------------------------------------
async function renderConfiguracion() {
  renderSidebarAdmin('configuracion');
  document.getElementById('pageTitle').textContent = 'Configuración';
  document.getElementById('pageSubtitle').textContent = '';
  const [modulos, usuarios, historial] = await Promise.all([DB.obtenerModulos(), DB.obtenerUsuarios(), DB.obtenerHistorial()]);

  document.getElementById('content').innerHTML = `
    <div class="panel" style="max-width:520px;">
      <div class="panel-head"><h2>Resumen de la plataforma</h2></div>
      <p style="font-size:.84rem;color:var(--gray-700);">Módulos: <strong>${modulos.length}</strong></p>
      <p style="font-size:.84rem;color:var(--gray-700);">Trabajadores: <strong>${usuarios.filter(u=>u.rol==='TRABAJADOR').length}</strong></p>
      <p style="font-size:.84rem;color:var(--gray-700);">Módulos completados: <strong>${historial.filter(h=>h.estado==='COMPLETADO').length}</strong></p>
    </div>
  `;
  lucide.createIcons();
}

// ---------------------------------------------------------------
// ADMIN: Capacitaciones (Módulos)
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Paginación genérica para grids de tarjetas (Módulos admin, Mis
// módulos, Certificados) — misma pinta que la de Usuarios.
// ---------------------------------------------------------------
const TARJETAS_POR_PAGINA = 9;
function htmlPaginacionTarjetas(pagina, totalPaginas, fnCambiar) {
  if (totalPaginas <= 1) return '';
  return `
    <div style="display:flex;justify-content:center;gap:8px;margin-top:16px;grid-column:1/-1;">
      <button class="icon-btn" ${pagina===1?'disabled':''} onclick="${fnCambiar}(${pagina-1})"><i data-lucide="chevron-left" size="15"></i></button>
      <span style="font-size:.82rem;color:var(--gray-500);align-self:center;">Página ${pagina} de ${totalPaginas}</span>
      <button class="icon-btn" ${pagina===totalPaginas?'disabled':''} onclick="${fnCambiar}(${pagina+1})"><i data-lucide="chevron-right" size="15"></i></button>
    </div>`;
}
function mesDeCarga(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function etiquetaMes(clave) {
  const [aaaa, mm] = clave.split('-');
  return new Date(Number(aaaa), Number(mm) - 1, 1).toLocaleDateString('es-PE', { month: 'long', year: 'numeric' });
}

let paginaModulos = 1;
let filtroMesModulos = '';
async function renderCapacitaciones(pagina) {
  if (pagina) paginaModulos = pagina;
  renderSidebarAdmin('capacitaciones');
  document.getElementById('pageTitle').textContent = 'Módulos';
  document.getElementById('pageSubtitle').textContent = 'Gestión de módulos';

  const [modulos, asignaciones] = await Promise.all([DB.obtenerModulos(), DB.obtenerAsignaciones()]);
  const meses = [...new Set(modulos.map(m => mesDeCarga(m.fechaCreacion)).filter(Boolean))].sort().reverse();
  const modulosFiltrados = filtroMesModulos ? modulos.filter(m => mesDeCarga(m.fechaCreacion) === filtroMesModulos) : modulos;

  document.getElementById('content').innerHTML = `
    <div class="toolbar">
      <div class="filters-bar" style="margin-bottom:0;">
        <select id="filtroMesModulos"><option value="">Todos los meses</option>${meses.map(m => `<option value="${m}" ${m===filtroMesModulos?'selected':''}>${etiquetaMes(m)}</option>`).join('')}</select>
      </div>
      <button class="btn-save" style="display:flex;align-items:center;gap:7px;" onclick="abrirModalModulo()"><i data-lucide="plus" size="16"></i> Nuevo módulo</button>
    </div>
    <div class="grid-modulos" id="gridModulos"></div>
  `;
  document.getElementById('filtroMesModulos').addEventListener('change', (e) => {
    filtroMesModulos = e.target.value;
    paginaModulos = 1;
    renderCapacitaciones();
  });

  const grid = document.getElementById('gridModulos');
  if (modulosFiltrados.length === 0) {
    grid.innerHTML = `
      <div class="empty-modulos">
        <i data-lucide="package-open" size="36"></i>
        <p>${modulos.length === 0 ? 'Todavía no se ha subido ningún módulo.<br>Haz clic en "Nuevo módulo" para agregar el primero.' : 'Ningún módulo coincide con el mes seleccionado.'}</p>
      </div>`;
  } else {
    const totalPaginas = Math.max(1, Math.ceil(modulosFiltrados.length / TARJETAS_POR_PAGINA));
    paginaModulos = Math.min(paginaModulos, totalPaginas);
    const inicio = (paginaModulos - 1) * TARJETAS_POR_PAGINA;
    const pagina_ = modulosFiltrados.slice(inicio, inicio + TARJETAS_POR_PAGINA);

    grid.innerHTML = pagina_.map(m => {
      const totalHabilitados = asignaciones.filter(a => a.moduloId === m.id && a.habilitado).length;
      return `
      <div class="modulo-card">
        ${coverModulo(m)}
        <div class="modulo-body">
          <div style="display:flex;align-items:center;gap:10px;">
            ${chipModulo(m)}
            <h3 style="margin:0;flex:1;">${m.numeroModulo ? `M${m.numeroModulo} · ` : ''}${m.nombre}</h3>
            <span class="badge-mini ${m.estado==='ACTIVO'?'activo':'inactivo'}">${m.estado==='ACTIVO'?'Activo':'Inactivo'}</span>
          </div>
          <p>${m.descripcion || 'Sin descripción'}</p>
          <div class="modulo-meta"><i data-lucide="file-archive" size="13"></i> ${m.archivoNombre || 'Sin archivo'}</div>
          <div class="modulo-meta"><i data-lucide="list-checks" size="13"></i> ${m.preguntas && m.preguntas.length ? m.preguntas.length + ' pregunta(s)' : 'Sin preguntas'}</div>
          <div class="modulo-meta"><i data-lucide="award" size="13"></i> ${m.certificadoNombre || 'Sin certificado'}</div>
          <div class="modulo-meta"><i data-lucide="users" size="13"></i> ${totalHabilitados} trabajador(es) habilitado(s)</div>
        </div>
        <div class="modulo-actions">
          <button class="icon-btn" onclick="abrirModalModulo('${m.id}')"><i data-lucide="pencil" size="13"></i> Editar</button>
          <button class="icon-btn primary-outline" onclick="abrirModalGrupo('${m.id}','${m.nombre.replace(/'/g,"\\'")}')"><i data-lucide="users-round" size="13"></i> Asignar</button>
          <button class="icon-btn" onclick="toggleEstadoModulo('${m.id}')"><i data-lucide="power" size="13"></i> ${m.estado==='ACTIVO'?'Inactivar':'Activar'}</button>
          <button class="icon-btn danger" onclick="eliminarModulo('${m.id}','${m.nombre.replace(/'/g,"\\'")}')"><i data-lucide="trash-2" size="13"></i> Eliminar</button>
        </div>
      </div>
    `;
    }).join('') + htmlPaginacionTarjetas(paginaModulos, totalPaginas, 'renderCapacitaciones');
  }
  lucide.createIcons();
}

async function toggleEstadoModulo(id) {
  const m = await DB.obtenerModulo(id);
  await DB.actualizarModulo(id, { estado: m.estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO' });
  renderCapacitaciones();
}
async function eliminarModulo(id, nombre) {
  if (!confirm(`¿Eliminar el módulo "${nombre}"? Esta acción no se puede deshacer. (Los archivos ya subidos a GitHub deben borrarse manualmente en el repositorio si ya no se necesitan).`)) return;
  await DB.eliminarModulo(id);
  renderCapacitaciones();
}

// Modal nuevo/editar módulo
const modalOverlay = document.getElementById('modalOverlay');
const formModulo = document.getElementById('formModulo');
const fileDrop = document.getElementById('fileDrop');
const fArchivo = document.getElementById('fArchivo');
const fileDropPreguntas = document.getElementById('fileDropPreguntas');
const fPreguntas = document.getElementById('fPreguntas');
const fileDropCertificado = document.getElementById('fileDropCertificado');
const fCertificado = document.getElementById('fCertificado');
const fileDropMiniatura = document.getElementById('fileDropMiniatura');
const fMiniatura = document.getElementById('fMiniatura');
let miniaturaExistenteUrl = null; // se conserva si al editar no se elige una nueva
// Al presionar "Eliminar" sobre un archivo YA guardado (modo Editar), no
// alcanza con limpiar el input — hay que avisarle al submit que ese campo
// debe borrarse explícitamente en Firestore (omitirlo del payload significa
// "no tocar", no "borrar"; ver el submit más abajo).
let miniaturaEliminada = false;
let preguntasEliminadas = false;
let certificadoEliminado = false;

// Galería visual de íconos del módulo: tarjetas clicables (sin dropdown
// de texto), mismo estilo gráfico usado en el resto de la plataforma.
const ICONOS_MODULO = [
  // Originales
  'book-open', 'shield-check', 'hard-hat', 'users', 'heart-handshake', 'graduation-cap',
  'scale', 'flame', 'megaphone', 'file-text', 'briefcase', 'life-buoy',
  'alert-triangle', 'lock', 'leaf', 'truck', 'wrench', 'clipboard-check',
  'heart-pulse', 'building-2', 'globe', 'shield-alert', 'gavel', 'award',
  // Ampliación — seguridad, salud, capacitación, oficina, logística,
  // transporte, herramientas, documentos, personas, medio ambiente
  'shield', 'siren', 'flashlight', 'construction', 'traffic-cone',
  'stethoscope', 'pill', 'syringe', 'thermometer', 'hospital',
  'presentation', 'lightbulb', 'printer',
  'ship', 'plane', 'package', 'anchor', 'route',
  'hammer', 'cog', 'clipboard-list', 'file-signature',
  'user-check', 'user-plus', 'recycle', 'sprout'
];
document.getElementById('fColor').addEventListener('input', (e) => {
  document.getElementById('fColorHex').textContent = e.target.value.toUpperCase();
});
function renderGaleriaIconos(seleccionado) {
  const cont = document.getElementById('galeriaIconos');
  cont.innerHTML = ICONOS_MODULO.map(icono => `
    <div class="icon-gallery-item ${icono === seleccionado ? 'active' : ''}" data-icono="${icono}" title="${icono}">
      <i data-lucide="${icono}" size="20"></i>
    </div>`).join('');
  cont.querySelectorAll('.icon-gallery-item').forEach(el => {
    el.addEventListener('click', () => seleccionarIconoModulo(el.dataset.icono));
  });
  lucide.createIcons();
}
function seleccionarIconoModulo(icono) {
  document.getElementById('fIcono').value = icono;
  document.querySelectorAll('#galeriaIconos .icon-gallery-item').forEach(el => {
    el.classList.toggle('active', el.dataset.icono === icono);
  });
}

// Único indicador visual por cuadrante: 'ok' (✅ + papelera), 'error' (❌,
// carga rechazada, sin papelera porque el input ya quedó vacío) o null
// (sin archivo — cuadrante en su estado inicial). El tamaño/contenido del
// recuadro nunca cambia, solo esta esquina.
// El cuadrante "Módulo" no tiene papelera (btn puede no existir): es el
// contenido principal de la capacitación, nunca se puede dejar el registro
// sin archivo reproducible desde Editar — solo se reemplaza eligiendo uno
// nuevo, que sustituye al existente automáticamente al guardar.
function mostrarEstadoArchivo(prefijo, estado) {
  const cont = document.getElementById('estado' + prefijo);
  const badge = document.getElementById('badge' + prefijo);
  const btn = document.getElementById('btnEliminar' + prefijo);
  if (!cont || !badge) return;
  if (estado === 'ok') {
    badge.textContent = '✅';
    if (btn) btn.style.display = 'flex';
    cont.style.display = 'flex';
  } else if (estado === 'error') {
    badge.textContent = '❌';
    if (btn) btn.style.display = 'none';
    cont.style.display = 'flex';
  } else {
    cont.style.display = 'none';
  }
}

async function abrirModalModulo(id) {
  formModulo.reset();
  document.getElementById('previewMiniatura').src = '';
  miniaturaExistenteUrl = null;
  miniaturaEliminada = false;
  preguntasEliminadas = false;
  certificadoEliminado = false;
  mostrarEstadoArchivo('Miniatura', null);
  mostrarEstadoArchivo('Archivo', null);
  mostrarEstadoArchivo('Preguntas', null);
  mostrarEstadoArchivo('Certificado', null);
  document.getElementById('formError').classList.remove('show');
  document.getElementById('mfId').value = id || '';

  if (id) {
    const m = await DB.obtenerModulo(id);
    document.getElementById('modalModuloTitulo').textContent = 'Editar módulo';
    document.getElementById('fNombre').value = m.nombre;
    document.getElementById('fDescripcion').value = m.descripcion || '';
    document.getElementById('fCategoria').value = m.categoria || '';
    renderGaleriaIconos(m.icono || 'book-open');
    document.getElementById('fColor').value = m.color || '#2563eb';
    document.getElementById('fColorHex').textContent = (m.color || '#2563eb').toUpperCase();
    mostrarEstadoArchivo('Archivo', m.archivoNombre ? 'ok' : null);
    mostrarEstadoArchivo('Preguntas', (m.preguntas && m.preguntas.length) ? 'ok' : null);
    mostrarEstadoArchivo('Certificado', m.certificadoNombre ? 'ok' : null);
    if (m.miniaturaUrl) {
      miniaturaExistenteUrl = m.miniaturaUrl;
      document.getElementById('previewMiniatura').src = m.miniaturaUrl;
      mostrarEstadoArchivo('Miniatura', 'ok');
    }
  } else {
    document.getElementById('modalModuloTitulo').textContent = 'Nuevo módulo';
    renderGaleriaIconos('book-open');
    document.getElementById('fColorHex').textContent = document.getElementById('fColor').value.toUpperCase();
  }
  modalOverlay.classList.add('show');
}
document.getElementById('btnCancelarModulo').addEventListener('click', () => modalOverlay.classList.remove('show'));

function wireFileDrop(drop, input, onChange) {
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--blue-600)'; });
  drop.addEventListener('dragleave', () => drop.style.borderColor = '');
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.style.borderColor = '';
    if (e.dataTransfer.files[0]) { input.files = e.dataTransfer.files; onChange(); }
  });
  input.addEventListener('change', onChange);
}
// Normaliza una carpeta arrastrada a .zip en el navegador: los 3 caminos
// de carga (.zip / .rar / carpeta) terminan siempre en el mismo artefacto
// almacenado y comparten el mismo código de subida más abajo.
async function normalizarCarpetaModulo(zipPromise) {
  const nombreBase = (document.getElementById('fNombre').value.trim() || 'modulo').replace(/\s+/g, '_');
  try {
    const zip = await zipPromise;
    const archivoZip = await jszipAArchivoZip(zip, nombreBase);
    const dt = new DataTransfer();
    dt.items.add(archivoZip);
    fArchivo.files = dt.files;
    mostrarEstadoArchivo('Archivo', 'ok');
  } catch (e) {
    console.error('No se pudo comprimir la carpeta:', e);
    fArchivo.value = '';
    mostrarEstadoArchivo('Archivo', 'error');
  }
}

// La zona de arrastre acepta .zip/.rar sueltos o una carpeta completa: los
// FileSystemEntry hay que leerlos con webkitGetAsEntry() en el mismo tick
// síncrono del evento 'drop' (el DataTransfer deja de ser válido después).
fArchivo.addEventListener('change', () => {
  const f = fArchivo.files[0];
  if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase();
  if (!['zip', 'rar'].includes(ext)) {
    fArchivo.value = '';
    mostrarEstadoArchivo('Archivo', 'error');
    return;
  }
  mostrarEstadoArchivo('Archivo', 'ok');
});
fileDrop.addEventListener('click', () => fArchivo.click());
fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.style.borderColor = 'var(--blue-600)'; });
fileDrop.addEventListener('dragleave', () => { fileDrop.style.borderColor = ''; });
fileDrop.addEventListener('drop', e => {
  e.preventDefault();
  fileDrop.style.borderColor = '';
  const items = e.dataTransfer.items;
  const entradas = items ? Array.from(items).map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean) : [];
  const esCarpeta = entradas.some(en => en.isDirectory);
  if (esCarpeta) {
    normalizarCarpetaModulo(carpetaArrastradaAJSZip(items));
    return;
  }
  if (e.dataTransfer.files[0]) {
    fArchivo.files = e.dataTransfer.files;
    fArchivo.dispatchEvent(new Event('change'));
  }
});
// Redimensiona la miniatura a un ancho máximo (se guarda como data URL
// directo en el documento del módulo, igual que la foto de perfil del
// usuario — no pasa por GitHub, es liviana).
function redimensionarImagen(archivo, anchoMaximo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => {
      const img = new Image();
      img.onload = () => {
        const escala = Math.min(1, anchoMaximo / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * escala);
        canvas.height = Math.round(img.height * escala);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = lector.result;
    };
    lector.onerror = reject;
    lector.readAsDataURL(archivo);
  });
}
wireFileDrop(fileDropMiniatura, fMiniatura, async () => {
  const f = fMiniatura.files[0];
  if (!f) return;
  const extOk = /^image\//.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
  if (!extOk) {
    fMiniatura.value = '';
    mostrarEstadoArchivo('Miniatura', 'error');
    return;
  }
  miniaturaEliminada = false;
  try {
    const dataUrl = await redimensionarImagen(f, 640);
    document.getElementById('previewMiniatura').src = dataUrl;
    mostrarEstadoArchivo('Miniatura', 'ok');
  } catch (e) {
    fMiniatura.value = '';
    mostrarEstadoArchivo('Miniatura', 'error');
  }
});
wireFileDrop(fileDropPreguntas, fPreguntas, () => {
  const f = fPreguntas.files[0];
  if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase();
  if (!['txt', 'docx', 'json'].includes(ext)) {
    fPreguntas.value = '';
    mostrarEstadoArchivo('Preguntas', 'error');
    return;
  }
  preguntasEliminadas = false;
  mostrarEstadoArchivo('Preguntas', 'ok');
});
wireFileDrop(fileDropCertificado, fCertificado, () => {
  const f = fCertificado.files[0];
  if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase();
  if (ext !== 'pdf') {
    fCertificado.value = '';
    mostrarEstadoArchivo('Certificado', 'error');
    return;
  }
  certificadoEliminado = false;
  mostrarEstadoArchivo('Certificado', 'ok');
});

// Botón "Eliminar" de cada bloque: limpia el input/preview/estado y, si el
// archivo ya existía guardado (modo Editar), marca el campo para borrarse
// de verdad en Firestore al guardar (ver submit más abajo — omitir un
// campo del payload significa "no tocar", no "borrar").
document.getElementById('btnEliminarMiniatura').addEventListener('click', (e) => {
  e.stopPropagation();
  fMiniatura.value = '';
  miniaturaExistenteUrl = null;
  miniaturaEliminada = true;
  document.getElementById('previewMiniatura').src = '';
  mostrarEstadoArchivo('Miniatura', null);
});
document.getElementById('btnEliminarPreguntas').addEventListener('click', (e) => {
  e.stopPropagation();
  fPreguntas.value = '';
  preguntasEliminadas = true;
  mostrarEstadoArchivo('Preguntas', null);
});
document.getElementById('btnEliminarCertificado').addEventListener('click', (e) => {
  e.stopPropagation();
  fCertificado.value = '';
  certificadoEliminado = true;
  mostrarEstadoArchivo('Certificado', null);
});

formModulo.addEventListener('submit', async (e) => {
  e.preventDefault();
  const idExistente = document.getElementById('mfId').value;
  const nombre = document.getElementById('fNombre').value.trim();
  const descripcion = document.getElementById('fDescripcion').value.trim();
  const categoria = document.getElementById('fCategoria').value.trim();
  let archivo = fArchivo.files[0];
  const archivoPreguntas = fPreguntas.files[0];
  const archivoCertificado = fCertificado.files[0];
  const errorBox = document.getElementById('formError');
  errorBox.classList.remove('show');

  if (!nombre) { errorBox.textContent = 'El nombre del módulo es obligatorio.'; errorBox.classList.add('show'); return; }
  if (archivo) {
    const ext = archivo.name.split('.').pop().toLowerCase();
    if (!['zip','rar'].includes(ext)) {
      errorBox.textContent = 'El módulo solo acepta archivos .zip o .rar.'; errorBox.classList.add('show'); return;
    }
  }
  if (archivoCertificado && archivoCertificado.name.split('.').pop().toLowerCase() !== 'pdf') {
    errorBox.textContent = 'La plantilla de certificado debe ser un archivo .pdf.'; errorBox.classList.add('show'); return;
  }

  let preguntasParseadas = null;
  if (archivoPreguntas) {
    try {
      preguntasParseadas = await parsearArchivoPreguntas(archivoPreguntas);
      if (!preguntasParseadas.length) throw new Error('No se reconoció ninguna pregunta válida en el archivo (revisa el formato "1. pregunta" / "a. alternativa").');
    } catch (err) {
      errorBox.textContent = err.message || 'No se pudo procesar el archivo de preguntas.';
      errorBox.classList.add('show');
      return;
    }
  }

  const botonGuardar = document.getElementById('btnGuardarModulo');
  botonGuardar.disabled = true;
  botonGuardar.textContent = 'Subiendo...';
  mostrarCargando('Guardando módulo...');
  try {
    const id = idExistente || ('mod-' + Date.now());
    const icono = document.getElementById('fIcono').value;
    const color = document.getElementById('fColor').value;
    const datos = { nombre, descripcion, categoria, icono, color };

    // La miniatura ya llegó redimensionada como data URL al elegir el
    // archivo (ver wireFileDrop de fileDropMiniatura). Si al editar no se
    // eligió una nueva, se conserva la existente.
    const previewMiniatura = document.getElementById('previewMiniatura');
    if (fMiniatura.files[0] && previewMiniatura.src.startsWith('data:')) {
      datos.miniaturaUrl = previewMiniatura.src;
    } else if (miniaturaExistenteUrl) {
      datos.miniaturaUrl = miniaturaExistenteUrl;
    } else if (miniaturaEliminada) {
      datos.miniaturaUrl = null; // omitir el campo = "no tocar"; null = borrar de verdad
    }

    // Normaliza .rar a .zip antes de subir: así el artefacto almacenado en
    // GitHub es siempre el mismo sin importar si el admin subió .zip, .rar
    // o una carpeta (que ya llega convertida a .zip desde fCarpeta).
    if (archivo && archivo.name.split('.').pop().toLowerCase() === 'rar') {
      actualizarCargando('Convirtiendo .rar a .zip...');
      const zip = await archivoAJSZip(archivo);
      archivo = await jszipAArchivoZip(zip, archivo.name.replace(/\.rar$/i, ''));
    }

    // Fijo para siempre al crear: nunca se reescribe al editar el módulo
    // ni se recalcula (borrar otro módulo no corre este número).
    if (!idExistente) datos.numeroModulo = await DB.siguienteNumeroModulo();

    // Los 2 archivos (módulo + certificado) se suben en un solo commit:
    // dos commits seguidos chocaban con la propagación de la API de
    // referencias de GitHub (ver github-storage.js).
    const entradas = [];
    if (archivo) entradas.push({ file: archivo, carpeta: `modulos/${id}`, tipo: 'archivo' });
    if (archivoCertificado) entradas.push({ file: archivoCertificado, carpeta: `certificados/${id}`, tipo: 'certificado' });

    if (entradas.length) {
      actualizarCargando('Subiendo archivos a GitHub...');
      const subidas = await subirArchivosAGithub(entradas, `Sube módulo: ${nombre}`);
      entradas.forEach((entrada, i) => {
        if (entrada.tipo === 'archivo') {
          datos.archivoUrl = subidas[i].url;
          datos.archivoNombre = archivo.name;
          datos.archivoPeso = archivo.size;
        } else {
          datos.certificadoUrl = subidas[i].url;
          datos.certificadoNombre = archivoCertificado.name;
          certificadoEliminado = false;
        }
      });
    }
    if (!archivoCertificado && certificadoEliminado) {
      datos.certificadoUrl = null;
      datos.certificadoNombre = null;
    }

    if (preguntasParseadas) {
      datos.preguntas = preguntasParseadas;
      datos.preguntasNombre = archivoPreguntas.name;
    } else if (preguntasEliminadas) {
      datos.preguntas = null;
      datos.preguntasNombre = null;
    }

    if (idExistente) {
      await DB.actualizarModulo(idExistente, datos);
    } else {
      await DB.crearModulo(id, { ...datos, estado: 'ACTIVO', fechaCreacion: new Date().toISOString() });
    }

    ocultarCargando();
    toast('exito', `Módulo "${nombre}" guardado correctamente.`);
    modalOverlay.classList.remove('show');
    renderCapacitaciones();
  } catch (err) {
    console.error('Guardar módulo:', err);
    ocultarCargando();
    errorBox.textContent = err.message || 'No se pudo guardar el módulo.';
    errorBox.classList.add('show');
    toast('error', err.message || 'No se pudo guardar el módulo.');
  } finally {
    botonGuardar.disabled = false;
    botonGuardar.textContent = 'Guardar módulo';
  }
});

// ---------------------------------------------------------------
// Modal: asignar módulo por Área/Sede (masivo)
// ---------------------------------------------------------------
let grupoModuloId = null;
async function abrirModalGrupo(moduloId, nombreModulo) {
  grupoModuloId = moduloId;
  document.getElementById('grupoSubtitulo').textContent = `Módulo: ${nombreModulo}`;
  document.getElementById('formErrorGrupo').classList.remove('show');
  document.getElementById('gTipoFiltro').value = 'todos';
  await poblarValoresFiltroGrupo();
  document.getElementById('modalGrupoOverlay').classList.add('show');
}
document.getElementById('btnCancelarGrupo').addEventListener('click', () => document.getElementById('modalGrupoOverlay').classList.remove('show'));
document.getElementById('gTipoFiltro').addEventListener('change', poblarValoresFiltroGrupo);

const CAMPO_POR_TIPO_GRUPO = { empresa: 'empresa', sede: 'sede', gerencia: 'gerencia' };

async function poblarValoresFiltroGrupo() {
  const tipo = document.getElementById('gTipoFiltro').value;
  const grupoValorGroup = document.getElementById('grupoValorGroup');
  if (tipo === 'todos') { grupoValorGroup.style.display = 'none'; return; }
  grupoValorGroup.style.display = '';

  const campo = CAMPO_POR_TIPO_GRUPO[tipo];
  const usuarios = await DB.obtenerUsuarios();
  const valores = [...new Set(usuarios.filter(u => u.rol === 'TRABAJADOR').map(u => u[campo]).filter(Boolean))];
  const select = document.getElementById('gValorFiltro');
  select.innerHTML = valores.length
    ? valores.map(v => `<option value="${v}">${v}</option>`).join('')
    : `<option value="">No hay trabajadores con este dato</option>`;
}

async function asignarModuloAGrupo(tipo, valor) {
  const usuarios = await DB.obtenerUsuarios();
  const campo = CAMPO_POR_TIPO_GRUPO[tipo];
  const usuariosDelGrupo = tipo === 'todos'
    ? usuarios.filter(u => u.rol === 'TRABAJADOR')
    : usuarios.filter(u => u.rol === 'TRABAJADOR' && u[campo] === valor);
  await Promise.all(usuariosDelGrupo.map(u => DB.setAsignacion(u.id, grupoModuloId, true)));
  document.getElementById('modalGrupoOverlay').classList.remove('show');
  renderCapacitaciones();
  return usuariosDelGrupo.length;
}

document.getElementById('btnHabilitarGrupo').addEventListener('click', async () => {
  const tipo = document.getElementById('gTipoFiltro').value;
  const valor = document.getElementById('gValorFiltro').value;
  const errorBox = document.getElementById('formErrorGrupo');
  if (tipo !== 'todos' && !valor) { errorBox.textContent = 'No hay ningún valor disponible para asignar.'; errorBox.classList.add('show'); return; }

  await conFeedback('Asignando módulo...', () => asignarModuloAGrupo(tipo, valor), {
    exito: tipo === 'todos' ? 'Módulo asignado a todos los trabajadores.' : `Módulo asignado a trabajadores de ${tipo} "${valor}".`,
    error: 'No se pudo asignar el módulo.'
  });
});

// ---------------------------------------------------------------
// ADMIN: Usuarios
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Agregado de progreso por trabajador (usado por la tabla Usuarios):
// cruza asignaciones + historial + módulos para cada trabajador y
// calcula un estado/puntaje/inicio/fin consolidados, más el detalle
// fila por fila para el acordeón.
// ---------------------------------------------------------------
function formatoFechaHora(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function datosProgresoTrabajadores() {
  const [usuarios, asignaciones, historial, modulos] = await Promise.all([
    DB.obtenerUsuarios(), DB.obtenerAsignaciones(), DB.obtenerHistorial(), DB.obtenerModulos()
  ]);
  const trabajadores = usuarios.filter(u => u.rol === 'TRABAJADOR');
  const modulosPorId = new Map(modulos.map(m => [m.id, m]));
  const historialPorClave = new Map(historial.map(h => [`${h.usuarioId}_${h.moduloId}`, h]));

  return trabajadores.map(u => {
    const filas = asignaciones
      .filter(a => a.usuarioId === u.id && a.habilitado)
      .map(a => modulosPorId.get(a.moduloId))
      .filter(Boolean)
      .map(m => {
        const hist = historialPorClave.get(`${u.id}_${m.id}`) || null;
        const estado = hist ? hist.estado : 'PENDIENTE';
        return { modulo: m, hist, estado, puntaje: estado === 'COMPLETADO' ? (hist.puntaje ?? null) : null };
      });

    const completados = filas.filter(f => f.estado === 'COMPLETADO');
    const enProgreso = filas.filter(f => f.estado === 'EN_PROGRESO');
    const estadoGlobal = filas.length === 0 ? 'SIN_MODULOS'
      : completados.length === filas.length ? 'COMPLETADO'
      : (enProgreso.length > 0 || completados.length > 0) ? 'EN_PROGRESO' : 'PENDIENTE';

    // Puntaje promedio de TODOS los módulos asignados (los no iniciados
    // cuentan como 0 — decisión de producto confirmada).
    const puntajeProm = filas.length ? Math.round(filas.reduce((s, f) => s + (f.puntaje ?? 0), 0) / filas.length) : null;
    const inicios = filas.map(f => f.hist && f.hist.fechaInicio).filter(Boolean).sort();
    const fines = filas.map(f => f.hist && f.hist.fechaFin).filter(Boolean).sort();
    const fin = (filas.length > 0 && completados.length === filas.length) ? (fines[fines.length - 1] || null) : null;

    return { usuario: u, filas, estadoGlobal, puntajeProm, inicio: inicios[0] || null, fin };
  });
}

const ETIQUETA_ESTADO_GLOBAL = {
  COMPLETADO: { texto: 'Completado', clase: 'badge-activo' },
  EN_PROGRESO: { texto: 'En progreso', clase: 'badge-progreso' },
  PENDIENTE: { texto: 'Pendiente', clase: 'badge-inactivo' },
  SIN_MODULOS: { texto: 'Sin módulos', clase: 'badge-inactivo' }
};

const USUARIOS_POR_PAGINA = 10;
let paginaUsuarios = 1;
let filasExpandidas = new Set();
let cacheDatosUsuarios = []; // último resultado de datosProgresoTrabajadores(), para el menú de acciones y el acordeón

async function renderUsuarios() {
  renderSidebarAdmin('usuarios');
  document.getElementById('pageTitle').textContent = 'Usuarios';
  document.getElementById('pageSubtitle').textContent = 'Gestión de trabajadores y su progreso en los módulos';
  paginaUsuarios = 1;
  filasExpandidas = new Set();

  const datos = await datosProgresoTrabajadores();
  cacheDatosUsuarios = datos;
  const trabajadores = datos.map(d => d.usuario);
  const activos = trabajadores.filter(u => u.estado === 'ACTIVO').length;

  const empresas = [...new Set(trabajadores.map(u => u.empresa).filter(Boolean))].sort();
  const sedes = [...new Set(trabajadores.map(u => u.sede).filter(Boolean))].sort();
  const gerencias = [...new Set(trabajadores.map(u => u.gerencia).filter(Boolean))].sort();

  document.getElementById('content').innerHTML = `
    <div class="stat-grid-usuarios">
      <div class="stat-card"><div class="stat-icon" style="background:var(--blue-100);color:var(--blue-600);"><i data-lucide="users" size="18"></i></div><div><div class="num">${trabajadores.length}</div><div class="label">Total</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--green-100);color:var(--green-500);"><i data-lucide="check-circle-2" size="18"></i></div><div><div class="num">${activos}</div><div class="label">Activos</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--gray-100);color:var(--gray-500);"><i data-lucide="x-circle" size="18"></i></div><div><div class="num">${trabajadores.length - activos}</div><div class="label">Inactivos</div></div></div>
    </div>

    <div class="filters-bar">
      <input type="text" id="buscarUsuario" placeholder="Buscar por nombre, correo o DNI...">
      <select id="filtroEmpresa"><option value="">Todas las empresas</option>${empresas.map(e => `<option value="${e}">${e}</option>`).join('')}</select>
      <select id="filtroSede"><option value="">Todas las sedes</option>${sedes.map(s => `<option value="${s}">${s}</option>`).join('')}</select>
      <select id="filtroGerencia"><option value="">Todas las gerencias</option>${gerencias.map(g => `<option value="${g}">${g}</option>`).join('')}</select>
      <button class="btn-outline" id="btnLimpiarFiltrosUsuarios">Limpiar filtros</button>
    </div>
    <div class="toolbar">
      <div class="toolbar-right" style="width:100%;">
        <button class="btn-outline" onclick="abrirModalImportar()"><i data-lucide="upload" size="15"></i> Importar datos</button>
        <button class="btn-outline" onclick="exportarUsuariosExcel()"><i data-lucide="download" size="15"></i> Exportar datos</button>
        <button class="btn-outline" onclick="renderUsuarios()"><i data-lucide="refresh-cw" size="15"></i> Actualizar datos</button>
        <button class="btn-save" style="display:flex;align-items:center;gap:7px;" onclick="abrirModalUsuario()"><i data-lucide="plus" size="16"></i> Nuevo trabajador</button>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th></th><th>Trabajador</th><th>Correo</th><th style="text-align:center;">Empresa</th><th style="text-align:center;">Sede</th><th style="text-align:center;">Gerencia</th><th style="text-align:center;">Estado</th><th style="text-align:center;">Puntaje</th><th style="text-align:center;">Acciones</th>
        </tr></thead>
        <tbody id="tablaUsuariosBody"></tbody>
      </table>
    </div>
    <div class="paginacion" id="paginacionUsuarios" style="display:flex;justify-content:center;gap:8px;margin-top:16px;"></div>
  `;

  const aplicarFiltrosUsuarios = () => {
    const q = document.getElementById('buscarUsuario').value.toLowerCase();
    const empresa = document.getElementById('filtroEmpresa').value;
    const sede = document.getElementById('filtroSede').value;
    const gerencia = document.getElementById('filtroGerencia').value;
    const filtrados = datos.filter(({ usuario: u }) =>
      (nombreCompleto(u).toLowerCase().includes(q) || u.correo.toLowerCase().includes(q) || u.dni.includes(q)) &&
      (!empresa || u.empresa === empresa) && (!sede || u.sede === sede) && (!gerencia || u.gerencia === gerencia)
    );
    paginaUsuarios = 1;
    pintarFilasUsuarios(filtrados);
  };
  pintarFilasUsuarios(datos);
  ['buscarUsuario', 'filtroEmpresa', 'filtroSede', 'filtroGerencia'].forEach(id => {
    document.getElementById(id).addEventListener('input', aplicarFiltrosUsuarios);
  });
  document.getElementById('btnLimpiarFiltrosUsuarios').addEventListener('click', () => {
    document.getElementById('buscarUsuario').value = '';
    document.getElementById('filtroEmpresa').value = '';
    document.getElementById('filtroSede').value = '';
    document.getElementById('filtroGerencia').value = '';
    aplicarFiltrosUsuarios();
  });
  lucide.createIcons();
}

function pintarFilasUsuarios(lista) {
  cacheDatosUsuarios = lista;
  const tbody = document.getElementById('tablaUsuariosBody');
  const paginacion = document.getElementById('paginacionUsuarios');

  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--gray-500);padding:30px;">No se encontraron trabajadores.</td></tr>`;
    paginacion.innerHTML = '';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(lista.length / USUARIOS_POR_PAGINA));
  paginaUsuarios = Math.min(paginaUsuarios, totalPaginas);
  const inicio = (paginaUsuarios - 1) * USUARIOS_POR_PAGINA;
  const paginaActual = lista.slice(inicio, inicio + USUARIOS_POR_PAGINA);

  tbody.innerHTML = paginaActual.map(d => {
    const u = d.usuario;
    const abierta = filasExpandidas.has(u.id);
    const estadoInfo = ETIQUETA_ESTADO_GLOBAL[d.estadoGlobal];
    const filaAcordeon = abierta ? `
      <tr class="subtabla-modulos">
        <td colspan="9">
          <table class="tabla-modulos-usuario">
            <thead><tr><th style="text-align:left;">Módulo</th><th style="text-align:center;">Estado</th><th style="text-align:center;">Puntaje</th><th style="text-align:center;">Inicio</th><th style="text-align:center;">Fin</th><th style="text-align:center;">Certificado</th></tr></thead>
            <tbody>
              ${d.filas.length ? d.filas.map(f => `
                <tr style="height:56px;">
                  <td style="vertical-align:middle;text-align:left;"><div style="display:flex;align-items:center;justify-content:flex-start;gap:8px;">${chipModulo(f.modulo, 26, 10, 1.5)} ${f.modulo.nombre}</div></td>
                  <td style="vertical-align:middle;text-align:center;"><span class="badge ${f.estado==='COMPLETADO'?'badge-activo':'badge-inactivo'}">${f.estado==='COMPLETADO'?'Completado':f.estado==='EN_PROGRESO'?'En progreso':'Pendiente'}</span></td>
                  <td style="vertical-align:middle;text-align:center;">${f.puntaje ?? '-'}</td>
                  <td style="vertical-align:middle;text-align:center;">${formatoFechaHora(f.hist && f.hist.fechaInicio)}</td>
                  <td style="vertical-align:middle;text-align:center;">${formatoFechaHora(f.hist && f.hist.fechaFin)}</td>
                  <td style="vertical-align:middle;"><div style="display:flex;justify-content:center;align-items:center;">${f.estado === 'COMPLETADO' && f.modulo.certificadoUrl
                    ? `<button class="icon-btn primary-outline" style="flex:0 0 auto;" onclick="descargarCertificadoDeUsuario('${u.id}','${f.modulo.id}')"><i data-lucide="download" size="13"></i> Descargar</button>`
                    : '<span style="color:var(--gray-400);font-size:.76rem;">-</span>'}</div></td>
                </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);">Sin módulos asignados.</td></tr>`}
            </tbody>
          </table>
        </td>
      </tr>` : '';

    return `
    <tr class="fila-trabajador" onclick="toggleFilaAcordeon('${u.id}')">
      <td><i data-lucide="chevron-right" size="16" class="fila-acordeon-icon ${abierta ? 'abierto' : ''}"></i></td>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="avatar" style="width:34px;height:34px;font-size:.7rem;flex-shrink:0;${u.fotoUrl ? `background-image:url('${u.fotoUrl}');background-size:cover;` : ''}">${u.fotoUrl ? '' : (u.primerNombre[0] + u.apellidoPaterno[0]).toUpperCase()}</div>
          <div>
            <div style="font-weight:700;font-size:.85rem;color:var(--gray-900);">${nombreCompleto(u)}</div>
            <div style="font-size:.72rem;color:var(--gray-500);">${u.rol === 'ADMIN' ? 'ADMINISTRADOR' : 'TRABAJADOR'} · DNI ${u.dni}</div>
          </div>
        </div>
      </td>
      <td>${u.correo}</td>
      <td style="text-align:center;">${u.empresa || '-'}</td>
      <td style="text-align:center;">${u.sede || '-'}</td>
      <td style="text-align:center;">${u.gerencia || '-'}</td>
      <td style="text-align:center;"><span class="badge ${estadoInfo.clase}">${estadoInfo.texto}</span></td>
      <td style="text-align:center;">${d.puntajeProm ?? '-'}${d.puntajeProm != null ? '%' : ''}</td>
      <td onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:center;align-items:center;">
          <button class="icon-btn" style="flex:0 0 auto;" onclick="toggleMenuAcciones(event,'${u.id}')" title="Acciones"><i data-lucide="more-vertical" size="16"></i></button>
        </div>
      </td>
    </tr>
    ${filaAcordeon}
  `;
  }).join('');

  paginacion.innerHTML = totalPaginas > 1 ? `
    <button class="icon-btn" ${paginaUsuarios===1?'disabled':''} onclick="cambiarPaginaUsuarios(${paginaUsuarios-1})"><i data-lucide="chevron-left" size="15"></i></button>
    <span style="font-size:.82rem;color:var(--gray-500);align-self:center;">Página ${paginaUsuarios} de ${totalPaginas}</span>
    <button class="icon-btn" ${paginaUsuarios===totalPaginas?'disabled':''} onclick="cambiarPaginaUsuarios(${paginaUsuarios+1})"><i data-lucide="chevron-right" size="15"></i></button>
  ` : '';
  lucide.createIcons();
}

function cambiarPaginaUsuarios(n) {
  paginaUsuarios = n;
  pintarFilasUsuarios(cacheDatosUsuarios);
}

function toggleFilaAcordeon(id) {
  if (filasExpandidas.has(id)) filasExpandidas.delete(id); else filasExpandidas.add(id);
  pintarFilasUsuarios(cacheDatosUsuarios);
}

// Menú de Acciones: un solo botón por fila, un único elemento flotante
// compartido (fuera del overflow de la tabla) que se reposiciona y
// repuebla según el trabajador clickeado.
function toggleMenuAcciones(evento, usuarioId) {
  evento.stopPropagation();
  const menu = document.getElementById('menuAccionesFlotante');
  const yaAbiertoParaEste = menu.dataset.usuarioId === usuarioId && !menu.classList.contains('hidden');
  menu.classList.add('hidden');
  if (yaAbiertoParaEste) { menu.dataset.usuarioId = ''; return; }

  const d = cacheDatosUsuarios.find(x => x.usuario.id === usuarioId);
  if (!d) return;
  const u = d.usuario;
  const nombreEsc = nombreCompleto(u).replace(/'/g, "\\'");

  menu.innerHTML = `
    <button onclick="abrirModalAsignar('${u.id}')"><i data-lucide="book-open" size="14"></i> Asignar módulos</button>
    <button onclick="editarUsuario('${u.id}')"><i data-lucide="pencil" size="14"></i> Editar</button>
    <button onclick="toggleEstadoUsuario('${u.id}')"><i data-lucide="power" size="14"></i> ${u.estado === 'ACTIVO' ? 'Inactivar' : 'Activar'}</button>
    <button class="danger" onclick="eliminarUsuario('${u.id}','${nombreEsc}')"><i data-lucide="trash-2" size="14"></i> Eliminar</button>
  `;
  const rect = evento.currentTarget.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - 190)}px`;
  menu.dataset.usuarioId = usuarioId;
  menu.classList.remove('hidden');
  lucide.createIcons();
}
document.addEventListener('click', () => {
  const menu = document.getElementById('menuAccionesFlotante');
  menu.classList.add('hidden');
  menu.dataset.usuarioId = '';
});

async function descargarCertificadoDeUsuario(usuarioId, moduloId) {
  await conFeedback('Generando certificado...', async () => {
    const [usuario, modulo, hist] = await Promise.all([
      DB.obtenerUsuario(usuarioId), DB.obtenerModulo(moduloId), DB.obtenerHistorialRegistro(usuarioId, moduloId)
    ]);
    if (!usuario || !modulo || !hist) throw new Error('No se encontró el registro de este módulo para este trabajador.');
    await descargarCertificadoAdmin(usuario, modulo, hist.fechaFin);
  }, { exito: 'Certificado descargado.', error: 'No se pudo generar el certificado.' });
}

async function toggleEstadoUsuario(id) {
  await conFeedback('Actualizando estado...', async () => {
    const u = await DB.obtenerUsuario(id);
    await DB.actualizarUsuario(id, { estado: u.estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO' });
    renderUsuarios();
  }, { exito: 'Estado actualizado.', error: 'No se pudo actualizar el estado.' });
}

async function eliminarUsuario(id, nombre) {
  if (!confirm(`¿Eliminar a ${nombre}? Se borran sus asignaciones e historial. Esta acción no se puede deshacer.\n\nNota: la cuenta de acceso (Firebase Auth) de esta persona no se elimina automáticamente — requiere Admin SDK, fuera de alcance de esta versión.`)) return;
  await conFeedback('Eliminando trabajador...', async () => {
    await DB.eliminarUsuario(id);
    renderUsuarios();
  }, { exito: `${nombre} eliminado correctamente.`, error: 'No se pudo eliminar el trabajador.' });
}

// Modal nuevo/editar trabajador
const modalUsuarioOverlay = document.getElementById('modalUsuarioOverlay');
function abrirModalUsuario() {
  document.getElementById('modalUsuarioTitulo').textContent = 'Nuevo trabajador';
  document.getElementById('formUsuario').reset();
  document.getElementById('uId').value = '';
  document.getElementById('uDni').disabled = false;
  document.getElementById('grupoUPassword').style.display = '';
  document.getElementById('formErrorUsuario').classList.remove('show');
  modalUsuarioOverlay.classList.add('show');
}
async function editarUsuario(id) {
  const u = await DB.obtenerUsuario(id);
  document.getElementById('modalUsuarioTitulo').textContent = 'Editar trabajador';
  document.getElementById('uId').value = u.id;
  document.getElementById('uPrimerNombre').value = u.primerNombre;
  document.getElementById('uSegundoNombre').value = u.segundoNombre || '';
  document.getElementById('uApellidoPaterno').value = u.apellidoPaterno;
  document.getElementById('uApellidoMaterno').value = u.apellidoMaterno || '';
  document.getElementById('uDni').value = u.dni;
  document.getElementById('uDni').disabled = true; // el DNI es el ID del documento; no se puede editar
  // Cambiar la contraseña de otro usuario requiere Admin SDK/Cloud
  // Functions (fuera de alcance): se oculta el campo al editar. El
  // trabajador cambia su propia contraseña en Perfil, o usa "Restablecer
  // contraseña" en el login.
  document.getElementById('grupoUPassword').style.display = 'none';
  document.getElementById('uPassword').value = '';
  document.getElementById('uPassword').placeholder = 'Dejar en blanco para no cambiarla';
  document.getElementById('uCorreo').value = u.correo;
  document.getElementById('uEmpresa').value = u.empresa || '';
  document.getElementById('uSede').value = u.sede || '';
  document.getElementById('uGerencia').value = u.gerencia || '';
  document.getElementById('formErrorUsuario').classList.remove('show');
  modalUsuarioOverlay.classList.add('show');
}
document.getElementById('btnCancelarUsuario').addEventListener('click', () => modalUsuarioOverlay.classList.remove('show'));

document.getElementById('formUsuario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const idExistente = document.getElementById('uId').value;
  const primerNombre = document.getElementById('uPrimerNombre').value.trim();
  const segundoNombre = document.getElementById('uSegundoNombre').value.trim();
  const apellidoPaterno = document.getElementById('uApellidoPaterno').value.trim();
  const apellidoMaterno = document.getElementById('uApellidoMaterno').value.trim();
  const dni = document.getElementById('uDni').value.trim();
  let password = document.getElementById('uPassword').value.trim();
  const correo = document.getElementById('uCorreo').value.trim().toLowerCase();
  const empresa = document.getElementById('uEmpresa').value.trim();
  const sede = document.getElementById('uSede').value.trim();
  const gerencia = document.getElementById('uGerencia').value.trim();
  const errorBox = document.getElementById('formErrorUsuario');
  errorBox.classList.remove('show');

  const botonGuardar = e.target.querySelector('button[type=submit]');
  botonGuardar.disabled = true;
  mostrarCargando(idExistente ? 'Guardando cambios...' : 'Creando cuenta del trabajador...');

  try {
    if (!idExistente) {
      const yaExiste = await DB.obtenerUsuario(dni);
      if (yaExiste) {
        ocultarCargando();
        errorBox.textContent = `Ya existe un usuario con el DNI ${dni}.`; errorBox.classList.add('show'); return;
      }
      if (!password) password = dni;

      await crearCuentaAuthParaUsuario(correo, password);
      await DB.crearUsuario(dni, {
        primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, correo, empresa, sede, gerencia,
        rol: 'TRABAJADOR', estado: 'ACTIVO', debeCambiarPassword: password === dni
      });
    } else {
      const datos = { primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, correo, empresa, sede, gerencia };
      await DB.actualizarUsuario(idExistente, datos);
      // Cambiar la contraseña de otro usuario desde el panel admin requeriría
      // Admin SDK/Cloud Functions (fuera de alcance): si el admin necesita
      // resetear la contraseña de alguien, usa "Restablecer contraseña" en
      // el login con el DNI de esa persona (envía el enlace a su correo).
    }
    ocultarCargando();
    toast('exito', idExistente ? 'Trabajador actualizado.' : 'Trabajador creado correctamente.');
    modalUsuarioOverlay.classList.remove('show');
    renderUsuarios();
  } catch (err) {
    console.error('Guardar usuario:', err);
    ocultarCargando();
    const msg = err.code === 'auth/email-already-in-use' ? 'Ya existe una cuenta con ese correo.' : (err.message || 'No se pudo guardar el usuario.');
    errorBox.textContent = msg;
    errorBox.classList.add('show');
    toast('error', msg);
  } finally {
    botonGuardar.disabled = false;
  }
});

// ---------------------------------------------------------------
// Drawer lateral: asignar módulos a un usuario puntual (Imagen 2)
// ---------------------------------------------------------------
let drawerUsuarioId = null;
let drawerSeleccionPendiente = new Set();
let drawerTabActual = 'asignar';
let drawerFiltroTexto = '';
let drawerModulosCache = null;

async function abrirModalAsignar(usuarioId) {
  const [usuario, asignaciones, modulos] = await Promise.all([DB.obtenerUsuario(usuarioId), DB.obtenerAsignacionesUsuario(usuarioId), DB.obtenerModulos()]);
  drawerUsuarioId = usuarioId;
  drawerTabActual = 'asignar';
  drawerFiltroTexto = '';
  drawerModulosCache = modulos;
  drawerSeleccionPendiente = new Set(asignaciones.filter(a => a.habilitado).map(a => a.moduloId));

  document.getElementById('drawerAsignarUsuario').innerHTML = `
    <div class="avatar" style="width:44px;height:44px;flex-shrink:0;">${(usuario.primerNombre[0] + usuario.apellidoPaterno[0]).toUpperCase()}</div>
    <div>
      <strong style="display:block;font-size:.92rem;color:var(--navy-900);">${nombreCompleto(usuario)}</strong>
      <div style="font-size:.78rem;color:var(--gray-500);">${usuario.correo}</div>
      <div style="font-size:.78rem;color:var(--gray-500);">DNI: ${usuario.dni}</div>
    </div>
  `;

  document.getElementById('tabAsignarModulos').classList.add('active');
  document.getElementById('tabAsignacionesActuales').classList.remove('active');
  renderDrawerAsignarBody();
  document.getElementById('drawerAsignarOverlay').classList.add('show');
  lucide.createIcons();
}

function cambiarTabDrawerAsignar(tab) {
  drawerTabActual = tab;
  document.getElementById('tabAsignarModulos').classList.toggle('active', tab === 'asignar');
  document.getElementById('tabAsignacionesActuales').classList.toggle('active', tab === 'actuales');
  renderDrawerAsignarBody();
}

function renderDrawerAsignarBody() {
  const body = document.getElementById('drawerAsignarBody');
  const modulos = drawerModulosCache || [];

  if (drawerTabActual === 'actuales') {
    const actuales = modulos.filter(m => drawerSeleccionPendiente.has(m.id));
    body.innerHTML = actuales.length
      ? actuales.map(m => `
        <div class="modulo-check-card">
          ${chipModulo(m, 32, 15)}
          <div style="flex:1;"><strong>${m.nombre}</strong><div style="font-size:.74rem;color:var(--gray-500);">${m.categoria || 'Sin categoría'}</div></div>
        </div>`).join('')
      : `<div class="empty-state"><p>Sin asignaciones actuales.</p></div>`;
  } else {
    const filtrados = modulos.filter(m => m.nombre.toLowerCase().includes(drawerFiltroTexto.toLowerCase()));
    body.innerHTML = `
      <div class="drawer-search"><input type="text" id="drawerBuscarModulo" placeholder="Buscar módulo..." value="${drawerFiltroTexto.replace(/"/g,'&quot;')}"></div>
      ${filtrados.length ? filtrados.map(m => `
        <label class="modulo-check-card">
          ${chipModulo(m, 32, 15)}
          <div style="flex:1;"><strong>${m.nombre}</strong><div style="font-size:.74rem;color:var(--gray-500);">${m.categoria || 'Sin categoría'}</div></div>
          <input type="checkbox" ${drawerSeleccionPendiente.has(m.id) ? 'checked' : ''} onchange="toggleDrawerSeleccion('${m.id}', this.checked)">
        </label>`).join('') : `<div class="empty-state"><p>No hay módulos que coincidan.</p></div>`}
    `;
    const buscador = document.getElementById('drawerBuscarModulo');
    if (buscador) {
      buscador.addEventListener('input', (e) => { drawerFiltroTexto = e.target.value; renderDrawerAsignarBody(); });
      buscador.focus();
      buscador.selectionStart = buscador.selectionEnd = buscador.value.length;
    }
  }
  actualizarResumenDrawer();
  lucide.createIcons();
}

function toggleDrawerSeleccion(moduloId, marcado) {
  if (marcado) drawerSeleccionPendiente.add(moduloId); else drawerSeleccionPendiente.delete(moduloId);
  actualizarResumenDrawer();
}

function actualizarResumenDrawer() {
  document.getElementById('contadorAsignacionesActuales').textContent = drawerSeleccionPendiente.size;
  document.getElementById('drawerResumenAsignacion').innerHTML = `
    <strong>Resumen de asignación</strong>
    <p>Seleccionados: ${drawerSeleccionPendiente.size} módulo(s)</p>
    <p style="font-size:.74rem;color:var(--gray-500);">El usuario tendrá acceso a los módulos seleccionados.</p>
  `;
}

document.getElementById('btnCerrarDrawerAsignar').addEventListener('click', () => document.getElementById('drawerAsignarOverlay').classList.remove('show'));
document.getElementById('btnCancelarDrawerAsignar').addEventListener('click', () => document.getElementById('drawerAsignarOverlay').classList.remove('show'));

document.getElementById('btnGuardarDrawerAsignar').addEventListener('click', async () => {
  await conFeedback('Guardando asignaciones...', async () => {
    const modulos = drawerModulosCache || [];
    await Promise.all(modulos.map(m => DB.setAsignacion(drawerUsuarioId, m.id, drawerSeleccionPendiente.has(m.id))));
    document.getElementById('drawerAsignarOverlay').classList.remove('show');
    renderUsuarios();
  }, { exito: 'Asignaciones guardadas.', error: 'No se pudo guardar las asignaciones.' });
});

// ---------------------------------------------------------------
// Importar Excel — crea también la cuenta de Firebase Auth de cada
// usuario nuevo (no se puede hacer en lote del lado del servidor sin
// Cloud Functions, así que se crea una por una).
// ---------------------------------------------------------------
function abrirModalImportar() {
  document.getElementById('fExcel').value = '';
  document.getElementById('nombreExcel').textContent = '';
  document.getElementById('formErrorImportar').classList.remove('show');
  document.getElementById('formSuccessImportar').classList.remove('show');
  document.getElementById('modalImportarOverlay').classList.add('show');
}
document.getElementById('btnCancelarImportar').addEventListener('click', () => { document.getElementById('modalImportarOverlay').classList.remove('show'); renderUsuarios(); });

const fileDropExcel = document.getElementById('fileDropExcel');
const fExcel = document.getElementById('fExcel');
fileDropExcel.addEventListener('click', () => fExcel.click());
fExcel.addEventListener('change', () => {
  const f = fExcel.files[0];
  document.getElementById('nombreExcel').textContent = f ? `Seleccionado: ${f.name}` : '';
});

document.getElementById('btnProcesarImportar').addEventListener('click', () => {
  const file = fExcel.files[0];
  const errorBox = document.getElementById('formErrorImportar');
  const successBox = document.getElementById('formSuccessImportar');
  const botonProcesar = document.getElementById('btnProcesarImportar');
  errorBox.classList.remove('show'); successBox.classList.remove('show');

  if (!file) { errorBox.textContent = 'Selecciona un archivo Excel primero.'; errorBox.classList.add('show'); return; }

  const reader = new FileReader();
  reader.onload = async (e) => {
    botonProcesar.disabled = true;
    mostrarCargando('Leyendo archivo Excel...');
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const filas = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      let creados = 0, actualizados = 0, errores = 0, procesadas = 0;

      for (const fila of filas) {
        procesadas++;
        actualizarCargando(`Importando fila ${procesadas} de ${filas.length}...`);
        const nombres = String(fila['Nombres'] || '').trim();
        const apellidos = String(fila['Apellidos'] || '').trim();
        const dni = String(fila['DNI'] || '').trim();
        const empresa = String(fila['Empresa'] || '').trim();
        const sede = String(fila['Sede'] || '').trim();
        const gerencia = String(fila['Gerencia'] || '').trim();
        const estado = String(fila['Estado'] || 'ACTIVO').trim().toUpperCase();
        const rol = String(fila['Rol'] || 'TRABAJADOR').trim().toUpperCase() === 'ADMIN' ? 'ADMIN' : 'TRABAJADOR';
        let correo = String(fila['Correo'] || '').trim().toLowerCase();

        if (!nombres || !apellidos || !dni) { errores++; continue; }
        if (!correo) {
          correo = (nombres + '.' + apellidos).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,'.') + '@tramarsa.com.pe';
        }

        const partesNombres = nombres.split(/\s+/);
        const primerNombre = partesNombres[0];
        const segundoNombre = partesNombres.slice(1).join(' ');
        const partesApellidos = apellidos.split(/\s+/);
        const apellidoPaterno = partesApellidos[0];
        const apellidoMaterno = partesApellidos.slice(1).join(' ');

        try {
          const existente = await DB.obtenerUsuario(dni);
          if (existente) {
            await DB.actualizarUsuario(dni, { primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, empresa, sede, gerencia, estado, correo, rol });
            actualizados++;
          } else {
            await crearCuentaAuthParaUsuario(correo, dni);
            await DB.crearUsuario(dni, { primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, empresa, sede, gerencia, estado, correo, rol, debeCambiarPassword: true });
            creados++;
          }
        } catch (errFila) {
          console.error('Fila de importación:', dni, errFila);
          errores++;
        }
      }

      ocultarCargando();
      const resumen = `Importación completa: ${creados} creado(s), ${actualizados} actualizado(s)${errores ? `, ${errores} fila(s) con error` : ''}.`;
      successBox.textContent = resumen;
      successBox.classList.add('show');
      toast(errores ? 'error' : 'exito', resumen);
    } catch (err) {
      ocultarCargando();
      const msg = 'No se pudo procesar el archivo. Verifica que sea un Excel válido con las columnas indicadas.';
      errorBox.textContent = msg;
      errorBox.classList.add('show');
      toast('error', msg);
    } finally {
      botonProcesar.disabled = false;
    }
  };
  reader.readAsArrayBuffer(file);
});

// ---------------------------------------------------------------
// Exportar base de datos de trabajadores a Excel
// ---------------------------------------------------------------
async function exportarUsuariosExcel() {
  await conFeedback('Generando archivo Excel...', async () => {
    const datos = await datosProgresoTrabajadores();

    const filas = datos.map(({ usuario: u, estadoGlobal, puntajeProm, inicio, fin }) => ({
      'Nombres': [u.primerNombre, u.segundoNombre].filter(Boolean).join(' '),
      'Apellidos': [u.apellidoPaterno, u.apellidoMaterno].filter(Boolean).join(' '),
      'DNI': u.dni,
      'Correo': u.correo,
      'Empresa': u.empresa || '',
      'Sede': u.sede || '',
      'Gerencia': u.gerencia || '',
      'Rol': u.rol,
      'Estado cuenta': u.estado,
      'Estado módulos': ETIQUETA_ESTADO_GLOBAL[estadoGlobal].texto,
      'Puntaje promedio': puntajeProm ?? '',
      'Inicio': inicio || '',
      'Fin': fin || ''
    }));

    const ws = XLSX.utils.json_to_sheet(filas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Trabajadores');
    XLSX.writeFile(wb, `trabajadores_tramarsa_${new Date().toISOString().slice(0,10)}.xlsx`);
  }, { exito: 'Archivo Excel generado.', error: 'No se pudo generar el archivo Excel.' });
}

// ---------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------
function ocultarPantallaCarga() {
  const v = document.getElementById('viewCargando');
  if (v) v.remove();
}

window.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  if (!firebaseEstaConfigurado()) {
    document.getElementById('viewLogin').classList.remove('hidden');
    ocultarPantallaCarga();
    mostrarErrorFirebaseNoConfigurado();
    return;
  }

  // Firebase Auth restaura la sesión desde IndexedDB de forma asíncrona:
  // auth.currentUser puede seguir siendo null justo al cargar la página
  // aunque haya una sesión válida. Por eso se espera a onAuthStateChanged
  // (su primera resolución) en vez de comprobarlo de forma síncrona —
  // si no, un simple refresh mandaba de vuelta al login por error.
  // Mientras tanto se muestra #viewCargando (nunca el login): con sesión
  // válida la restauración es transparente, sin flash del formulario.
  const dejarDeEscuchar = onAuthStateChanged(auth, async (user) => {
    dejarDeEscuchar();
    let sesion = getSesion();

    // Pestaña/ventana nueva del mismo navegador: Firebase Auth ya restauró
    // la sesión real (persistencia local por defecto del SDK, compartida
    // entre pestañas — nunca se cambió a session-only acá), pero el caché
    // de UI (sessionStorage, con setSesion) es por pestaña y arranca vacío.
    // Sin esto, la app mandaba al login aunque la sesión siguiera siendo
    // válida — hay que repoblar el caché desde Firestore antes de decidir.
    if (!sesion && user) {
      try {
        const usuarios = await DB.obtenerUsuarios();
        const encontrado = usuarios.find(u => u.correo === user.email);
        if (encontrado && encontrado.estado === 'ACTIVO') {
          setSesion(encontrado);
          sesion = encontrado;
        } else {
          await signOut(auth);
        }
      } catch (e) {
        console.error('No se pudo restaurar la sesión en esta pestaña:', e);
      }
    }

    if (sesion && user) {
      await iniciarApp();
      ocultarPantallaCarga();
      return;
    }

    document.getElementById('viewLogin').classList.remove('hidden');
    ocultarPantallaCarga();

    // Bootstrap: la plataforma arranca sin ningún dato en Firestore. Si
    // todavía no existe ningún ADMIN, se ofrece crear el primero directo
    // desde el login (sin tocar la consola de Firebase a mano).
    try {
      const hayAdmin = await DB.existeAlgunAdmin();
      if (!hayAdmin) document.getElementById('cajaCrearAdminInicial').classList.remove('hidden');
    } catch (e) {
      console.error('No se pudo verificar si existe un administrador:', e);
    }
  });
});

document.getElementById('btnAbrirCrearAdmin').addEventListener('click', () => {
  document.getElementById('formCrearAdmin').reset();
  document.getElementById('formErrorCrearAdmin').classList.remove('show');
  document.getElementById('modalCrearAdminOverlay').classList.add('show');
});
document.getElementById('btnCancelarCrearAdmin').addEventListener('click', () => document.getElementById('modalCrearAdminOverlay').classList.remove('show'));

document.getElementById('formCrearAdmin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombres = document.getElementById('caNombres').value.trim();
  const apellidos = document.getElementById('caApellidos').value.trim();
  const dni = document.getElementById('caDni').value.trim();
  const password = document.getElementById('caPassword').value;
  const correo = document.getElementById('caCorreo').value.trim().toLowerCase();
  const errorBox = document.getElementById('formErrorCrearAdmin');
  errorBox.classList.remove('show');

  const boton = e.target.querySelector('button[type=submit]');
  boton.disabled = true;
  try {
    // Doble chequeo: evita crear un segundo "primer admin" por una carrera
    // entre 2 pestañas abriendo el modal al mismo tiempo.
    if (await DB.existeAlgunAdmin()) {
      errorBox.textContent = 'Ya existe un administrador. Recarga la página e inicia sesión normalmente.';
      errorBox.classList.add('show');
      return;
    }
    const [primerNombre, ...restoNombres] = nombres.split(/\s+/);
    const [apellidoPaterno, ...restoApellidos] = apellidos.split(/\s+/);

    await createUserWithEmailAndPassword(auth, correo, password);
    await DB.crearUsuario(dni, {
      primerNombre, segundoNombre: restoNombres.join(' '),
      apellidoPaterno, apellidoMaterno: restoApellidos.join(' '),
      correo, sede: '', rol: 'ADMIN', estado: 'ACTIVO', debeCambiarPassword: false
    });

    setSesion(await DB.obtenerUsuario(dni));
    document.getElementById('modalCrearAdminOverlay').classList.remove('show');
    await iniciarApp();
  } catch (err) {
    console.error('Crear administrador inicial:', err);
    errorBox.textContent = err.code === 'auth/email-already-in-use' ? 'Ya existe una cuenta con ese correo.' : (err.message || 'No se pudo crear el administrador.');
    errorBox.classList.add('show');
  } finally {
    boton.disabled = false;
  }
});

// ---------------------------------------------------------------
// Exports a window: toda la UI usa onclick="funcion(...)" inline en el
// HTML generado, y los módulos ES no exponen funciones al global scope
// automáticamente.
// ---------------------------------------------------------------
Object.assign(window, {
  cerrarSesion,
  renderDashboardTrabajador, renderMisModulosTrabajador, renderCertificadosTrabajador,
  renderPerfilTrabajador,
  renderCapacitaciones, renderUsuarios, renderConfiguracion,
  abrirModalModulo, toggleEstadoModulo, eliminarModulo, abrirModalGrupo,
  abrirModalUsuario, editarUsuario, toggleEstadoUsuario, eliminarUsuario, abrirModalAsignar,
  cambiarTabDrawerAsignar, toggleDrawerSeleccion,
  abrirModalImportar, exportarUsuariosExcel,
  toggleFilaAcordeon, toggleMenuAcciones, cambiarPaginaUsuarios, descargarCertificadoDeUsuario,
  cambiarPaginaMisModulos, cambiarPaginaCertificados,
  cambiarPaginaContinuarInicio, cambiarPaginaPendientesInicio, cambiarPaginaLogrosInicio
});
