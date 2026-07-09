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
import { archivoAJSZip, carpetaSeleccionadaAJSZip, carpetaArrastradaAJSZip, jszipAArchivoZip } from './modulo-loader/package-adapters.js';

export function nombreCompleto(u) {
  return [u.primerNombre, u.segundoNombre, u.apellidoPaterno, u.apellidoMaterno].filter(Boolean).join(' ');
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
  sessionStorage.removeItem('tramarsa_sesion');
  await signOut(auth).catch(() => {});
  location.reload();
}

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
  document.getElementById('viewApp').classList.remove('hidden');

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

  if (usuario.rol === 'ADMIN') {
    await renderCapacitaciones();
  } else {
    await renderDashboardTrabajador();
  }
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
  const items = [
    { key:'inicio', label:'Inicio', icon:'home', fn:'renderDashboardTrabajador' },
    { key:'modulos', label:'Mis módulos', icon:'book-open', fn:'renderMisModulosTrabajador' },
    { key:'certificados', label:'Certificados', icon:'award', fn:'renderCertificadosTrabajador' },
    { key:'progreso', label:'Mi progreso', icon:'trending-up', fn:'renderProgresoTrabajador' },
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
      <div class="icn" style="background:${color.bg};color:${color.fg};"><i data-lucide="${item.estado === 'COMPLETADO' ? 'check-circle-2' : item.estado === 'EN_PROGRESO' ? 'clock' : 'book-open'}" size="18"></i></div>
      <div style="flex:1;">
        <h4>${m.nombre}</h4>
        <p>${m.categoria ? m.categoria + ' · ' : ''}${estadoTexto}</p>
        ${item.estado !== 'COMPLETADO' && item.avance > 0 ? `<div class="barra-progreso-mini"><div class="barra-progreso-mini-fill" style="width:${item.avance}%;background:${color.fg};"></div></div>` : ''}
      </div>
      ${boton}
    </div>`;
}

export async function renderDashboardTrabajador() {
  renderSidebarTrabajador('inicio');
  document.getElementById('pageTitle').textContent = 'Inicio';
  document.getElementById('pageSubtitle').textContent = '';
  const { usuario, items, completados, enProgreso, pendientes } = await datosCapacitacionesTrabajador();
  const total = items.length;
  const pctGeneral = total ? Math.round((completados.length / total) * 100) : 0;
  const pendientesOEnProgreso = items.filter(i => i.estado !== 'COMPLETADO');

  document.getElementById('content').innerHTML = `
    <div class="welcome-row">
      <h1>¡Bienvenido, ${usuario.primerNombre}!</h1>
      <p>Continúa con tu desarrollo profesional. Tu progreso nos impulsa a seguir creciendo.</p>
    </div>
    ${total ? `
    <div class="panel" style="display:flex;align-items:center;gap:24px;margin-bottom:20px;flex-wrap:wrap;">
      <div class="progreso-ring" style="--pct:${pctGeneral};"><span>${pctGeneral}%</span></div>
      <div>
        <h2 style="font-size:1rem;font-weight:800;color:var(--navy-900);">Progreso general</h2>
        <p style="font-size:.85rem;color:var(--gray-500);">${completados.length} de ${total} módulo(s) completado(s)</p>
      </div>
    </div>` : ''}
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-icon" style="background:var(--blue-100);color:var(--blue-600);"><i data-lucide="graduation-cap" size="18"></i></div><div><div class="num">${enProgreso.length}</div><div class="label">En progreso</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--green-100);color:var(--green-500);"><i data-lucide="check-circle-2" size="18"></i></div><div><div class="num">${completados.length}</div><div class="label">Completadas</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--orange-100);color:var(--orange-500);"><i data-lucide="clock" size="18"></i></div><div><div class="num">${pendientes.length}</div><div class="label">Pendientes</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--purple-100);color:var(--purple-500);"><i data-lucide="award" size="18"></i></div><div><div class="num">${completados.length}</div><div class="label">Certificados</div></div></div>
    </div>
    ${pendientesOEnProgreso.length ? `
    <div class="panel">
      <div class="panel-head"><h2>Mis capacitaciones</h2></div>
      <div id="listaModulosTrabajador"></div>
    </div>` : ''}
  `;

  if (pendientesOEnProgreso.length) {
    document.getElementById('listaModulosTrabajador').innerHTML = pendientesOEnProgreso.map(i => filaModuloTrabajador(i, false)).join('');
  } else if (total === 0) {
    document.getElementById('content').insertAdjacentHTML('beforeend', `
      <div class="panel"><div class="empty-state">
        <i data-lucide="inbox" size="30"></i>
        <p>No existen módulos asignados.<br>Cuando el administrador te habilite una capacitación, aparecerá aquí.</p>
      </div></div>`);
  }
  lucide.createIcons();
}

let filtroMisModulos = 'todos';
async function renderMisModulosTrabajador(filtro) {
  if (filtro) filtroMisModulos = filtro;
  renderSidebarTrabajador('modulos');
  document.getElementById('pageTitle').textContent = 'Mis módulos';
  document.getElementById('pageSubtitle').textContent = 'Todas tus capacitaciones asignadas';

  const { items, completados, enProgreso, pendientes } = await datosCapacitacionesTrabajador();
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

  document.getElementById('content').innerHTML = `
    <div class="stat-grid">
      ${tarjetas.map(t => `
        <div class="stat-card stat-filtro ${filtroMisModulos===t.key?'active':''}" style="--activo-color:${t.fg};" onclick="renderMisModulosTrabajador('${t.key}')">
          <div class="stat-icon" style="background:${t.bg};color:${t.fg};"><i data-lucide="${t.icon}" size="18"></i></div>
          <div><div class="num">${t.num}</div><div class="label">${t.label}</div></div>
        </div>`).join('')}
    </div>
    <div class="panel"><div id="listaMisModulos"></div></div>
  `;

  document.getElementById('listaMisModulos').innerHTML = filtrados.length
    ? filtrados.map(i => filaModuloTrabajador(i, true)).join('')
    : `<div class="empty-state"><i data-lucide="inbox" size="30"></i><p>No hay módulos en esta categoría.</p></div>`;
  lucide.createIcons();
}

async function renderCertificadosTrabajador() {
  renderSidebarTrabajador('certificados');
  document.getElementById('pageTitle').textContent = 'Certificados';
  document.getElementById('pageSubtitle').textContent = 'Certificados obtenidos por capacitaciones completadas';
  const { completados } = await datosCapacitacionesTrabajador();

  document.getElementById('content').innerHTML = `<div class="panel"><div id="listaCertificados"></div></div>`;
  document.getElementById('listaCertificados').innerHTML = completados.length
    ? completados.map(i => `
      <div class="modulo-asignado-item">
        <div class="icn"><i data-lucide="award" size="18"></i></div>
        <div style="flex:1;">
          <h4>${i.modulo.nombre}</h4>
          <p>Completado el ${new Date(i.hist.fechaFin).toLocaleDateString('es-PE')} — puntaje ${i.hist.puntaje ?? '-'}%</p>
        </div>
        <button class="icon-btn primary-outline" onclick="verCertificadoStandalone('${i.modulo.id}', renderCertificadosTrabajador)"><i data-lucide="download" size="13"></i> Ver / descargar</button>
      </div>`).join('')
    : `<div class="empty-state"><i data-lucide="award" size="30"></i><p>Todavía no tienes certificados. Completa una capacitación para obtener el primero.</p></div>`;
  lucide.createIcons();
}

async function renderProgresoTrabajador() {
  renderSidebarTrabajador('progreso');
  document.getElementById('pageTitle').textContent = 'Mi progreso';
  document.getElementById('pageSubtitle').textContent = '';
  const { items, completados } = await datosCapacitacionesTrabajador();
  const total = items.length;
  const pctGeneral = total ? Math.round((completados.length / total) * 100) : 0;

  document.getElementById('content').innerHTML = `
    <div class="panel" style="display:flex;align-items:center;gap:24px;margin-bottom:20px;flex-wrap:wrap;">
      <div class="progreso-ring" style="--pct:${pctGeneral};"><span>${pctGeneral}%</span></div>
      <div>
        <h2 style="font-size:1rem;font-weight:800;color:var(--navy-900);">Avance general</h2>
        <p style="font-size:.85rem;color:var(--gray-500);">${completados.length} de ${total} módulo(s) completado(s)</p>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Detalle por módulo</h2></div>
      <div id="listaProgreso"></div>
    </div>
  `;
  document.getElementById('listaProgreso').innerHTML = items.length
    ? items.map(i => `
      <div class="modulo-asignado-item">
        <div style="flex:1;">
          <h4>${i.modulo.nombre}</h4>
          <div class="barra-progreso-mini"><div class="barra-progreso-mini-fill" style="width:${i.avance}%;"></div></div>
        </div>
        <span style="font-size:.8rem;font-weight:700;color:var(--gray-700);min-width:40px;text-align:right;">${i.avance}%</span>
      </div>`).join('')
    : `<div class="empty-state"><i data-lucide="inbox" size="30"></i><p>No tienes módulos asignados todavía.</p></div>`;
  lucide.createIcons();
}

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
  const items = [
    { key:'capacitaciones', label:'Capacitaciones', icon:'book-open', fn:'renderCapacitaciones' },
    { key:'usuarios', label:'Usuarios', icon:'users', fn:'renderUsuarios' },
    { key:'asignaciones', label:'Asignaciones', icon:'link-2', fn:'renderAsignaciones' },
    { key:'reportes', label:'Reportes', icon:'bar-chart-3', fn:'renderReportes' },
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
async function renderAsignaciones() {
  renderSidebarAdmin('asignaciones');
  document.getElementById('pageTitle').textContent = 'Asignaciones';
  document.getElementById('pageSubtitle').textContent = 'Qué módulo tiene habilitado cada trabajador';
  const [modulos, usuarios, asignaciones] = await Promise.all([DB.obtenerModulos(), DB.obtenerUsuarios(), DB.obtenerAsignaciones()]);
  const trabajadores = usuarios.filter(u => u.rol === 'TRABAJADOR');

  document.getElementById('content').innerHTML = `<div class="grid-modulos" id="gridAsignaciones"></div>`;
  const grid = document.getElementById('gridAsignaciones');

  if (modulos.length === 0) {
    grid.innerHTML = `<div class="empty-modulos"><i data-lucide="link-2" size="36"></i><p>Todavía no hay módulos creados.</p></div>`;
  } else {
    grid.innerHTML = modulos.map(m => {
      const asignados = asignaciones.filter(a => a.moduloId === m.id && a.habilitado)
        .map(a => trabajadores.find(u => u.id === a.usuarioId)).filter(Boolean);
      return `
      <div class="modulo-card">
        <div class="modulo-cover"><i data-lucide="link-2" size="26"></i></div>
        <div class="modulo-body">
          <h3>${m.nombre}</h3>
          <p>${asignados.length} trabajador(es) habilitado(s)</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:2px;">
            ${asignados.length
              ? asignados.slice(0, 6).map(u => `<span class="badge-mini activo">${u.primerNombre}</span>`).join('') + (asignados.length > 6 ? `<span class="badge-mini inactivo">+${asignados.length - 6}</span>` : '')
              : '<span style="font-size:.76rem;color:var(--gray-400);">Sin asignaciones todavía</span>'}
          </div>
        </div>
        <div class="modulo-actions">
          <button class="icon-btn primary-outline" onclick="abrirModalGrupo('${m.id}','${m.nombre.replace(/'/g,"\\'")}')"><i data-lucide="users-round" size="13"></i> Asignar por área/sede</button>
        </div>
      </div>`;
    }).join('');
  }
  lucide.createIcons();
}

// ---------------------------------------------------------------
// ADMIN: Reportes
// ---------------------------------------------------------------
let filtroReporteEstado = '';
let cacheReportes = null;
async function renderReportes(filtro) {
  if (filtro !== undefined) filtroReporteEstado = filtro;
  renderSidebarAdmin('reportes');
  document.getElementById('pageTitle').textContent = 'Reportes';
  document.getElementById('pageSubtitle').textContent = 'Historial de capacitaciones de todos los trabajadores';

  if (!cacheReportes) {
    const [historial, usuarios, modulos] = await Promise.all([DB.obtenerHistorial(), DB.obtenerUsuarios(), DB.obtenerModulos()]);
    cacheReportes = historial.map(h => ({
      ...h,
      usuario: usuarios.find(u => u.id === h.usuarioId),
      modulo: modulos.find(m => m.id === h.moduloId)
    })).filter(f => f.usuario && f.modulo);
  }
  const filas = cacheReportes;
  const filtradas = filtroReporteEstado ? filas.filter(f => f.estado === filtroReporteEstado) : filas;

  document.getElementById('content').innerHTML = `
    <div class="toolbar">
      <div class="filters-bar" style="margin-bottom:0;">
        <select id="filtroReporte">
          <option value="">Todos los estados</option>
          <option value="COMPLETADO">Completados</option>
          <option value="EN_PROGRESO">En progreso</option>
        </select>
      </div>
      <div class="toolbar-right">
        <button class="btn-outline" onclick="exportarReporteExcel()"><i data-lucide="download" size="15"></i> Exportar reporte</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Trabajador</th><th>Módulo</th><th>Estado</th><th>Puntaje</th><th>Inicio</th><th>Fin</th></tr></thead>
        <tbody id="tablaReporte"></tbody>
      </table>
    </div>
  `;
  const filtroSelect = document.getElementById('filtroReporte');
  filtroSelect.value = filtroReporteEstado;
  filtroSelect.addEventListener('change', (e) => renderReportes(e.target.value));

  document.getElementById('tablaReporte').innerHTML = filtradas.length ? filtradas.map(f => `
    <tr>
      <td>${nombreCompleto(f.usuario)}</td>
      <td>${f.modulo.nombre}</td>
      <td><span class="badge ${f.estado==='COMPLETADO'?'badge-activo':'badge-inactivo'}">${f.estado==='COMPLETADO'?'Completado':'En progreso'}</span></td>
      <td>${f.puntaje ?? '-'}</td>
      <td>${new Date(f.fechaInicio).toLocaleDateString('es-PE')}</td>
      <td>${f.fechaFin ? new Date(f.fechaFin).toLocaleDateString('es-PE') : '-'}</td>
    </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:30px;">No hay registros.</td></tr>`;
  lucide.createIcons();
}

function exportarReporteExcel() {
  const filas = (cacheReportes || []).map(f => ({
    'Trabajador': nombreCompleto(f.usuario), 'DNI': f.usuario.dni, 'Módulo': f.modulo.nombre,
    'Estado': f.estado, 'Puntaje': f.puntaje ?? '', 'Fecha inicio': f.fechaInicio, 'Fecha fin': f.fechaFin || ''
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
  XLSX.writeFile(wb, `reporte_capacitaciones_${new Date().toISOString().slice(0,10)}.xlsx`);
}

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
      <p style="font-size:.84rem;color:var(--gray-700);">Capacitaciones completadas: <strong>${historial.filter(h=>h.estado==='COMPLETADO').length}</strong></p>
    </div>
    <div class="panel" style="max-width:520px;margin-top:20px;">
      <div class="panel-head"><h2>Migración desde la versión local</h2></div>
      <p style="font-size:.84rem;color:var(--gray-500);margin-bottom:12px;">Si este navegador tiene datos de la versión anterior (localStorage), puedes subirlos a Firebase una sola vez. Los archivos .zip/.rar/certificados no se migran: vuelve a subirlos editando cada módulo.</p>
      <div class="form-error" id="errorMigracion"></div>
      <div class="form-success" id="successMigracion"></div>
      <button class="btn-outline" id="btnImportarLocal"><i data-lucide="upload-cloud" size="15"></i> Importar datos locales a Firebase</button>
    </div>
  `;
  document.getElementById('btnImportarLocal').addEventListener('click', async () => {
    const errorBox = document.getElementById('errorMigracion');
    const successBox = document.getElementById('successMigracion');
    errorBox.classList.remove('show'); successBox.classList.remove('show');
    try {
      const resultado = await DB.importarDatosLocalesAFirestore();
      successBox.textContent = `Se importaron ${resultado.contador} registro(s). ${resultado.avisoArchivos}`;
      successBox.classList.add('show');
      cacheReportes = null;
    } catch (err) {
      errorBox.textContent = err.message || 'No se pudo importar.';
      errorBox.classList.add('show');
    }
  });
  lucide.createIcons();
}

// ---------------------------------------------------------------
// ADMIN: Capacitaciones (Módulos)
// ---------------------------------------------------------------
async function renderCapacitaciones() {
  renderSidebarAdmin('capacitaciones');
  document.getElementById('pageTitle').textContent = 'Capacitaciones';
  document.getElementById('pageSubtitle').textContent = 'Gestión de módulos';

  const [modulos, asignaciones] = await Promise.all([DB.obtenerModulos(), DB.obtenerAsignaciones()]);

  document.getElementById('content').innerHTML = `
    <div class="toolbar">
      <div></div>
      <button class="btn-save" style="display:flex;align-items:center;gap:7px;" onclick="abrirModalModulo()"><i data-lucide="plus" size="16"></i> Nuevo módulo</button>
    </div>
    <div class="grid-modulos" id="gridModulos"></div>
  `;

  const grid = document.getElementById('gridModulos');
  if (modulos.length === 0) {
    grid.innerHTML = `
      <div class="empty-modulos">
        <i data-lucide="package-open" size="36"></i>
        <p>Todavía no se ha subido ningún módulo.<br>Haz clic en "Nuevo módulo" para agregar el primero.</p>
      </div>`;
  } else {
    grid.innerHTML = modulos.map(m => {
      const totalHabilitados = asignaciones.filter(a => a.moduloId === m.id && a.habilitado).length;
      const coverEstilo = m.miniaturaUrl
        ? `background-image:url('${m.miniaturaUrl}');`
        : m.color ? `background:${m.color};color:white;` : `background:var(--blue-100);color:var(--blue-600);`;
      return `
      <div class="modulo-card">
        <div class="modulo-cover" style="${coverEstilo}">${m.miniaturaUrl ? '' : `<i data-lucide="${m.icono || 'book-open'}" size="26"></i>`}</div>
        <div class="modulo-body">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <h3>${m.numeroModulo ? `M${m.numeroModulo} · ` : ''}${m.nombre}</h3>
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
          <button class="icon-btn primary-outline" onclick="abrirModalGrupo('${m.id}','${m.nombre.replace(/'/g,"\\'")}')"><i data-lucide="users-round" size="13"></i> Asignar por área/sede</button>
          <button class="icon-btn" onclick="toggleEstadoModulo('${m.id}')"><i data-lucide="power" size="13"></i> ${m.estado==='ACTIVO'?'Inactivar':'Activar'}</button>
          <button class="icon-btn danger" onclick="eliminarModulo('${m.id}','${m.nombre.replace(/'/g,"\\'")}')"><i data-lucide="trash-2" size="13"></i> Eliminar</button>
        </div>
      </div>
    `;
    }).join('');
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
const fCarpeta = document.getElementById('fCarpeta');
const btnElegirCarpetaModulo = document.getElementById('btnElegirCarpetaModulo');
const fileDropPreguntas = document.getElementById('fileDropPreguntas');
const fPreguntas = document.getElementById('fPreguntas');
const fileDropCertificado = document.getElementById('fileDropCertificado');
const fCertificado = document.getElementById('fCertificado');
const fileDropMiniatura = document.getElementById('fileDropMiniatura');
const fMiniatura = document.getElementById('fMiniatura');
let miniaturaExistenteUrl = null; // se conserva si al editar no se elige una nueva

async function abrirModalModulo(id) {
  formModulo.reset();
  document.getElementById('nombreArchivo').textContent = '';
  document.getElementById('nombrePreguntas').textContent = '';
  document.getElementById('nombreCertificado').textContent = '';
  document.getElementById('nombreMiniatura').textContent = '';
  document.getElementById('previewMiniatura').style.display = 'none';
  miniaturaExistenteUrl = null;
  document.getElementById('formError').classList.remove('show');
  document.getElementById('mfId').value = id || '';

  if (id) {
    const m = await DB.obtenerModulo(id);
    document.getElementById('modalModuloTitulo').textContent = 'Editar módulo';
    document.getElementById('fNombre').value = m.nombre;
    document.getElementById('fDescripcion').value = m.descripcion || '';
    document.getElementById('fCategoria').value = m.categoria || '';
    document.getElementById('fIcono').value = m.icono || 'book-open';
    document.getElementById('fColor').value = m.color || '#2563eb';
    document.getElementById('nombreArchivo').textContent = m.archivoNombre ? `Actual: ${m.archivoNombre} (elige otro archivo para reemplazarlo)` : '';
    document.getElementById('nombrePreguntas').textContent = m.preguntas && m.preguntas.length ? `Actual: ${m.preguntasNombre || 'preguntas cargadas'} (${m.preguntas.length} preguntas — elige otro archivo para reemplazarlas)` : '';
    document.getElementById('nombreCertificado').textContent = m.certificadoNombre ? `Actual: ${m.certificadoNombre} (elige otro PDF para reemplazarlo)` : '';
    if (m.miniaturaUrl) {
      miniaturaExistenteUrl = m.miniaturaUrl;
      document.getElementById('previewMiniatura').src = m.miniaturaUrl;
      document.getElementById('previewMiniatura').style.display = 'block';
      document.getElementById('nombreMiniatura').textContent = 'Actual (elige otra imagen para reemplazarla)';
    }
  } else {
    document.getElementById('modalModuloTitulo').textContent = 'Nuevo módulo';
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
// Normaliza cualquier carpeta (seleccionada o arrastrada) a .zip en el
// navegador: los 3 caminos de carga (.zip / .rar / carpeta) terminan
// siempre en el mismo artefacto almacenado y comparten el mismo código
// de subida más abajo.
async function normalizarCarpetaModulo(zipPromise) {
  const nombreBase = (document.getElementById('fNombre').value.trim() || 'modulo').replace(/\s+/g, '_');
  document.getElementById('nombreArchivo').textContent = 'Comprimiendo carpeta...';
  try {
    const zip = await zipPromise;
    const archivoZip = await jszipAArchivoZip(zip, nombreBase);
    const dt = new DataTransfer();
    dt.items.add(archivoZip);
    fArchivo.files = dt.files;
    document.getElementById('nombreArchivo').textContent = `Seleccionado: ${archivoZip.name} (carpeta comprimida)`;
  } catch (e) {
    console.error('No se pudo comprimir la carpeta:', e);
    document.getElementById('nombreArchivo').textContent = 'No se pudo leer la carpeta seleccionada.';
  }
}

btnElegirCarpetaModulo.addEventListener('click', () => fCarpeta.click());
fCarpeta.addEventListener('change', async () => {
  if (!fCarpeta.files.length) return;
  await normalizarCarpetaModulo(carpetaSeleccionadaAJSZip(fCarpeta.files));
  fCarpeta.value = '';
});

// La zona de arrastre acepta .zip/.rar sueltos o una carpeta completa: los
// FileSystemEntry hay que leerlos con webkitGetAsEntry() en el mismo tick
// síncrono del evento 'drop' (el DataTransfer deja de ser válido después).
fArchivo.addEventListener('change', () => {
  const f = fArchivo.files[0];
  document.getElementById('nombreArchivo').textContent = f ? `Seleccionado: ${f.name}` : '';
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
    document.getElementById('nombreArchivo').textContent = `Seleccionado: ${e.dataTransfer.files[0].name}`;
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
  document.getElementById('nombreMiniatura').textContent = 'Procesando imagen...';
  try {
    const dataUrl = await redimensionarImagen(f, 640);
    const preview = document.getElementById('previewMiniatura');
    preview.src = dataUrl;
    preview.style.display = 'block';
    document.getElementById('nombreMiniatura').textContent = `Seleccionada: ${f.name}`;
  } catch (e) {
    document.getElementById('nombreMiniatura').textContent = 'No se pudo leer la imagen.';
  }
});
wireFileDrop(fileDropPreguntas, fPreguntas, () => {
  const f = fPreguntas.files[0];
  document.getElementById('nombrePreguntas').textContent = f ? `Seleccionado: ${f.name}` : '';
});
wireFileDrop(fileDropCertificado, fCertificado, () => {
  const f = fCertificado.files[0];
  document.getElementById('nombreCertificado').textContent = f ? `Seleccionado: ${f.name}` : '';
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
    }

    // Normaliza .rar a .zip antes de subir: así el artefacto almacenado en
    // GitHub es siempre el mismo sin importar si el admin subió .zip, .rar
    // o una carpeta (que ya llega convertida a .zip desde fCarpeta).
    if (archivo && archivo.name.split('.').pop().toLowerCase() === 'rar') {
      botonGuardar.textContent = 'Convirtiendo .rar a .zip...';
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
      botonGuardar.textContent = 'Subiendo a GitHub...';
      const subidas = await subirArchivosAGithub(entradas, `Sube módulo: ${nombre}`);
      entradas.forEach((entrada, i) => {
        if (entrada.tipo === 'archivo') {
          datos.archivoUrl = subidas[i].url;
          datos.archivoNombre = archivo.name;
          datos.archivoPeso = archivo.size;
        } else {
          datos.certificadoUrl = subidas[i].url;
          datos.certificadoNombre = archivoCertificado.name;
        }
      });
    }
    if (preguntasParseadas) {
      datos.preguntas = preguntasParseadas;
      datos.preguntasNombre = archivoPreguntas.name;
    }

    if (idExistente) {
      await DB.actualizarModulo(idExistente, datos);
    } else {
      await DB.crearModulo(id, { ...datos, estado: 'ACTIVO', fechaCreacion: new Date().toISOString() });
    }

    modalOverlay.classList.remove('show');
    renderCapacitaciones();
  } catch (err) {
    console.error('Guardar módulo:', err);
    errorBox.textContent = err.message || 'No se pudo guardar el módulo.';
    errorBox.classList.add('show');
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
  await poblarValoresFiltroGrupo();
  document.getElementById('modalGrupoOverlay').classList.add('show');
}
document.getElementById('btnCancelarGrupo').addEventListener('click', () => document.getElementById('modalGrupoOverlay').classList.remove('show'));
document.getElementById('gTipoFiltro').addEventListener('change', poblarValoresFiltroGrupo);

async function poblarValoresFiltroGrupo() {
  const tipo = document.getElementById('gTipoFiltro').value;
  const usuarios = await DB.obtenerUsuarios();
  const valores = [...new Set(usuarios.filter(u=>u.rol==='TRABAJADOR').map(u => tipo === 'area' ? u.area : u.sede).filter(Boolean))];
  const select = document.getElementById('gValorFiltro');
  select.innerHTML = valores.length
    ? valores.map(v => `<option value="${v}">${v}</option>`).join('')
    : `<option value="">No hay trabajadores con este dato</option>`;
}

document.getElementById('btnHabilitarGrupo').addEventListener('click', async () => {
  const tipo = document.getElementById('gTipoFiltro').value;
  const valor = document.getElementById('gValorFiltro').value;
  const errorBox = document.getElementById('formErrorGrupo');
  if (!valor) { errorBox.textContent = 'No hay ningún valor disponible para asignar.'; errorBox.classList.add('show'); return; }

  const usuarios = await DB.obtenerUsuarios();
  const usuariosDelGrupo = usuarios.filter(u => u.rol === 'TRABAJADOR' && (tipo === 'area' ? u.area : u.sede) === valor);

  await Promise.all(usuariosDelGrupo.map(u => DB.setAsignacion(u.id, grupoModuloId, true)));

  document.getElementById('modalGrupoOverlay').classList.remove('show');
  renderCapacitaciones();
  alert(`Módulo habilitado para ${usuariosDelGrupo.length} trabajador(es) de ${tipo === 'area' ? 'área' : 'sede'} "${valor}".`);
});

// ---------------------------------------------------------------
// ADMIN: Usuarios
// ---------------------------------------------------------------
async function renderUsuarios() {
  renderSidebarAdmin('usuarios');
  document.getElementById('pageTitle').textContent = 'Usuarios';
  document.getElementById('pageSubtitle').textContent = 'Gestión de trabajadores';

  const [usuarios, asignaciones] = await Promise.all([DB.obtenerUsuarios(), DB.obtenerAsignaciones()]);
  const trabajadores = usuarios.filter(u => u.rol === 'TRABAJADOR');
  const activos = trabajadores.filter(u => u.estado === 'ACTIVO').length;

  const areas = [...new Set(trabajadores.map(u => u.area).filter(Boolean))].sort();
  const sedes = [...new Set(trabajadores.map(u => u.sede).filter(Boolean))].sort();
  const gerencias = [...new Set(trabajadores.map(u => u.gerencia).filter(Boolean))].sort();

  document.getElementById('content').innerHTML = `
    <div class="stat-grid-usuarios">
      <div class="stat-card"><div class="stat-icon" style="background:var(--blue-100);color:var(--blue-600);"><i data-lucide="users" size="18"></i></div><div><div class="num">${trabajadores.length}</div><div class="label">Total</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--green-100);color:var(--green-500);"><i data-lucide="check-circle-2" size="18"></i></div><div><div class="num">${activos}</div><div class="label">Activos</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--gray-100);color:var(--gray-500);"><i data-lucide="x-circle" size="18"></i></div><div><div class="num">${trabajadores.length - activos}</div><div class="label">Inactivos</div></div></div>
    </div>

    <div class="toolbar">
      <div class="filters-bar" style="margin-bottom:0;flex:1;">
        <input type="text" id="buscarUsuario" placeholder="Buscar por nombre, correo o DNI...">
        <select id="filtroArea"><option value="">Todas las áreas</option>${areas.map(a => `<option value="${a}">${a}</option>`).join('')}</select>
        <select id="filtroSede"><option value="">Todas las sedes</option>${sedes.map(s => `<option value="${s}">${s}</option>`).join('')}</select>
        <select id="filtroGerencia"><option value="">Todas las gerencias</option>${gerencias.map(g => `<option value="${g}">${g}</option>`).join('')}</select>
        <select id="filtroEstado"><option value="">Todos los estados</option><option value="ACTIVO">Activo</option><option value="INACTIVO">Inactivo</option></select>
      </div>
      <div class="toolbar-right">
        <button class="btn-outline" onclick="abrirModalImportar()"><i data-lucide="upload" size="15"></i> Importar Excel</button>
        <button class="btn-outline" onclick="exportarUsuariosExcel()"><i data-lucide="download" size="15"></i> Exportar base de datos</button>
        <button class="btn-save" style="display:flex;align-items:center;gap:7px;" onclick="abrirModalUsuario()"><i data-lucide="plus" size="16"></i> Nuevo trabajador</button>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Usuario</th><th>Área</th><th>Empresa</th><th>Sede</th><th>Gerencia</th><th>Rol</th><th>Estado</th><th>Módulos asignados</th><th>Acciones</th>
        </tr></thead>
        <tbody id="tablaUsuariosBody"></tbody>
      </table>
    </div>
  `;

  const pintar = (lista) => pintarFilasUsuarios(lista, asignaciones);
  const aplicarFiltrosUsuarios = () => {
    const q = document.getElementById('buscarUsuario').value.toLowerCase();
    const area = document.getElementById('filtroArea').value;
    const sede = document.getElementById('filtroSede').value;
    const gerencia = document.getElementById('filtroGerencia').value;
    const estado = document.getElementById('filtroEstado').value;
    const filtrados = trabajadores.filter(u =>
      (nombreCompleto(u).toLowerCase().includes(q) || u.correo.toLowerCase().includes(q) || u.dni.includes(q)) &&
      (!area || u.area === area) && (!sede || u.sede === sede) && (!gerencia || u.gerencia === gerencia) && (!estado || u.estado === estado)
    );
    pintar(filtrados);
  };
  pintar(trabajadores);
  ['buscarUsuario', 'filtroArea', 'filtroSede', 'filtroGerencia', 'filtroEstado'].forEach(id => {
    document.getElementById(id).addEventListener('input', aplicarFiltrosUsuarios);
  });
  lucide.createIcons();
}

function pintarFilasUsuarios(lista, asignaciones) {
  const tbody = document.getElementById('tablaUsuariosBody');
  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--gray-500);padding:30px;">No se encontraron trabajadores.</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map(u => {
    const totalModulos = asignaciones.filter(a => a.usuarioId === u.id && a.habilitado).length;
    return `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="avatar" style="width:34px;height:34px;font-size:.7rem;flex-shrink:0;${u.fotoUrl ? `background-image:url('${u.fotoUrl}');background-size:cover;` : ''}">${u.fotoUrl ? '' : (u.primerNombre[0] + u.apellidoPaterno[0]).toUpperCase()}</div>
          <div>
            <div style="font-weight:700;font-size:.85rem;color:var(--gray-900);">${nombreCompleto(u)}</div>
            <div style="font-size:.72rem;color:var(--gray-500);">${u.correo} · DNI ${u.dni}</div>
          </div>
        </div>
      </td>
      <td>${u.area || '-'}</td>
      <td>${u.empresa || '-'}</td>
      <td>${u.sede || '-'}</td>
      <td>${u.gerencia || '-'}</td>
      <td><span class="badge" style="background:var(--blue-100);color:var(--blue-600);">TRABAJADOR</span></td>
      <td><span class="badge ${u.estado==='ACTIVO'?'badge-activo':'badge-inactivo'}">${u.estado==='ACTIVO'?'Activo':'Inactivo'}</span></td>
      <td>${totalModulos}</td>
      <td>
        <div class="actions-cell">
          <button onclick="abrirModalAsignar('${u.id}')" title="Asignar módulos"><i data-lucide="book-open" size="14"></i></button>
          <button onclick="editarUsuario('${u.id}')" title="Editar"><i data-lucide="pencil" size="14"></i></button>
          <button onclick="toggleEstadoUsuario('${u.id}')" title="Activar/Inactivar"><i data-lucide="power" size="14"></i></button>
          <button onclick="eliminarUsuario('${u.id}','${nombreCompleto(u).replace(/'/g,"\\'")}')" title="Eliminar"><i data-lucide="trash-2" size="14"></i></button>
        </div>
      </td>
    </tr>
  `;
  }).join('');
  lucide.createIcons();
}

async function toggleEstadoUsuario(id) {
  const u = await DB.obtenerUsuario(id);
  await DB.actualizarUsuario(id, { estado: u.estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO' });
  renderUsuarios();
}

async function eliminarUsuario(id, nombre) {
  if (!confirm(`¿Eliminar a ${nombre}? Se borran sus asignaciones e historial. Esta acción no se puede deshacer.\n\nNota: la cuenta de acceso (Firebase Auth) de esta persona no se elimina automáticamente — requiere Admin SDK, fuera de alcance de esta versión.`)) return;
  await DB.eliminarUsuario(id);
  renderUsuarios();
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
  document.getElementById('uArea').value = u.area || '';
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
  const area = document.getElementById('uArea').value.trim();
  const gerencia = document.getElementById('uGerencia').value.trim();
  const errorBox = document.getElementById('formErrorUsuario');
  errorBox.classList.remove('show');

  const botonGuardar = e.target.querySelector('button[type=submit]');
  botonGuardar.disabled = true;

  try {
    if (!idExistente) {
      const yaExiste = await DB.obtenerUsuario(dni);
      if (yaExiste) { errorBox.textContent = `Ya existe un usuario con el DNI ${dni}.`; errorBox.classList.add('show'); return; }
      if (!password) password = dni;

      await crearCuentaAuthParaUsuario(correo, password);
      await DB.crearUsuario(dni, {
        primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, correo, empresa, sede, area, gerencia,
        rol: 'TRABAJADOR', estado: 'ACTIVO', debeCambiarPassword: password === dni
      });
    } else {
      const datos = { primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, correo, empresa, sede, area, gerencia };
      await DB.actualizarUsuario(idExistente, datos);
      // Cambiar la contraseña de otro usuario desde el panel admin requeriría
      // Admin SDK/Cloud Functions (fuera de alcance): si el admin necesita
      // resetear la contraseña de alguien, usa "Restablecer contraseña" en
      // el login con el DNI de esa persona (envía el enlace a su correo).
    }
    modalUsuarioOverlay.classList.remove('show');
    renderUsuarios();
  } catch (err) {
    console.error('Guardar usuario:', err);
    errorBox.textContent = err.code === 'auth/email-already-in-use' ? 'Ya existe una cuenta con ese correo.' : (err.message || 'No se pudo guardar el usuario.');
    errorBox.classList.add('show');
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
          <div class="icn"><i data-lucide="book-open" size="16"></i></div>
          <div style="flex:1;"><strong>${m.nombre}</strong><div style="font-size:.74rem;color:var(--gray-500);">${m.categoria || 'Sin categoría'}</div></div>
        </div>`).join('')
      : `<div class="empty-state"><p>Sin asignaciones actuales.</p></div>`;
  } else {
    const filtrados = modulos.filter(m => m.nombre.toLowerCase().includes(drawerFiltroTexto.toLowerCase()));
    body.innerHTML = `
      <div class="drawer-search"><input type="text" id="drawerBuscarModulo" placeholder="Buscar módulo..." value="${drawerFiltroTexto.replace(/"/g,'&quot;')}"></div>
      ${filtrados.length ? filtrados.map(m => `
        <label class="modulo-check-card">
          <div class="icn"><i data-lucide="book-open" size="16"></i></div>
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
  const modulos = drawerModulosCache || [];
  await Promise.all(modulos.map(m => DB.setAsignacion(drawerUsuarioId, m.id, drawerSeleccionPendiente.has(m.id))));
  document.getElementById('drawerAsignarOverlay').classList.remove('show');
  renderUsuarios();
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
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const filas = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      let creados = 0, actualizados = 0, errores = 0;

      for (const fila of filas) {
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

      successBox.textContent = `Importación completa: ${creados} creado(s), ${actualizados} actualizado(s)${errores ? `, ${errores} fila(s) con error` : ''}.`;
      successBox.classList.add('show');
    } catch (err) {
      errorBox.textContent = 'No se pudo procesar el archivo. Verifica que sea un Excel válido con las columnas indicadas.';
      errorBox.classList.add('show');
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
  const usuarios = await DB.obtenerUsuarios();
  const trabajadores = usuarios.filter(u => u.rol === 'TRABAJADOR');

  const filas = trabajadores.map(u => ({
    'Nombres': [u.primerNombre, u.segundoNombre].filter(Boolean).join(' '),
    'Apellidos': [u.apellidoPaterno, u.apellidoMaterno].filter(Boolean).join(' '),
    'DNI': u.dni,
    'Correo': u.correo,
    'Empresa': u.empresa || '',
    'Sede': u.sede || '',
    'Gerencia': u.gerencia || '',
    'Rol': u.rol,
    'Estado': u.estado
  }));

  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Trabajadores');
  XLSX.writeFile(wb, `trabajadores_tramarsa_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ---------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  if (!firebaseEstaConfigurado()) { mostrarErrorFirebaseNoConfigurado(); return; }

  // Firebase Auth restaura la sesión desde IndexedDB de forma asíncrona:
  // auth.currentUser puede seguir siendo null justo al cargar la página
  // aunque haya una sesión válida. Por eso se espera a onAuthStateChanged
  // (su primera resolución) en vez de comprobarlo de forma síncrona —
  // si no, un simple refresh mandaba de vuelta al login por error.
  const dejarDeEscuchar = onAuthStateChanged(auth, async (user) => {
    dejarDeEscuchar();
    const sesion = getSesion();
    if (sesion && user) { await iniciarApp(); return; }

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
      correo, sede: '', area: '', rol: 'ADMIN', estado: 'ACTIVO', debeCambiarPassword: false
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
  renderProgresoTrabajador, renderPerfilTrabajador,
  renderCapacitaciones, renderUsuarios, renderAsignaciones, renderReportes, renderConfiguracion,
  abrirModalModulo, toggleEstadoModulo, eliminarModulo, abrirModalGrupo,
  abrirModalUsuario, editarUsuario, toggleEstadoUsuario, eliminarUsuario, abrirModalAsignar,
  cambiarTabDrawerAsignar, toggleDrawerSeleccion,
  abrirModalImportar, exportarUsuariosExcel, exportarReporteExcel
});
