/* ============================================================
   TRAMARSA LMS — Lógica de la aplicación
   Sin servidor. Los datos viven en localStorage (respaldo rápido)
   y, si el administrador conecta la carpeta "data" del proyecto,
   también se escriben automáticamente en data/data.json usando la
   File System Access API (disponible en Chrome/Edge).
   ============================================================ */

const DB_KEY = 'tramarsa_db_v2';
const ARCHIVOS_STORE_DB = 'tramarsa_archivos';

// ---------------------------------------------------------------
// Semilla inicial (se usa solo si no hay nada guardado todavía)
// ---------------------------------------------------------------
function seedInicial() {
  return {
    usuarios: [
      { id:'admin-1', dni:'00000000', correo:'admin@tramarsa.com.pe', password:'Admin2026*', primerNombre:'Administrador', segundoNombre:'', apellidoPaterno:'Plataforma', apellidoMaterno:'', sede:'Lima', area:'Sistemas', rol:'ADMIN', estado:'ACTIVO' },
      { id:'trab-1', dni:'12345678', correo:'juan.perez@tramarsa.com.pe', password:'12345678', primerNombre:'Juan', segundoNombre:'Carlos', apellidoPaterno:'Pérez', apellidoMaterno:'Gómez', sede:'Lima', area:'Operaciones', rol:'TRABAJADOR', estado:'ACTIVO' }
    ],
    modulos: [],
    asignaciones: [], // { usuarioId, moduloId, habilitado }
    historial: []     // { id, usuarioId, moduloId, estado, puntaje, fechaInicio, fechaFin }
  };
}

let DB_CACHE = null;

function getDB() {
  if (DB_CACHE) return DB_CACHE;
  const raw = localStorage.getItem(DB_KEY);
  DB_CACHE = raw ? JSON.parse(raw) : seedInicial();
  if (!DB_CACHE.historial) DB_CACHE.historial = []; // compatibilidad con datos guardados antes de esta version
  return DB_CACHE;
}

function saveDB(db) {
  DB_CACHE = db;
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  guardarEnCarpetaConectada(); // no-op si no hay carpeta conectada
}

function nombreCompleto(u) {
  return [u.primerNombre, u.segundoNombre, u.apellidoPaterno, u.apellidoMaterno].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------
// Archivos de módulos (.zip/.rar) — IndexedDB, porque pueden pesar
// más de lo que localStorage permite.
// ---------------------------------------------------------------
let idbArchivos = null;
function abrirIDBArchivos() {
  return new Promise((resolve, reject) => {
    if (idbArchivos) return resolve(idbArchivos);
    const req = indexedDB.open(ARCHIVOS_STORE_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('modulos')) db.createObjectStore('modulos');
      if (!db.objectStoreNames.contains('certificados')) db.createObjectStore('certificados');
    };
    req.onsuccess = () => { idbArchivos = req.result; resolve(idbArchivos); };
    req.onerror = () => reject(req.error);
  });
}
async function guardarArchivoModulo(moduloId, file) {
  const db = await abrirIDBArchivos();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('modulos', 'readwrite');
    tx.objectStore('modulos').put(file, moduloId);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function obtenerArchivoModulo(moduloId) {
  const db = await abrirIDBArchivos();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('modulos', 'readonly');
    const req = tx.objectStore('modulos').get(moduloId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function eliminarArchivoModulo(moduloId) {
  const db = await abrirIDBArchivos();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('modulos', 'readwrite');
    tx.objectStore('modulos').delete(moduloId);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

// Plantilla de certificado (PDF) por módulo — mismo motivo que el .zip: puede
// pesar más de lo razonable para localStorage.
async function guardarCertificadoModulo(moduloId, file) {
  const db = await abrirIDBArchivos();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('certificados', 'readwrite');
    tx.objectStore('certificados').put(file, moduloId);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function obtenerCertificadoModulo(moduloId) {
  const db = await abrirIDBArchivos();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('certificados', 'readonly');
    const req = tx.objectStore('certificados').get(moduloId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function eliminarCertificadoModulo(moduloId) {
  const db = await abrirIDBArchivos();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('certificados', 'readwrite');
    tx.objectStore('certificados').delete(moduloId);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
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
      // línea de continuación: una pregunta o alternativa partida en 2 líneas
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
  if (ext === 'docx') {
    const texto = await extraerTextoDocx(file);
    return parsearPreguntasDesdeTexto(texto);
  }
  if (ext === 'txt') {
    const texto = await file.text();
    return parsearPreguntasDesdeTexto(texto);
  }
  throw new Error('Formato de preguntas no soportado. Usa .txt, .docx o .json.');
}

// ---------------------------------------------------------------
// Conexión con la carpeta "data" del proyecto (File System Access API)
// Guarda el handle en IndexedDB para no tener que reconectar cada vez.
// ---------------------------------------------------------------
let dirHandle = null;

function abrirIDBHandles() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tramarsa_handles', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function guardarHandleEnIDB(handle) {
  const db = await abrirIDBHandles();
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, 'dataDir');
}
async function obtenerHandleDeIDB() {
  const db = await abrirIDBHandles();
  return new Promise((resolve) => {
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get('dataDir');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

function soportaFileSystemAccess() {
  return typeof window.showDirectoryPicker === 'function';
}

async function conectarCarpetaDatos() {
  if (!soportaFileSystemAccess()) {
    alert('Tu navegador no soporta guardado automático en carpeta (esta función necesita Chrome o Edge). Puedes seguir usando la plataforma normalmente: los datos se guardan en este navegador.');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'tramarsa-data', mode: 'readwrite', startIn: 'documents' });
    dirHandle = handle;
    await guardarHandleEnIDB(handle);

    // Si ya existe un data.json en la carpeta elegida, lo cargamos (por si el
    // repositorio ya traía datos); si no, escribimos el estado actual.
    const existente = await intentarLeerDataJson();
    if (existente) {
      existente.historial = fusionarHistorial(getDB().historial, existente.historial);
      existente.usuarios = fusionarUsuarios(getDB().usuarios, existente.usuarios);
      DB_CACHE = existente;
      localStorage.setItem(DB_KEY, JSON.stringify(existente));
    } else {
      await guardarEnCarpetaConectada();
    }

    actualizarCajaSincronizacion();
    if (typeof onCarpetaConectada === 'function') onCarpetaConectada();
  } catch (e) {
    console.log('Selección de carpeta cancelada o falló:', e);
  }
}

async function intentarReconectarCarpeta() {
  if (!soportaFileSystemAccess()) return;
  const handle = await obtenerHandleDeIDB();
  if (!handle) { actualizarCajaSincronizacion(); return; }

  const permiso = await handle.queryPermission({ mode: 'readwrite' });
  if (permiso === 'granted') {
    dirHandle = handle;
    const existente = await intentarLeerDataJson();
    if (existente) {
      existente.historial = fusionarHistorial(getDB().historial, existente.historial);
      existente.usuarios = fusionarUsuarios(getDB().usuarios, existente.usuarios);
      DB_CACHE = existente;
      localStorage.setItem(DB_KEY, JSON.stringify(existente));
    }
  }
  actualizarCajaSincronizacion();
}

// El progreso de los trabajadores (historial) se guarda en localStorage aun
// cuando no hay carpeta conectada (solo el admin conecta carpeta). Por eso,
// al cargar un data.json desde disco no se puede sobrescribir el historial
// local sin más: se fusiona por id, conservando el registro más avanzado
// (COMPLETADO gana a EN_PROGRESO) para no perder capacitaciones ya aprobadas.
function fusionarHistorial(local, remoto) {
  const rango = h => h.estado === 'COMPLETADO' ? 2 : 1;
  const mapa = new Map();
  (remoto || []).forEach(h => mapa.set(h.id, h));
  (local || []).forEach(h => {
    const existente = mapa.get(h.id);
    if (!existente || rango(h) >= rango(existente)) mapa.set(h.id, h);
  });
  return [...mapa.values()];
}

// Mismo problema que el historial: el trabajador cambia su propia contraseña
// (o foto de perfil) sin tener la carpeta conectada — solo el admin la
// conecta. Si el data.json del disco pisa el arreglo de usuarios completo,
// esa contraseña nueva se pierde y vuelve a valer el DNI. Por eso los campos
// de autogestión del propio usuario (password, debeCambiarPassword, fotoUrl)
// siempre se preservan desde lo local; el resto de campos (los que gestiona
// el admin: nombre, área, estado, asignaciones, etc.) manda el remoto.
function fusionarUsuarios(local, remoto) {
  const localPorId = new Map((local || []).map(u => [u.id, u]));
  const remotoIds = new Set((remoto || []).map(u => u.id));
  const fusionados = (remoto || []).map(u => {
    const loc = localPorId.get(u.id);
    if (!loc) return u;
    return { ...u, password: loc.password, debeCambiarPassword: loc.debeCambiarPassword, fotoUrl: loc.fotoUrl !== undefined ? loc.fotoUrl : u.fotoUrl };
  });
  const soloLocales = (local || []).filter(u => !remotoIds.has(u.id));
  return fusionados.concat(soloLocales);
}

async function intentarLeerDataJson() {
  if (!dirHandle) return null;
  try {
    const fileHandle = await dirHandle.getFileHandle('data.json', { create: false });
    const file = await fileHandle.getFile();
    const texto = await file.text();
    return JSON.parse(texto);
  } catch (e) {
    return null; // no existe aun, no pasa nada
  }
}

async function guardarEnCarpetaConectada() {
  if (!dirHandle) return;
  try {
    const fileHandle = await dirHandle.getFileHandle('data.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(getDB(), null, 2));
    await writable.close();
  } catch (e) {
    console.error('No se pudo guardar data.json automáticamente:', e);
  }
}

function actualizarCajaSincronizacion() {
  const box = document.getElementById('syncBox');
  if (!box) return;
  if (dirHandle) {
    box.className = 'sync-box connected';
    box.innerHTML = `<strong>✓ Guardado automático activo</strong><br>Los cambios se guardan en data/data.json`;
  } else if (soportaFileSystemAccess()) {
    box.className = 'sync-box';
    box.innerHTML = `Conecta la carpeta "data" del proyecto para guardar los cambios automáticamente.<button onclick="conectarCarpetaDatos()">Conectar carpeta</button>`;
  } else {
    box.className = 'sync-box';
    box.innerHTML = `Tu navegador no soporta guardado automático. Usa "Exportar base de datos" para respaldar manualmente.`;
  }
}

// ---------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------
function getSesion() {
  const raw = sessionStorage.getItem('tramarsa_sesion');
  return raw ? JSON.parse(raw) : null;
}
function setSesion(usuario) { sessionStorage.setItem('tramarsa_sesion', JSON.stringify(usuario)); }
function cerrarSesion() { sessionStorage.removeItem('tramarsa_sesion'); location.reload(); }

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

document.getElementById('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const dni = document.getElementById('loginDni').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorBox = document.getElementById('errorMsg');
  const errorText = document.getElementById('errorText');

  const db = getDB();
  const usuario = db.usuarios.find(u => u.dni === dni);

  if (!usuario || usuario.password !== password) {
    errorText.textContent = 'DNI o contraseña incorrectos.';
    errorBox.classList.add('show');
    return;
  }
  if (usuario.estado !== 'ACTIVO') {
    errorText.textContent = 'Tu cuenta está inactiva. Contacta al administrador.';
    errorBox.classList.add('show');
    return;
  }

  errorBox.classList.remove('show');
  setSesion(usuario);
  iniciarApp();
});

// ---------------------------------------------------------------
// Arranque de la app tras login
// ---------------------------------------------------------------
function iniciarApp() {
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
    renderSidebarAdmin('capacitaciones');
    renderCapacitaciones();
    intentarReconectarCarpeta();
  } else {
    renderDashboardTrabajador();
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
  if (!usuario) return;
  // Migración orgánica: cuentas creadas antes de este campo, cuya contraseña
  // sigue siendo igual al DNI, también quedan sujetas al cambio obligatorio.
  const debeCambiar = usuario.debeCambiarPassword === true ||
    (usuario.debeCambiarPassword === undefined && usuario.password === usuario.dni);
  if (!debeCambiar) return;
  document.getElementById('formErrorCambioObligatorio').classList.remove('show');
  document.getElementById('formCambioObligatorio').reset();
  document.getElementById('modalCambioObligatorioOverlay').classList.add('show');
}

document.getElementById('formCambioObligatorio').addEventListener('submit', (e) => {
  e.preventDefault();
  const nueva = document.getElementById('cNueva').value;
  const confirmar = document.getElementById('cConfirmar').value;
  const errorBox = document.getElementById('formErrorCambioObligatorio');
  errorBox.classList.remove('show');

  const usuario = getSesion();
  if (nueva.length < 4) { errorBox.textContent = 'La contraseña debe tener al menos 4 caracteres.'; errorBox.classList.add('show'); return; }
  if (nueva === usuario.dni) { errorBox.textContent = 'La nueva contraseña no puede ser igual a tu DNI.'; errorBox.classList.add('show'); return; }
  if (nueva !== confirmar) { errorBox.textContent = 'Las contraseñas no coinciden.'; errorBox.classList.add('show'); return; }

  const db = getDB();
  const u = db.usuarios.find(x => x.id === usuario.id);
  u.password = nueva;
  u.debeCambiarPassword = false;
  saveDB(db);
  setSesion(u);
  document.getElementById('modalCambioObligatorioOverlay').classList.remove('show');
});

// ---------------------------------------------------------------
// Recuperar contraseña por correo (EmailJS — sin backend propio).
// RIESGO ACEPTADO: la Public Key de EmailJS queda expuesta en el
// cliente, como cualquier credencial en código que corre en el
// navegador. Configura tu cuenta en https://www.emailjs.com y
// reemplaza estos 3 valores; el template debe usar las variables
// to_email, to_name y password.
// ---------------------------------------------------------------
const EMAILJS_CONFIG = { publicKey: 'TU_PUBLIC_KEY', serviceId: 'TU_SERVICE_ID', templateId: 'TU_TEMPLATE_ID' };
function emailjsConfigurado() {
  return !Object.values(EMAILJS_CONFIG).some(v => v.startsWith('TU_'));
}
if (window.emailjs && emailjsConfigurado()) emailjs.init(EMAILJS_CONFIG.publicKey);

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

  const db = getDB();
  const usuario = db.usuarios.find(u => u.dni === dni);
  if (!usuario) { errorBox.textContent = 'No se encontró un usuario con ese DNI.'; errorBox.classList.add('show'); return; }
  if (!usuario.correo) { errorBox.textContent = 'Este usuario no tiene un correo registrado.'; errorBox.classList.add('show'); return; }
  if (!emailjsConfigurado()) {
    errorBox.textContent = 'El envío de correos no está configurado todavía. Contacta al administrador de la plataforma.';
    errorBox.classList.add('show');
    return;
  }

  try {
    await emailjs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.templateId, {
      to_email: usuario.correo, to_name: nombreCompleto(usuario), password: usuario.password
    });
    successBox.textContent = `Se envió tu contraseña actual a ${usuario.correo}.`;
    successBox.classList.add('show');
  } catch (err) {
    console.error('EmailJS:', err);
    errorBox.textContent = 'No se pudo enviar el correo. Intenta más tarde o contacta al administrador.';
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
// trabajador. Lo usan Inicio, Mis módulos, Certificados y Mi progreso para
// no repetir la misma lógica de estados en cada sección.
function datosCapacitacionesTrabajador() {
  const usuario = getSesion();
  const db = getDB();

  const modulosHabilitados = db.asignaciones
    .filter(a => a.usuarioId === usuario.id && a.habilitado)
    .map(a => db.modulos.find(m => m.id === a.moduloId))
    .filter(m => m && m.estado === 'ACTIVO');

  const historialUsuario = db.historial.filter(h => h.usuarioId === usuario.id);
  const historialPorModulo = new Map(historialUsuario.map(h => [h.moduloId, h]));

  const items = modulosHabilitados.map(m => {
    const hist = historialPorModulo.get(m.id) || null;
    const estado = hist ? hist.estado : 'PENDIENTE';
    const avance = estado === 'COMPLETADO' ? 100 : (hist ? (hist.avancePct || 0) : 0);
    return { modulo: m, hist, estado, avance };
  });

  return {
    usuario, db, items,
    completados: items.filter(i => i.estado === 'COMPLETADO'),
    enProgreso: items.filter(i => i.estado === 'EN_PROGRESO'),
    pendientes: items.filter(i => i.estado === 'PENDIENTE')
  };
}

// Mismos colores semáforo usados en las tarjetas de Inicio: azul = en
// progreso, naranja = pendiente, verde = completado.
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
      : (m.archivoNombre ? 'No iniciado' : 'El administrador aún no subió el contenido');

  let boton = '';
  if (item.estado === 'COMPLETADO') {
    boton = conCertificado
      ? `<button class="icon-btn primary-outline" onclick="verCertificadoStandalone('${m.id}', renderMisModulosTrabajador)"><i data-lucide="award" size="13"></i> Certificado</button>`
      : `<button disabled style="background:var(--gray-200);color:var(--gray-500);border:none;padding:8px 16px;border-radius:9px;font-size:.8rem;font-weight:700;cursor:default;">Completado</button>`;
  } else if (m.archivoNombre) {
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

function renderDashboardTrabajador() {
  renderSidebarTrabajador('inicio');
  document.getElementById('pageTitle').textContent = 'Inicio';
  document.getElementById('pageSubtitle').textContent = '';
  const { usuario, items, completados, enProgreso, pendientes } = datosCapacitacionesTrabajador();
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
function renderMisModulosTrabajador(filtro) {
  if (filtro) filtroMisModulos = filtro;
  renderSidebarTrabajador('modulos');
  document.getElementById('pageTitle').textContent = 'Mis módulos';
  document.getElementById('pageSubtitle').textContent = 'Todas tus capacitaciones asignadas';

  const { items, completados, enProgreso, pendientes } = datosCapacitacionesTrabajador();
  // Mismas tarjetas (stat-card) y colores/íconos semáforo que Inicio, ahora
  // como filtro clicable: azul = en progreso, verde = completado, naranja =
  // pendiente, gris = todos.
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

function renderCertificadosTrabajador() {
  renderSidebarTrabajador('certificados');
  document.getElementById('pageTitle').textContent = 'Certificados';
  document.getElementById('pageSubtitle').textContent = 'Certificados obtenidos por capacitaciones completadas';
  const { completados } = datosCapacitacionesTrabajador();

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

function renderProgresoTrabajador() {
  renderSidebarTrabajador('progreso');
  document.getElementById('pageTitle').textContent = 'Mi progreso';
  document.getElementById('pageSubtitle').textContent = '';
  const { items, completados } = datosCapacitacionesTrabajador();
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
    reader.onload = () => {
      const db = getDB();
      const u = db.usuarios.find(x => x.id === usuario.id);
      u.fotoUrl = reader.result;
      saveDB(db);
      setSesion(u);
      renderPerfilTrabajador();
    };
    reader.readAsDataURL(f);
  });

  document.getElementById('formPerfilPassword').addEventListener('submit', (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('formErrorPerfil');
    const successBox = document.getElementById('formSuccessPerfil');
    errorBox.classList.remove('show'); successBox.classList.remove('show');
    const actual = document.getElementById('pActual').value;
    const nueva = document.getElementById('pNueva').value;
    const confirmar = document.getElementById('pConfirmar').value;

    const db = getDB();
    const u = db.usuarios.find(x => x.id === usuario.id);
    if (u.password !== actual) { errorBox.textContent = 'La contraseña actual no es correcta.'; errorBox.classList.add('show'); return; }
    if (nueva.length < 4) { errorBox.textContent = 'La nueva contraseña debe tener al menos 4 caracteres.'; errorBox.classList.add('show'); return; }
    if (nueva !== confirmar) { errorBox.textContent = 'Las contraseñas no coinciden.'; errorBox.classList.add('show'); return; }

    u.password = nueva;
    u.debeCambiarPassword = false;
    saveDB(db);
    setSesion(u);
    successBox.textContent = 'Contraseña actualizada correctamente.';
    successBox.classList.add('show');
    document.getElementById('formPerfilPassword').reset();
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
    <div class="sync-box" id="syncBox"></div>
    <nav class="nav-group">
      ${items.map(it => `<a class="nav-item ${it.key===activo?'active':''}" onclick="${it.fn}()"><i data-lucide="${it.icon}" size="17"></i> ${it.label}</a>`).join('')}
    </nav>
    <a class="logout-item" onclick="cerrarSesion()"><i data-lucide="log-out" size="17"></i> Cerrar sesión</a>
  `;
  lucide.createIcons();
  actualizarCajaSincronizacion();
}

// ---------------------------------------------------------------
// ADMIN: Asignaciones — vista consolidada de qué módulo tiene
// habilitado cada trabajador (a criterio, MEJORAS.txt punto 4).
// ---------------------------------------------------------------
function renderAsignaciones() {
  renderSidebarAdmin('asignaciones');
  document.getElementById('pageTitle').textContent = 'Asignaciones';
  document.getElementById('pageSubtitle').textContent = 'Qué módulo tiene habilitado cada trabajador';
  const db = getDB();
  const trabajadores = db.usuarios.filter(u => u.rol === 'TRABAJADOR');

  document.getElementById('content').innerHTML = `<div class="grid-modulos" id="gridAsignaciones"></div>`;
  const grid = document.getElementById('gridAsignaciones');

  if (db.modulos.length === 0) {
    grid.innerHTML = `<div class="empty-modulos"><i data-lucide="link-2" size="36"></i><p>Todavía no hay módulos creados.</p></div>`;
  } else {
    grid.innerHTML = db.modulos.map(m => {
      const asignados = db.asignaciones.filter(a => a.moduloId === m.id && a.habilitado)
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
// ADMIN: Reportes — historial de todas las capacitaciones, filtrable
// y exportable (a criterio, MEJORAS.txt punto 5).
// ---------------------------------------------------------------
let filtroReporteEstado = '';
function renderReportes(filtro) {
  if (filtro !== undefined) filtroReporteEstado = filtro;
  renderSidebarAdmin('reportes');
  document.getElementById('pageTitle').textContent = 'Reportes';
  document.getElementById('pageSubtitle').textContent = 'Historial de capacitaciones de todos los trabajadores';
  const db = getDB();

  const filas = db.historial.map(h => ({
    ...h,
    usuario: db.usuarios.find(u => u.id === h.usuarioId),
    modulo: db.modulos.find(m => m.id === h.moduloId)
  })).filter(f => f.usuario && f.modulo);

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
  const db = getDB();
  const filas = db.historial.map(h => {
    const usuario = db.usuarios.find(u => u.id === h.usuarioId);
    const modulo = db.modulos.find(m => m.id === h.moduloId);
    if (!usuario || !modulo) return null;
    return {
      'Trabajador': nombreCompleto(usuario), 'DNI': usuario.dni, 'Módulo': modulo.nombre,
      'Estado': h.estado, 'Puntaje': h.puntaje ?? '', 'Fecha inicio': h.fechaInicio, 'Fecha fin': h.fechaFin || ''
    };
  }).filter(Boolean);
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
  XLSX.writeFile(wb, `reporte_capacitaciones_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ---------------------------------------------------------------
// ADMIN: Configuración — estado del guardado en disco + resumen
// (a criterio, MEJORAS.txt punto 6).
// ---------------------------------------------------------------
function renderConfiguracion() {
  renderSidebarAdmin('configuracion');
  document.getElementById('pageTitle').textContent = 'Configuración';
  document.getElementById('pageSubtitle').textContent = '';
  const db = getDB();

  document.getElementById('content').innerHTML = `
    <div class="panel" style="max-width:520px;">
      <div class="panel-head"><h2>Guardado en disco</h2></div>
      <p style="font-size:.84rem;color:var(--gray-500);margin-bottom:12px;">Conecta la carpeta "data" del proyecto para que cada cambio se escriba automáticamente en data/data.json.</p>
      <div id="configSyncStatus" style="margin-bottom:12px;"></div>
      <button class="btn-outline" id="btnConfigConectar"><i data-lucide="folder-sync" size="15"></i> ${dirHandle ? 'Reconectar carpeta' : 'Conectar carpeta'}</button>
    </div>
    <div class="panel" style="max-width:520px;margin-top:20px;">
      <div class="panel-head"><h2>Resumen de la plataforma</h2></div>
      <p style="font-size:.84rem;color:var(--gray-700);">Módulos: <strong>${db.modulos.length}</strong></p>
      <p style="font-size:.84rem;color:var(--gray-700);">Trabajadores: <strong>${db.usuarios.filter(u=>u.rol==='TRABAJADOR').length}</strong></p>
      <p style="font-size:.84rem;color:var(--gray-700);">Capacitaciones completadas: <strong>${db.historial.filter(h=>h.estado==='COMPLETADO').length}</strong></p>
    </div>
  `;
  document.getElementById('configSyncStatus').innerHTML = dirHandle
    ? `<span class="badge badge-activo">Conectado — guardado automático activo</span>`
    : `<span class="badge badge-inactivo">No conectado — usando localStorage</span>`;

  if (soportaFileSystemAccess()) {
    document.getElementById('btnConfigConectar').addEventListener('click', () => conectarCarpetaDatos().then(renderConfiguracion));
  } else {
    const btn = document.getElementById('btnConfigConectar');
    btn.textContent = 'No disponible en este navegador';
    btn.disabled = true;
  }
  lucide.createIcons();
}
function onCarpetaConectada() {
  // Refresca la vista actual para reflejar datos recien cargados desde disco
  const activo = document.querySelector('.nav-item.active');
  if (document.getElementById('gridModulos')) renderCapacitaciones();
  else if (document.getElementById('tablaUsuariosBody')) renderUsuarios();
}

// ---------------------------------------------------------------
// ADMIN: Capacitaciones (Módulos)
// ---------------------------------------------------------------
function renderCapacitaciones() {
  renderSidebarAdmin('capacitaciones');
  document.getElementById('pageTitle').textContent = 'Capacitaciones';
  document.getElementById('pageSubtitle').textContent = 'Gestión de módulos';

  const db = getDB();
  const modulos = db.modulos;

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
      const totalHabilitados = db.asignaciones.filter(a => a.moduloId === m.id && a.habilitado).length;
      return `
      <div class="modulo-card">
        <div class="modulo-cover"><i data-lucide="book-open" size="26"></i></div>
        <div class="modulo-body">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <h3>${m.nombre}</h3>
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

function toggleEstadoModulo(id) {
  const db = getDB();
  const m = db.modulos.find(x => x.id === id);
  m.estado = m.estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO';
  saveDB(db);
  renderCapacitaciones();
}
async function eliminarModulo(id, nombre) {
  if (!confirm(`¿Eliminar el módulo "${nombre}"? Esta acción no se puede deshacer.`)) return;
  const db = getDB();
  db.modulos = db.modulos.filter(m => m.id !== id);
  db.asignaciones = db.asignaciones.filter(a => a.moduloId !== id);
  saveDB(db);
  await eliminarArchivoModulo(id);
  await eliminarCertificadoModulo(id);
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

function abrirModalModulo(id) {
  formModulo.reset();
  document.getElementById('nombreArchivo').textContent = '';
  document.getElementById('nombrePreguntas').textContent = '';
  document.getElementById('nombreCertificado').textContent = '';
  document.getElementById('formError').classList.remove('show');
  document.getElementById('mfId').value = id || '';

  if (id) {
    const db = getDB();
    const m = db.modulos.find(x => x.id === id);
    document.getElementById('modalModuloTitulo').textContent = 'Editar módulo';
    document.getElementById('fNombre').value = m.nombre;
    document.getElementById('fDescripcion').value = m.descripcion || '';
    document.getElementById('fCategoria').value = m.categoria || '';
    document.getElementById('nombreArchivo').textContent = m.archivoNombre ? `Actual: ${m.archivoNombre} (elige otro archivo para reemplazarlo)` : '';
    document.getElementById('nombrePreguntas').textContent = m.preguntas && m.preguntas.length ? `Actual: ${m.preguntasNombre || 'preguntas cargadas'} (${m.preguntas.length} preguntas — elige otro archivo para reemplazarlas)` : '';
    document.getElementById('nombreCertificado').textContent = m.certificadoNombre ? `Actual: ${m.certificadoNombre} (elige otro PDF para reemplazarlo)` : '';
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
wireFileDrop(fileDrop, fArchivo, () => {
  const f = fArchivo.files[0];
  document.getElementById('nombreArchivo').textContent = f ? `Seleccionado: ${f.name}` : '';
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
  const archivo = fArchivo.files[0];
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

  const db = getDB();
  const id = idExistente || ('mod-' + Date.now());

  if (idExistente) {
    const m = db.modulos.find(x => x.id === idExistente);
    Object.assign(m, { nombre, descripcion, categoria });
    if (archivo) { m.archivoNombre = archivo.name; m.archivoPeso = archivo.size; }
    if (preguntasParseadas) { m.preguntas = preguntasParseadas; m.preguntasNombre = archivoPreguntas.name; }
    if (archivoCertificado) { m.certificadoNombre = archivoCertificado.name; }
  } else {
    db.modulos.push({
      id, nombre, descripcion, categoria,
      archivoNombre: archivo ? archivo.name : null,
      archivoPeso: archivo ? archivo.size : null,
      preguntas: preguntasParseadas || null,
      preguntasNombre: preguntasParseadas ? archivoPreguntas.name : null,
      certificadoNombre: archivoCertificado ? archivoCertificado.name : null,
      estado: 'ACTIVO',
      fechaCreacion: new Date().toISOString()
    });
  }
  saveDB(db);

  if (archivo) await guardarArchivoModulo(id, archivo);
  if (archivoCertificado) await guardarCertificadoModulo(id, archivoCertificado);

  modalOverlay.classList.remove('show');
  renderCapacitaciones();
});

// ---------------------------------------------------------------
// Modal: asignar módulo por Área/Sede (masivo)
// ---------------------------------------------------------------
let grupoModuloId = null;
function abrirModalGrupo(moduloId, nombreModulo) {
  grupoModuloId = moduloId;
  document.getElementById('grupoSubtitulo').textContent = `Módulo: ${nombreModulo}`;
  document.getElementById('formErrorGrupo').classList.remove('show');
  poblarValoresFiltroGrupo();
  document.getElementById('modalGrupoOverlay').classList.add('show');
}
document.getElementById('btnCancelarGrupo').addEventListener('click', () => document.getElementById('modalGrupoOverlay').classList.remove('show'));
document.getElementById('gTipoFiltro').addEventListener('change', poblarValoresFiltroGrupo);

function poblarValoresFiltroGrupo() {
  const tipo = document.getElementById('gTipoFiltro').value;
  const db = getDB();
  const valores = [...new Set(db.usuarios.filter(u=>u.rol==='TRABAJADOR').map(u => tipo === 'area' ? u.area : u.sede).filter(Boolean))];
  const select = document.getElementById('gValorFiltro');
  select.innerHTML = valores.length
    ? valores.map(v => `<option value="${v}">${v}</option>`).join('')
    : `<option value="">No hay trabajadores con este dato</option>`;
}

document.getElementById('btnHabilitarGrupo').addEventListener('click', () => {
  const tipo = document.getElementById('gTipoFiltro').value;
  const valor = document.getElementById('gValorFiltro').value;
  const errorBox = document.getElementById('formErrorGrupo');
  if (!valor) { errorBox.textContent = 'No hay ningún valor disponible para asignar.'; errorBox.classList.add('show'); return; }

  const db = getDB();
  const usuariosDelGrupo = db.usuarios.filter(u => u.rol === 'TRABAJADOR' && (tipo === 'area' ? u.area : u.sede) === valor);

  usuariosDelGrupo.forEach(u => {
    let asign = db.asignaciones.find(a => a.usuarioId === u.id && a.moduloId === grupoModuloId);
    if (asign) asign.habilitado = true;
    else db.asignaciones.push({ usuarioId: u.id, moduloId: grupoModuloId, habilitado: true });
  });
  saveDB(db);

  document.getElementById('modalGrupoOverlay').classList.remove('show');
  renderCapacitaciones();
  alert(`Módulo habilitado para ${usuariosDelGrupo.length} trabajador(es) de ${tipo === 'area' ? 'área' : 'sede'} "${valor}".`);
});

// ---------------------------------------------------------------
// ADMIN: Usuarios
// ---------------------------------------------------------------
function renderUsuarios() {
  renderSidebarAdmin('usuarios');
  document.getElementById('pageTitle').textContent = 'Usuarios';
  document.getElementById('pageSubtitle').textContent = 'Gestión de trabajadores';

  const db = getDB();
  const trabajadores = db.usuarios.filter(u => u.rol === 'TRABAJADOR');
  const activos = trabajadores.filter(u => u.estado === 'ACTIVO').length;

  const areas = [...new Set(trabajadores.map(u => u.area).filter(Boolean))].sort();
  const sedes = [...new Set(trabajadores.map(u => u.sede).filter(Boolean))].sort();

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
          <th>Usuario</th><th>Área</th><th>Sede</th><th>Rol</th><th>Estado</th><th>Módulos asignados</th><th>Acciones</th>
        </tr></thead>
        <tbody id="tablaUsuariosBody"></tbody>
      </table>
    </div>
  `;

  const aplicarFiltrosUsuarios = () => {
    const q = document.getElementById('buscarUsuario').value.toLowerCase();
    const area = document.getElementById('filtroArea').value;
    const sede = document.getElementById('filtroSede').value;
    const estado = document.getElementById('filtroEstado').value;
    const filtrados = trabajadores.filter(u =>
      (nombreCompleto(u).toLowerCase().includes(q) || u.correo.toLowerCase().includes(q) || u.dni.includes(q)) &&
      (!area || u.area === area) && (!sede || u.sede === sede) && (!estado || u.estado === estado)
    );
    pintarFilasUsuarios(filtrados);
  };
  pintarFilasUsuarios(trabajadores);
  ['buscarUsuario', 'filtroArea', 'filtroSede', 'filtroEstado'].forEach(id => {
    document.getElementById(id).addEventListener('input', aplicarFiltrosUsuarios);
  });
  lucide.createIcons();
}

function pintarFilasUsuarios(lista) {
  const tbody = document.getElementById('tablaUsuariosBody');
  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--gray-500);padding:30px;">No se encontraron trabajadores.</td></tr>`;
    return;
  }
  const db = getDB();
  tbody.innerHTML = lista.map(u => {
    const totalModulos = db.asignaciones.filter(a => a.usuarioId === u.id && a.habilitado).length;
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
      <td>${u.sede || '-'}</td>
      <td><span class="badge" style="background:var(--blue-100);color:var(--blue-600);">TRABAJADOR</span></td>
      <td><span class="badge ${u.estado==='ACTIVO'?'badge-activo':'badge-inactivo'}">${u.estado==='ACTIVO'?'Activo':'Inactivo'}</span></td>
      <td>${totalModulos}</td>
      <td>
        <div class="actions-cell">
          <button onclick="abrirModalAsignar('${u.id}')" title="Asignar módulos"><i data-lucide="book-open" size="14"></i></button>
          <button onclick="editarUsuario('${u.id}')" title="Editar"><i data-lucide="pencil" size="14"></i></button>
          <button onclick="toggleEstadoUsuario('${u.id}')" title="Activar/Inactivar"><i data-lucide="power" size="14"></i></button>
        </div>
      </td>
    </tr>
  `;
  }).join('');
  lucide.createIcons();
}

function toggleEstadoUsuario(id) {
  const db = getDB();
  const u = db.usuarios.find(x => x.id === id);
  u.estado = u.estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO';
  saveDB(db);
  renderUsuarios();
}

// Modal nuevo/editar trabajador
const modalUsuarioOverlay = document.getElementById('modalUsuarioOverlay');
function abrirModalUsuario() {
  document.getElementById('modalUsuarioTitulo').textContent = 'Nuevo trabajador';
  document.getElementById('formUsuario').reset();
  document.getElementById('uId').value = '';
  document.getElementById('formErrorUsuario').classList.remove('show');
  modalUsuarioOverlay.classList.add('show');
}
function editarUsuario(id) {
  const db = getDB();
  const u = db.usuarios.find(x => x.id === id);
  document.getElementById('modalUsuarioTitulo').textContent = 'Editar trabajador';
  document.getElementById('uId').value = u.id;
  document.getElementById('uPrimerNombre').value = u.primerNombre;
  document.getElementById('uSegundoNombre').value = u.segundoNombre || '';
  document.getElementById('uApellidoPaterno').value = u.apellidoPaterno;
  document.getElementById('uApellidoMaterno').value = u.apellidoMaterno || '';
  document.getElementById('uDni').value = u.dni;
  document.getElementById('uPassword').value = u.password;
  document.getElementById('uCorreo').value = u.correo;
  document.getElementById('uSede').value = u.sede || '';
  document.getElementById('uArea').value = u.area || '';
  document.getElementById('formErrorUsuario').classList.remove('show');
  modalUsuarioOverlay.classList.add('show');
}
document.getElementById('btnCancelarUsuario').addEventListener('click', () => modalUsuarioOverlay.classList.remove('show'));

document.getElementById('formUsuario').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = document.getElementById('uId').value;
  const primerNombre = document.getElementById('uPrimerNombre').value.trim();
  const segundoNombre = document.getElementById('uSegundoNombre').value.trim();
  const apellidoPaterno = document.getElementById('uApellidoPaterno').value.trim();
  const apellidoMaterno = document.getElementById('uApellidoMaterno').value.trim();
  const dni = document.getElementById('uDni').value.trim();
  let password = document.getElementById('uPassword').value.trim();
  const correo = document.getElementById('uCorreo').value.trim().toLowerCase();
  const sede = document.getElementById('uSede').value.trim();
  const area = document.getElementById('uArea').value.trim();
  const errorBox = document.getElementById('formErrorUsuario');

  if (!password) password = dni; // contraseña por defecto = DNI
  const debeCambiarPassword = password === dni; // obliga a cambiarla en el primer ingreso

  const db = getDB();
  const duplicadoDni = db.usuarios.find(u => u.dni === dni && u.id !== id);
  if (duplicadoDni) { errorBox.textContent = `Ya existe un usuario con el DNI ${dni}.`; errorBox.classList.add('show'); return; }
  const duplicadoCorreo = db.usuarios.find(u => u.correo.toLowerCase() === correo && u.id !== id);
  if (duplicadoCorreo) { errorBox.textContent = `Ya existe un usuario con el correo ${correo}.`; errorBox.classList.add('show'); return; }

  if (id) {
    const u = db.usuarios.find(x => x.id === id);
    Object.assign(u, { primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, dni, password, correo, sede, area, debeCambiarPassword });
  } else {
    db.usuarios.push({ id: 'trab-' + Date.now(), primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, dni, password, correo, sede, area, rol: 'TRABAJADOR', estado: 'ACTIVO', debeCambiarPassword });
  }
  saveDB(db);
  modalUsuarioOverlay.classList.remove('show');
  renderUsuarios();
});

// ---------------------------------------------------------------
// Drawer lateral: asignar módulos a un usuario puntual (Imagen 2)
// Los cambios se acumulan en drawerSeleccionPendiente y solo se escriben
// en db.asignaciones al presionar "Guardar asignaciones".
// ---------------------------------------------------------------
let drawerUsuarioId = null;
let drawerSeleccionPendiente = new Set();
let drawerTabActual = 'asignar';
let drawerFiltroTexto = '';

function abrirModalAsignar(usuarioId) {
  const db = getDB();
  const usuario = db.usuarios.find(u => u.id === usuarioId);
  drawerUsuarioId = usuarioId;
  drawerTabActual = 'asignar';
  drawerFiltroTexto = '';
  drawerSeleccionPendiente = new Set(
    db.asignaciones.filter(a => a.usuarioId === usuarioId && a.habilitado).map(a => a.moduloId)
  );

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
  const db = getDB();
  const body = document.getElementById('drawerAsignarBody');

  if (drawerTabActual === 'actuales') {
    const actuales = db.modulos.filter(m => drawerSeleccionPendiente.has(m.id));
    body.innerHTML = actuales.length
      ? actuales.map(m => `
        <div class="modulo-check-card">
          <div class="icn"><i data-lucide="book-open" size="16"></i></div>
          <div style="flex:1;"><strong>${m.nombre}</strong><div style="font-size:.74rem;color:var(--gray-500);">${m.categoria || 'Sin categoría'}</div></div>
        </div>`).join('')
      : `<div class="empty-state"><p>Sin asignaciones actuales.</p></div>`;
  } else {
    const modulos = db.modulos.filter(m => m.nombre.toLowerCase().includes(drawerFiltroTexto.toLowerCase()));
    body.innerHTML = `
      <div class="drawer-search"><input type="text" id="drawerBuscarModulo" placeholder="Buscar módulo..." value="${drawerFiltroTexto.replace(/"/g,'&quot;')}"></div>
      ${modulos.length ? modulos.map(m => `
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

document.getElementById('btnGuardarDrawerAsignar').addEventListener('click', () => {
  const db = getDB();
  db.modulos.forEach(m => {
    const marcado = drawerSeleccionPendiente.has(m.id);
    const asign = db.asignaciones.find(a => a.usuarioId === drawerUsuarioId && a.moduloId === m.id);
    if (asign) asign.habilitado = marcado;
    else if (marcado) db.asignaciones.push({ usuarioId: drawerUsuarioId, moduloId: m.id, habilitado: true });
  });
  saveDB(db);
  document.getElementById('drawerAsignarOverlay').classList.remove('show');
  renderUsuarios();
});

// ---------------------------------------------------------------
// Importar Excel
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
  errorBox.classList.remove('show'); successBox.classList.remove('show');

  if (!file) { errorBox.textContent = 'Selecciona un archivo Excel primero.'; errorBox.classList.add('show'); return; }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const filas = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      const db = getDB();
      let creados = 0, actualizados = 0, errores = 0;

      filas.forEach(fila => {
        const nombres = String(fila['Nombres'] || '').trim();
        const apellidos = String(fila['Apellidos'] || '').trim();
        const dni = String(fila['DNI'] || '').trim();
        const empresa = String(fila['Empresa'] || '').trim();
        const sede = String(fila['Sede'] || '').trim();
        const area = String(fila['Gerencia'] || fila['Área'] || fila['Area'] || '').trim();
        const estado = String(fila['Estado'] || 'ACTIVO').trim().toUpperCase();
        let correo = String(fila['Correo'] || '').trim().toLowerCase();

        if (!nombres || !apellidos || !dni) { errores++; return; }
        if (!correo) {
          correo = (nombres + '.' + apellidos).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'.') + '@tramarsa.com.pe';
        }

        const partesNombres = nombres.split(/\s+/);
        const primerNombre = partesNombres[0];
        const segundoNombre = partesNombres.slice(1).join(' ');
        const partesApellidos = apellidos.split(/\s+/);
        const apellidoPaterno = partesApellidos[0];
        const apellidoMaterno = partesApellidos.slice(1).join(' ');

        const existente = db.usuarios.find(u => u.dni === dni);
        if (existente) {
          // La contrase\u00f1a no se toca en la importaci\u00f3n: el nuevo esquema de
          // Excel ya no trae esa columna (se asigna DNI solo al crear).
          Object.assign(existente, { primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, empresa, sede, area, estado, correo });
          actualizados++;
        } else {
          db.usuarios.push({ id:'trab-'+Date.now()+Math.random().toString(36).slice(2,6), primerNombre, segundoNombre, apellidoPaterno, apellidoMaterno, empresa, sede, area, dni, password: dni, estado, correo, rol:'TRABAJADOR', debeCambiarPassword: true });
          creados++;
        }
      });

      saveDB(db);
      successBox.textContent = `Importación completa: ${creados} creado(s), ${actualizados} actualizado(s)${errores ? `, ${errores} fila(s) con error (faltan campos obligatorios)` : ''}.`;
      successBox.classList.add('show');
    } catch (err) {
      errorBox.textContent = 'No se pudo procesar el archivo. Verifica que sea un Excel válido con las columnas indicadas.';
      errorBox.classList.add('show');
    }
  };
  reader.readAsArrayBuffer(file);
});

// ---------------------------------------------------------------
// Exportar base de datos de trabajadores a Excel
// ---------------------------------------------------------------
function exportarUsuariosExcel() {
  const db = getDB();
  const trabajadores = db.usuarios.filter(u => u.rol === 'TRABAJADOR');

  const filas = trabajadores.map(u => ({
    'Nombres': [u.primerNombre, u.segundoNombre].filter(Boolean).join(' '),
    'Apellidos': [u.apellidoPaterno, u.apellidoMaterno].filter(Boolean).join(' '),
    'DNI': u.dni,
    'Correo': u.correo,
    'Empresa': u.empresa || '',
    'Sede': u.sede || '',
    'Gerencia': u.area || '',
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
  const sesion = getSesion();
  if (sesion) iniciarApp();
});
