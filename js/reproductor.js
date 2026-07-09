/* ============================================================
   TRAMARSA LMS — Reproductor de módulos
   Lee el .zip subido por el admin siguiendo el contrato:
     manifest.json, content/, questions.json, certificate/
   Todo corre en el navegador (JSZip), sin servidor.
   ============================================================ */

const RP = {
  moduloId: null,
  modulo: null,
  zip: null,
  manifest: null,
  contenidoItems: [],
  indiceContenido: 0,
  laminas: null,
  indiceLamina: 0,
  audioLamina: null,      // <audio> reutilizado entre láminas
  vimeoPlayerLamina: null,
  preguntas: [],
  indicePregunta: 0,
  respuestasCorrectas: 0,
  timerInterval: null,
  tiempoPorPregunta: 30, // segundos
  urlsTemporales: [], // para revocar blob URLs al salir
  alSalir: null // función a la que volver al cerrar (por defecto, Inicio)
};

// Progreso parcial (avancePct) del intento EN_PROGRESO actual, para que
// "Mis módulos"/"Mi progreso" puedan mostrar cuánto llevaba el trabajador
// aunque haya salido antes de terminar.
function guardarAvanceHistorial(pasoActual, totalPasos) {
  if (!totalPasos) return;
  const db = getDB();
  const usuario = getSesion();
  const hist = db.historial.find(h => h.usuarioId === usuario.id && h.moduloId === RP.moduloId && h.estado === 'EN_PROGRESO');
  if (!hist) return;
  const pct = Math.max(hist.avancePct || 0, Math.min(99, Math.round((pasoActual / totalPasos) * 100)));
  if (pct !== hist.avancePct) { hist.avancePct = pct; saveDB(db); }
}

let vimeoSdkPromise = null;
function cargarVimeoSdk() {
  if (window.Vimeo && window.Vimeo.Player) return Promise.resolve();
  if (vimeoSdkPromise) return vimeoSdkPromise;
  vimeoSdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://player.vimeo.com/api/player.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return vimeoSdkPromise;
}

// ---------------------------------------------------------------
// Soporte .rar: libarchive.js (WASM) descomprime en el navegador y
// entrega un árbol {carpeta: {archivo: File}}. Se reempaqueta como un
// JSZip normal para no duplicar toda la lógica que ya lee RP.zip.
// Se sirve local (js/vendor/libarchive) porque el worker de la
// librería no puede crearse desde un script de otro origen (CORS).
// ---------------------------------------------------------------
let libarchiveListo = null;
function cargarLibarchive() {
  if (!libarchiveListo) {
    libarchiveListo = import('./vendor/libarchive/libarchive.js').then(mod => {
      mod.Archive.init({ workerUrl: 'js/vendor/libarchive/worker-bundle.js' });
      return mod.Archive;
    });
  }
  return libarchiveListo;
}

async function abrirComoJSZip(archivo) {
  const ext = archivo.name.split('.').pop().toLowerCase();
  if (ext !== 'rar') return JSZip.loadAsync(archivo);

  // La descompresión de .rar usa un Worker de tipo módulo (import() +
  // new Worker({type:'module'})). Los navegadores bloquean eso bajo
  // file:// (doble clic sobre index.html) por política de mismo origen.
  // Funciona normal en cualquier servidor real: GitHub Pages, Netlify,
  // "python -m http.server", etc. — ahí sí es http(s)://.
  if (location.protocol === 'file:') {
    throw new Error('Los archivos .rar no se pueden abrir ejecutando la plataforma con doble clic (file://). Esto sí funcionará al subir el proyecto a GitHub Pages o abrirlo desde cualquier servidor (por ejemplo "python -m http.server" en la carpeta del proyecto). Mientras tanto, sube el módulo como .zip.');
  }

  const Archive = await cargarLibarchive();
  const archive = await Archive.open(archivo);
  const arbol = await archive.extractFiles();

  const zip = new JSZip();
  (function agregar(nodo, prefijo) {
    for (const [nombre, valor] of Object.entries(nodo)) {
      if (valor instanceof File) zip.file(prefijo + nombre, valor);
      else agregar(valor, prefijo + nombre + '/');
    }
  })(arbol, '');
  return zip;
}

async function abrirReproductor(moduloId) {
  const db = getDB();
  RP.moduloId = moduloId;
  RP.modulo = db.modulos.find(m => m.id === moduloId);
  if (!RP.modulo) return;

  document.getElementById('viewReproductor').classList.remove('hidden');
  document.getElementById('reproductorTitulo').textContent = RP.modulo.nombre;
  document.getElementById('reproductorPaso').textContent = 'Cargando módulo...';
  mostrarCargandoReproductor();

  // Marca el inicio en el historial (si no existe ningún registro todavía).
  // Si el módulo ya está COMPLETADO, no se crea un intento nuevo: el modo
  // "Revisar" solo permite ver el contenido, no reabre la evaluación como
  // pendiente ni pisa el registro de aprobación ya guardado.
  const usuario = getSesion();
  let historialActual = db.historial.find(h => h.usuarioId === usuario.id && h.moduloId === moduloId);
  if (!historialActual) {
    historialActual = { id: 'hist-' + Date.now(), usuarioId: usuario.id, moduloId, estado: 'EN_PROGRESO', puntaje: null, fechaInicio: new Date().toISOString(), fechaFin: null };
    db.historial.push(historialActual);
    saveDB(db);
  }

  const archivo = await obtenerArchivoModulo(moduloId);
  if (!archivo) {
    renderReproductorError('Este módulo no tiene un archivo .zip o .rar cargado todavía. Contacta al administrador.');
    return;
  }

  try {
    RP.zip = await abrirComoJSZip(archivo);
  } catch (e) {
    console.error('No se pudo leer el archivo del módulo:', e);
    const mensajeEspecifico = e instanceof Error && e.message.includes('file://');
    renderReproductorError(mensajeEspecifico ? e.message : 'El archivo del módulo no se pudo leer. Verifica que sea un .zip o .rar válido y no esté dañado.');
    return;
  }

  // manifest.json (opcional)
  RP.manifest = await leerJsonDelZip('manifest.json');

  // Contenido: primero busca el formato nuevo (audio/ + img/ con avance por audio);
  // si no existe, cae al formato anterior (content/index.html o media suelta).
  await prepararContenido();

  if (RP.laminas && RP.laminas.length > 0) {
    RP.indiceLamina = 0;
    renderPasoLamina();
  } else if (RP.contenidoItems.length > 0) {
    RP.indiceContenido = 0;
    renderPasoContenido();
  } else {
    // No hay contenido reconocible: pasa directo a evaluación si existe, o marca completado
    await prepararEvaluacionOFinalizar();
  }
}

function mostrarCargandoReproductor() {
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card" style="text-align:center;">
      <i data-lucide="loader-circle" size="32" class="spin"></i>
      <p style="margin-top:12px;color:var(--gray-500);">Cargando módulo...</p>
    </div>`;
  lucide.createIcons();
}

function renderReproductorError(mensaje) {
  document.getElementById('reproductorPaso').textContent = '';
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card" style="text-align:center;">
      <i data-lucide="alert-triangle" size="32" style="color:var(--orange-500);"></i>
      <p style="margin-top:12px;color:var(--gray-700);">${mensaje}</p>
      <button class="btn-save" style="margin-top:16px;" onclick="cerrarReproductor()">Cerrar</button>
    </div>`;
  lucide.createIcons();
}

async function leerJsonDelZip(ruta) {
  const entry = RP.zip.file(ruta);
  if (!entry) return null;
  try {
    const texto = await entry.async('text');
    return JSON.parse(texto);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------
// Contenido (video/audio/imágenes/slides o un index.html autocontenido)
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Formato nuevo de módulo: audio/AudioNN.mp3 + img/DiapositivaNN.png
// (+ css/js propios del módulo, que este reproductor ignora: la
// navegación restringida por audio la controla siempre la plataforma,
// no el código que traiga el .zip). manifest.json opcional puede
// declarar video: [{ lamina, vimeoId }] para láminas con video externo.
// ---------------------------------------------------------------
async function detectarVideoAutomatico(rutas) {
  const candidatos = rutas.filter(p => /\.(js|html)$/i.test(p));
  let vimeoId = null;
  let laminaConVideo = null;
  for (const ruta of candidatos) {
    let texto;
    try { texto = await RP.zip.files[ruta].async('text'); } catch (e) { continue; }
    if (!vimeoId) {
      const m = texto.match(/player\.vimeo\.com\/video\/(\d+)/) || texto.match(/vimeo\.com\/(\d+)/);
      if (m) vimeoId = m[1];
    }
    if (laminaConVideo === null) {
      const m2 = texto.match(/Diapositiva0*(\d+)[^}]{0,120}?video\s*:\s*true/i);
      if (m2) laminaConVideo = parseInt(m2[1], 10);
    }
    if (vimeoId && laminaConVideo !== null) break;
  }
  return (vimeoId && laminaConVideo !== null) ? [{ lamina: laminaConVideo, vimeoId }] : [];
}

async function intentarPrepararLaminas() {
  const IMG_RE = /(^|\/)img\/Diapositiva(\d+)\.(png|jpe?g|webp)$/i;
  const AUDIO_RE = /(^|\/)audio\/Audio(\d+)(?:-(\d+))?\.mp3$/i;
  const MANIFEST_RE = /(^|\/)manifest\.json$/i;

  const rutas = Object.keys(RP.zip.files).filter(p => !RP.zip.files[p].dir);
  const imagenes = new Map(); // numero -> ruta
  rutas.forEach(p => {
    const m = p.match(IMG_RE);
    if (m) imagenes.set(parseInt(m[2], 10), p);
  });
  if (imagenes.size === 0) return null; // no es el formato nuevo

  const audios = []; // { desde, hasta, ruta }
  rutas.forEach(p => {
    const m = p.match(AUDIO_RE);
    if (m) audios.push({ desde: parseInt(m[2], 10), hasta: m[3] ? parseInt(m[3], 10) : null, ruta: p });
  });

  let videoConfig = [];
  const manifestPath = rutas.find(p => MANIFEST_RE.test(p));
  if (manifestPath) {
    try {
      const texto = await RP.zip.files[manifestPath].async('text');
      const manifest = JSON.parse(texto);
      if (Array.isArray(manifest.video)) videoConfig = manifest.video;
      else if (manifest.video) videoConfig = [manifest.video];
    } catch (e) { /* manifest inválido: se ignora */ }
  }
  // Sin manifest.json: muchos módulos (incluido el de referencia de
  // MEJORAS.txt) traen el video de Vimeo hardcodeado en su propio
  // index.html/js. Se detecta por patrón en vez de ejecutar ese código.
  if (videoConfig.length === 0) {
    videoConfig = await detectarVideoAutomatico(rutas);
  }

  const numeros = [...imagenes.keys()].sort((a, b) => a - b);
  const laminas = [];
  for (const n of numeros) {
    const blobImg = await RP.zip.files[imagenes.get(n)].async('blob');
    const urlImg = URL.createObjectURL(blobImg);
    RP.urlsTemporales.push(urlImg);
    const video = videoConfig.find(v => v.lamina === n) || null;
    laminas.push({ numero: n, imgUrl: urlImg, imgUrlDividida: null, audioUrl: null, video });
  }

  for (const a of audios) {
    const lamina = laminas.find(l => l.numero === a.desde);
    if (!lamina) continue;
    const blobAudio = await RP.zip.files[a.ruta].async('blob');
    const urlAudio = URL.createObjectURL(blobAudio);
    RP.urlsTemporales.push(urlAudio);
    lamina.audioUrl = urlAudio;
    if (a.hasta) lamina.cubreLaminaNumero = a.hasta; // audio compartido entre 2 láminas
  }

  // Colapsa el caso de audio compartido: la lámina cubierta no es un paso
  // aparte, es un cambio de imagen a mitad del audio de la lámina anterior.
  for (const lamina of laminas.slice()) {
    if (!lamina.cubreLaminaNumero) continue;
    const cubierta = laminas.find(l => l.numero === lamina.cubreLaminaNumero);
    if (!cubierta) continue;
    lamina.imgUrlDividida = cubierta.imgUrl;
    const idx = laminas.indexOf(cubierta);
    if (idx >= 0) laminas.splice(idx, 1);
  }

  return laminas;
}

async function prepararContenido() {
  RP.contenidoItems = [];
  RP.laminas = null;

  const laminasNuevoFormato = await intentarPrepararLaminas();
  if (laminasNuevoFormato) {
    RP.laminas = laminasNuevoFormato;
    return;
  }

  const indexEntry = RP.zip.file('content/index.html');

  if (indexEntry) {
    let html = await indexEntry.async('text');
    // Reescribe rutas relativas de content/assets/... a blob URLs para que carguen dentro del iframe
    const carpetaContenido = RP.zip.folder('content');
    const archivos = Object.keys(RP.zip.files).filter(p => p.startsWith('content/') && !RP.zip.files[p].dir && p !== 'content/index.html');

    for (const ruta of archivos) {
      const nombreRelativo = ruta.replace('content/', '');
      const blob = await RP.zip.files[ruta].async('blob');
      const url = URL.createObjectURL(blob);
      RP.urlsTemporales.push(url);
      html = html.split(nombreRelativo).join(url);
    }
    RP.contenidoItems.push({ tipo: 'html', html });
    return;
  }

  // Si no hay index.html, junta imágenes/videos/audio sueltos dentro de content/
  const mediaExt = ['jpg','jpeg','png','gif','webp','mp4','webm','mp3','wav'];
  const rutas = Object.keys(RP.zip.files)
    .filter(p => p.startsWith('content/') && !RP.zip.files[p].dir)
    .filter(p => mediaExt.includes(p.split('.').pop().toLowerCase()))
    .sort();

  for (const ruta of rutas) {
    const ext = ruta.split('.').pop().toLowerCase();
    const blob = await RP.zip.files[ruta].async('blob');
    const url = URL.createObjectURL(blob);
    RP.urlsTemporales.push(url);
    let tipo = 'imagen';
    if (['mp4','webm'].includes(ext)) tipo = 'video';
    if (['mp3','wav'].includes(ext)) tipo = 'audio';
    RP.contenidoItems.push({ tipo, url, nombre: ruta.split('/').pop() });
  }
}

function renderPasoContenido() {
  const total = RP.contenidoItems.length;
  const item = RP.contenidoItems[RP.indiceContenido];
  document.getElementById('reproductorPaso').textContent = total > 1 ? `Contenido ${RP.indiceContenido + 1} de ${total}` : 'Contenido del módulo';
  guardarAvanceHistorial(RP.indiceContenido + 1, total + 1);

  let mediaHtml = '';
  if (item.tipo === 'html') {
    mediaHtml = `<iframe srcdoc="${item.html.replace(/"/g, '&quot;')}"></iframe>`;
  } else if (item.tipo === 'imagen') {
    mediaHtml = `<img src="${item.url}" alt="${item.nombre}">`;
  } else if (item.tipo === 'video') {
    mediaHtml = `<video src="${item.url}" controls autoplay style="max-width:100%;max-height:420px;"></video>`;
  } else if (item.tipo === 'audio') {
    mediaHtml = `<audio src="${item.url}" controls autoplay style="width:100%;"></audio>`;
  }

  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-full">
      <div class="rp-media-full" oncontextmenu="return false;">${mediaHtml}</div>
      <div class="rp-controls">
        <div class="rp-dwell-bar"><div class="rp-dwell-fill" id="dwellFill"></div></div>
        <button class="btn-save" id="btnSiguienteContenido" disabled style="opacity:.5;white-space:nowrap;">
          ${RP.indiceContenido < total - 1 ? 'Siguiente' : 'Continuar'} <i data-lucide="arrow-right" size="14"></i>
        </button>
        <button class="icon-btn" id="btnContenidoMax" style="flex:0;min-width:44px;" title="Pantalla completa"><i data-lucide="${document.fullscreenElement ? 'minimize-2' : 'maximize-2'}" size="16"></i></button>
      </div>
      <p style="font-size:.74rem;color:var(--gray-500);margin-top:10px;text-align:center;">No es posible adelantar el contenido. El botón se habilita al terminar de revisarlo.</p>
    </div>
  `;
  lucide.createIcons();
  document.getElementById('btnContenidoMax').addEventListener('click', alternarFullscreenReproductor);

  // Habilita "Siguiente" según el tipo: video/audio al terminar, imagen/html tras un tiempo mínimo de permanencia
  const btn = document.getElementById('btnSiguienteContenido');
  const habilitarBoton = () => { btn.disabled = false; btn.style.opacity = '1'; };

  if (item.tipo === 'video' || item.tipo === 'audio') {
    const el = document.querySelector(item.tipo);
    el.addEventListener('ended', habilitarBoton);
    const tick = () => {
      const fill = document.getElementById('dwellFill');
      if (fill && el.duration) fill.style.width = `${(el.currentTime / el.duration) * 100}%`;
      if (!el.ended) dwellRAF = requestAnimationFrame(tick);
    };
    dwellRAF = requestAnimationFrame(tick);
  } else {
    const segundosMinimos = 4;
    const inicio = performance.now();
    const fill = document.getElementById('dwellFill');
    const tick = () => {
      const transcurrido = (performance.now() - inicio) / 1000;
      if (fill) fill.style.width = `${Math.min(100, (transcurrido / segundosMinimos) * 100)}%`;
      if (transcurrido >= segundosMinimos) { habilitarBoton(); return; }
      dwellRAF = requestAnimationFrame(tick);
    };
    dwellRAF = requestAnimationFrame(tick);
  }

  btn.addEventListener('click', async () => {
    if (RP.indiceContenido < total - 1) {
      RP.indiceContenido++;
      renderPasoContenido();
    } else {
      await prepararEvaluacionOFinalizar();
    }
  });
}

// ---------------------------------------------------------------
// Lámina (formato nuevo: audio + imagen, avance restringido)
// Solo se puede avanzar cuando termina el audio (o el video) de la
// lámina actual. Retroceder y pausar sí están permitidos.
// ---------------------------------------------------------------
let dwellRAF = null;
function detenerLoopProgreso() {
  if (dwellRAF) cancelAnimationFrame(dwellRAF);
  dwellRAF = null;
}

function detenerReproduccionLamina() {
  detenerLoopProgreso();
  if (RP.audioLamina) { RP.audioLamina.pause(); RP.audioLamina.onended = null; }
  if (RP.vimeoPlayerLamina) { RP.vimeoPlayerLamina.pause().catch(() => {}); RP.vimeoPlayerLamina.off('ended'); RP.vimeoPlayerLamina = null; }
}

// Pantalla completa real (Fullscreen API) sobre todo el visor, no un simple
// cambio de tamaño de tarjeta: no reinicia la diapositiva ni el audio en
// curso porque no vuelve a renderizar nada, solo pide/sale de fullscreen.
function alternarFullscreenReproductor() {
  const el = document.getElementById('viewReproductor');
  if (!document.fullscreenElement) el.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}
document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('btnLaminaMax') || document.getElementById('btnContenidoMax');
  if (!btn) return;
  btn.innerHTML = `<i data-lucide="${document.fullscreenElement ? 'minimize-2' : 'maximize-2'}" size="16"></i>`;
  lucide.createIcons();
});

function renderPasoLamina() {
  detenerReproduccionLamina();
  const total = RP.laminas.length;
  const lamina = RP.laminas[RP.indiceLamina];
  document.getElementById('reproductorPaso').textContent = `Diapositiva ${RP.indiceLamina + 1} de ${total}`;
  guardarAvanceHistorial(RP.indiceLamina + 1, total + 1);

  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-full" id="rpLaminaCard">
      <div class="rp-media-full" id="rpMedia" oncontextmenu="return false;"><img src="${lamina.imgUrl}" alt="Diapositiva ${lamina.numero}" id="rpLaminaImg" oncontextmenu="return false;"></div>
      <div id="rpControlsBar">
        <div class="rp-controls">
          <button class="icon-btn" id="btnLaminaPrev" style="flex:0;min-width:44px;" ${RP.indiceLamina === 0 ? 'disabled' : ''}><i data-lucide="chevron-left" size="16"></i></button>
          <button class="icon-btn" id="btnLaminaPlayPause" style="flex:0;min-width:44px;"><i data-lucide="pause" size="16"></i></button>
          <div class="rp-dwell-bar"><div class="rp-dwell-fill" id="dwellFillLamina"></div></div>
          <button class="btn-save" id="btnLaminaNext" disabled style="opacity:.5;white-space:nowrap;">
            ${RP.indiceLamina < total - 1 ? 'Siguiente' : 'Continuar'} <i data-lucide="arrow-right" size="14"></i>
          </button>
          <button class="icon-btn" id="btnLaminaMax" style="flex:0;min-width:44px;" title="Pantalla completa"><i data-lucide="${document.fullscreenElement ? 'minimize-2' : 'maximize-2'}" size="16"></i></button>
        </div>
        <p style="font-size:.74rem;color:var(--gray-500);margin-top:10px;text-align:center;">Puedes retroceder o pausar, pero no adelantar: "Siguiente" se habilita al terminar el audio de esta diapositiva.</p>
      </div>
    </div>
  `;
  lucide.createIcons();

  document.getElementById('btnLaminaPrev').addEventListener('click', () => {
    if (RP.indiceLamina > 0) { RP.indiceLamina--; renderPasoLamina(); }
  });
  document.getElementById('btnLaminaNext').addEventListener('click', () => {
    if (RP.indiceLamina < total - 1) { RP.indiceLamina++; renderPasoLamina(); }
    else prepararEvaluacionOFinalizar();
  });
  document.getElementById('btnLaminaMax').addEventListener('click', alternarFullscreenReproductor);
  document.getElementById('btnLaminaPlayPause').addEventListener('click', toggleReproduccionLamina);

  iniciarReproduccionLamina(lamina);
}

function habilitarSiguienteLamina() {
  const barra = document.getElementById('rpControlsBar');
  if (barra) barra.style.display = '';
  const btn = document.getElementById('btnLaminaNext');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
}

function iniciarReproduccionLamina(lamina) {
  const fill = document.getElementById('dwellFillLamina');

  if (!lamina.audioUrl && !lamina.video) {
    // Lámina sin audio ni video: tiempo mínimo de permanencia, igual que el contenido suelto.
    const segundosMinimos = 4;
    const inicio = performance.now();
    const tick = () => {
      const transcurrido = (performance.now() - inicio) / 1000;
      if (fill) fill.style.width = `${Math.min(100, (transcurrido / segundosMinimos) * 100)}%`;
      if (transcurrido >= segundosMinimos) { habilitarSiguienteLamina(); return; }
      dwellRAF = requestAnimationFrame(tick);
    };
    dwellRAF = requestAnimationFrame(tick);
    return;
  }

  if (lamina.audioUrl) {
    if (!RP.audioLamina) RP.audioLamina = new Audio();
    const audio = RP.audioLamina;
    audio.src = lamina.audioUrl;
    audio.currentTime = 0;
    let dividida = false;
    const tick = () => {
      if (fill && audio.duration) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
      if (lamina.imgUrlDividida && !dividida && audio.duration && audio.currentTime >= audio.duration / 2) {
        dividida = true;
        const img = document.getElementById('rpLaminaImg');
        if (img) img.src = lamina.imgUrlDividida;
      }
      dwellRAF = requestAnimationFrame(tick);
    };
    dwellRAF = requestAnimationFrame(tick);
    audio.onended = () => {
      detenerLoopProgreso();
      if (lamina.video) mostrarVideoLamina(lamina);
      else habilitarSiguienteLamina();
    };
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
    actualizarIconoPlayPause(true);
  } else if (lamina.video) {
    mostrarVideoLamina(lamina);
  }
}

function actualizarIconoPlayPause(reproduciendo) {
  const btn = document.getElementById('btnLaminaPlayPause');
  if (!btn) return;
  btn.innerHTML = `<i data-lucide="${reproduciendo ? 'pause' : 'play'}" size="16"></i>`;
  lucide.createIcons();
}

async function mostrarVideoLamina(lamina) {
  const media = document.getElementById('rpMedia');
  if (!media || !lamina.video || !lamina.video.vimeoId) { habilitarSiguienteLamina(); return; }

  // El video toma toda la pantalla: se ocultan los controles propios
  // (no aplican mientras se reproduce) hasta que termine.
  const barra = document.getElementById('rpControlsBar');
  if (barra) barra.style.display = 'none';

  media.innerHTML = `<iframe src="https://player.vimeo.com/video/${lamina.video.vimeoId}?badge=0&autopause=0&autoplay=1&muted=1" allow="autoplay; fullscreen; picture-in-picture" title="Video de la diapositiva"></iframe>`;
  try {
    await cargarVimeoSdk();
    RP.vimeoPlayerLamina = new window.Vimeo.Player(media.querySelector('iframe'));
    RP.vimeoPlayerLamina.on('ended', habilitarSiguienteLamina);
    actualizarIconoPlayPause(true);

    // Reproducción automática: arranca muteado (los navegadores bloquean
    // autoplay con sonido sin gesto del usuario) y desmutea de inmediato;
    // como el usuario ya interactuó con la página, esto sí se permite.
    try {
      await RP.vimeoPlayerLamina.play();
      await RP.vimeoPlayerLamina.setMuted(false);
    } catch (e) { /* si el navegador bloquea el autoplay, queda muteado y el usuario le da play */ }
  } catch (e) {
    if (barra) barra.style.display = '';
    habilitarSiguienteLamina(); // si el SDK no carga, no se bloquea al usuario
  }
}

function toggleReproduccionLamina() {
  const lamina = RP.laminas[RP.indiceLamina];
  const enVideo = RP.vimeoPlayerLamina && document.getElementById('rpMedia').querySelector('iframe');
  if (enVideo) {
    RP.vimeoPlayerLamina.getPaused().then(pausado => {
      if (pausado) { RP.vimeoPlayerLamina.play(); actualizarIconoPlayPause(true); }
      else { RP.vimeoPlayerLamina.pause(); actualizarIconoPlayPause(false); }
    }).catch(() => {});
    return;
  }
  if (RP.audioLamina && RP.audioLamina.src) {
    if (RP.audioLamina.paused) { RP.audioLamina.play(); actualizarIconoPlayPause(true); }
    else { RP.audioLamina.pause(); actualizarIconoPlayPause(false); }
  }
}

// ---------------------------------------------------------------
// Evaluación: banco de preguntas aleatorio, secuencial, sin retroceder
// ---------------------------------------------------------------
async function prepararEvaluacionOFinalizar() {
  // El banco de preguntas se carga desde el módulo (subido por separado en el
  // panel admin). Si el módulo no trae preguntas propias, se intenta el
  // questions.json embebido en el .zip por compatibilidad con módulos viejos.
  const banco = (RP.modulo.preguntas && RP.modulo.preguntas.length) ? RP.modulo.preguntas : await leerJsonDelZip('questions.json');

  if (!banco || !Array.isArray(banco) || banco.length === 0) {
    // No hay evaluación definida: se marca completado directamente
    await finalizarModulo(null);
    return;
  }

  const CANTIDAD_PREGUNTAS = Math.min(5, banco.length);
  const seleccionadas = mezclarArray([...banco]).slice(0, CANTIDAD_PREGUNTAS);

  RP.preguntas = seleccionadas.map(p => ({
    enunciado: p.enunciado,
    alternativas: mezclarArray([...p.alternativas]) // también se mezcla el orden de alternativas
  }));
  RP.indicePregunta = 0;
  RP.respuestasCorrectas = 0;

  renderPasoPregunta();
}

function mezclarArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function renderPasoPregunta() {
  clearInterval(RP.timerInterval);
  const total = RP.preguntas.length;
  const pregunta = RP.preguntas[RP.indicePregunta];
  document.getElementById('reproductorPaso').textContent = `Evaluación — Pregunta ${RP.indicePregunta + 1} de ${total}`;

  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span class="rp-pregunta-num">Pregunta ${RP.indicePregunta + 1} de ${total}</span>
        <span class="rp-timer"><i data-lucide="clock" size="14"></i> <span id="tiempoRestante">${RP.tiempoPorPregunta}</span>s</span>
      </div>
      <div class="rp-pregunta-texto">${pregunta.enunciado}</div>
      <div id="listaAlternativas">
        ${pregunta.alternativas.map((a, i) => `
          <div class="rp-alternativa" data-index="${i}" onclick="seleccionarAlternativa(${i})">
            ${a.texto}
          </div>
        `).join('')}
      </div>
    </div>
  `;
  lucide.createIcons();

  let tiempo = RP.tiempoPorPregunta;
  RP.timerInterval = setInterval(() => {
    tiempo--;
    const span = document.getElementById('tiempoRestante');
    if (span) span.textContent = tiempo;
    if (tiempo <= 0) {
      clearInterval(RP.timerInterval);
      seleccionarAlternativa(-1); // tiempo agotado = respuesta incorrecta
    }
  }, 1000);
}

function seleccionarAlternativa(indice) {
  clearInterval(RP.timerInterval);
  const pregunta = RP.preguntas[RP.indicePregunta];
  const elementos = document.querySelectorAll('.rp-alternativa');
  elementos.forEach(el => el.style.pointerEvents = 'none');

  const indiceCorrecta = pregunta.alternativas.findIndex(a => a.esCorrecta);
  if (indice === indiceCorrecta) RP.respuestasCorrectas++;

  if (elementos[indiceCorrecta]) elementos[indiceCorrecta].classList.add('correcta');
  if (indice >= 0 && indice !== indiceCorrecta && elementos[indice]) elementos[indice].classList.add('incorrecta');

  setTimeout(() => {
    if (RP.indicePregunta < RP.preguntas.length - 1) {
      RP.indicePregunta++;
      renderPasoPregunta();
    } else {
      const puntaje = Math.round((RP.respuestasCorrectas / RP.preguntas.length) * 100);
      finalizarModulo(puntaje);
    }
  }, 1200);
}

// ---------------------------------------------------------------
// Resultado + certificado
// ---------------------------------------------------------------
const UMBRAL_APROBACION = 70;

async function finalizarModulo(puntaje) {
  const db = getDB();
  const usuario = getSesion();
  let hist = db.historial.find(h => h.usuarioId === usuario.id && h.moduloId === RP.moduloId && h.estado === 'EN_PROGRESO');

  const aprobado = puntaje === null || puntaje >= UMBRAL_APROBACION;

  if (aprobado) {
    if (hist) {
      hist.estado = 'COMPLETADO';
      hist.puntaje = puntaje;
      hist.avancePct = 100;
      hist.fechaFin = new Date().toISOString();
    }
    saveDB(db);
    await renderResultadoAprobado(puntaje);
  } else {
    saveDB(db); // el intento fallido queda registrado, pero sigue EN_PROGRESO para reintentar
    renderResultadoDesaprobado(puntaje);
  }
}

async function renderResultadoAprobado(puntaje) {
  document.getElementById('reproductorPaso').textContent = '';
  const usuario = getSesion();

  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card rp-resultado">
      <div class="icon-grande" style="background:var(--green-100);color:var(--green-500);"><i data-lucide="check" size="34"></i></div>
      <h2 style="font-size:1.3rem;font-weight:800;color:var(--navy-900);margin-bottom:6px;">¡Módulo completado!</h2>
      <p style="color:var(--gray-500);font-size:.9rem;">${puntaje !== null ? `Obtuviste ${puntaje}% en la evaluación.` : 'Contenido revisado correctamente.'}</p>
      <div id="certContainer"></div>
      <button class="btn-save" style="margin-top:10px;" onclick="cerrarReproductor()">Volver al inicio</button>
    </div>
  `;
  lucide.createIcons();

  // La fecha de emisión del certificado es la de la primera aprobación
  // (hist.fechaFin), no la fecha en la que se vuelve a ver/descargar.
  const db = getDB();
  const hist = db.historial.find(h => h.usuarioId === usuario.id && h.moduloId === RP.moduloId);
  await intentarGenerarCertificado(usuario, hist ? hist.fechaFin : new Date().toISOString());
}

function renderResultadoDesaprobado(puntaje) {
  document.getElementById('reproductorPaso').textContent = '';
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card rp-resultado">
      <div class="icon-grande" style="background:var(--red-100);color:var(--red-500);"><i data-lucide="x" size="34"></i></div>
      <h2 style="font-size:1.3rem;font-weight:800;color:var(--navy-900);margin-bottom:6px;">No alcanzaste el puntaje mínimo</h2>
      <p style="color:var(--gray-500);font-size:.9rem;">Obtuviste ${puntaje}%. Necesitas al menos ${UMBRAL_APROBACION}% para aprobar. Vuelve a intentarlo con nuevas preguntas.</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;">
        <button class="btn-cancel" onclick="cerrarReproductor()">Salir</button>
        <button class="btn-save" onclick="prepararEvaluacionOFinalizar()">Reintentar evaluación</button>
      </div>
    </div>
  `;
  lucide.createIcons();
}

// Ubica en el PDF (vía pdf.js) la posición exacta de cada texto placeholder,
// para poder cubrirlo y redibujar el valor real encima sin mover nada más.
async function localizarTextosEnPdf(bytes, textosBuscados) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pagina = await pdf.getPage(1);
  const contenido = await pagina.getTextContent();
  // Algunas plantillas (ej. exportadas de Canva) dejan más de una ocurrencia
  // del mismo placeholder (una visible, otra oculta o fuera del área de
  // diseño). Se guardan todas para reemplazarlas todas, no solo la última.
  const encontrados = {};
  for (const item of contenido.items) {
    const texto = item.str.trim();
    if (!texto) continue;
    for (const buscado of textosBuscados) {
      if (texto === buscado) {
        const [a, b, , , e, f] = item.transform;
        if (!encontrados[buscado]) encontrados[buscado] = [];
        encontrados[buscado].push({ x: e, y: f, width: item.width, height: item.height || Math.hypot(a, b) || 14 });
      }
    }
  }
  return encontrados;
}

// Certificado en PDF editable: cubre los placeholders "NOMBRES APELLIDOS",
// "MÓDULO" y la fecha con un rectángulo blanco y dibuja el valor real
// centrado en su misma posición, sin alterar el resto del diseño.
async function intentarGenerarCertificado(usuario, fechaEmisionISO) {
  const certBlob = await obtenerCertificadoModulo(RP.moduloId);
  if (!certBlob) {
    await intentarGenerarCertificadoLegacyPNG(usuario, fechaEmisionISO);
    return;
  }

  const nombreUsuario = nombreCompleto(usuario).toUpperCase();
  const nombreModulo = (RP.modulo.nombre || '').toUpperCase();
  const fechaTexto = new Date(fechaEmisionISO || Date.now()).toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' });

  const reemplazos = {
    'NOMBRES APELLIDOS': nombreUsuario,
    'MÓDULO': nombreModulo,
    'MODULO': nombreModulo,
    'FECHA': fechaTexto,
    'DD de MM del AAAAA': fechaTexto
  };

  try {
    const bytes = new Uint8Array(await certBlob.arrayBuffer());
    // pdf.js toma posesión (transferable) del ArrayBuffer que recibe y lo deja
    // vacío; se le pasa una copia para no perder los bytes que pdf-lib
    // necesita justo después.
    const posiciones = await localizarTextosEnPdf(bytes.slice(), Object.keys(reemplazos));

    const pdfDoc = await PDFLib.PDFDocument.load(bytes);
    const pagina = pdfDoc.getPages()[0];
    // Arial no es una fuente base embebible en el navegador sin licenciar el
    // archivo TTF; Helvetica es el sustituto estándar métricamente compatible
    // que usa cualquier lector/generador de PDF cuando pide "Arial".
    const fuente = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);

    let algunReemplazo = false;
    for (const [placeholder, valor] of Object.entries(reemplazos)) {
      const ocurrencias = posiciones[placeholder];
      if (!ocurrencias || !ocurrencias.length) continue;
      for (const pos of ocurrencias) {
        algunReemplazo = true;
        const tamanoFuente = Math.max(8, (pos.height || 14) * 0.82);
        pagina.drawRectangle({ x: pos.x - 3, y: pos.y - 3, width: pos.width + 6, height: (pos.height || 14) + 6, color: PDFLib.rgb(1, 1, 1) });
        const anchoTexto = fuente.widthOfTextAtSize(valor, tamanoFuente);
        const centroX = pos.x + pos.width / 2;
        pagina.drawText(valor, { x: centroX - anchoTexto / 2, y: pos.y, size: tamanoFuente, font: fuente, color: PDFLib.rgb(0.024, 0.149, 0.314) });
      }
    }

    if (!algunReemplazo) {
      document.getElementById('certContainer').innerHTML = `<p style="font-size:.8rem;color:var(--orange-500);margin-top:14px;">La plantilla de certificado no contiene los textos "NOMBRES APELLIDOS" / "MÓDULO" / fecha, no se pudo personalizar.</p>`;
      return;
    }

    const bytesFinal = await pdfDoc.save();
    const blobFinal = new Blob([bytesFinal], { type: 'application/pdf' });
    const url = URL.createObjectURL(blobFinal);
    RP.urlsTemporales.push(url);

    document.getElementById('certContainer').innerHTML = `
      <iframe src="${url}" style="width:100%;height:420px;border:1px solid var(--gray-200);border-radius:12px;margin:18px 0;"></iframe>
      <a href="${url}" download="certificado_${usuario.dni}_${RP.moduloId}.pdf" class="btn-outline" style="text-decoration:none;justify-content:center;display:flex;">
        <i data-lucide="download" size="15"></i>&nbsp; Descargar certificado
      </a>
    `;
    lucide.createIcons();
  } catch (e) {
    console.error('No se pudo generar el certificado PDF:', e);
    document.getElementById('certContainer').innerHTML = `<p style="font-size:.8rem;color:var(--red-500);margin-top:14px;">No se pudo generar el certificado en PDF.</p>`;
  }
}

// Compatibilidad: módulos antiguos que traían certificate/template.png +
// layout.json dentro del propio .zip.
async function intentarGenerarCertificadoLegacyPNG(usuario, fechaEmisionISO) {
  const templateEntry = RP.zip.file('certificate/template.png') || RP.zip.file('certificate/template.jpg');
  const layoutJson = await leerJsonDelZip('certificate/layout.json');

  if (!templateEntry) {
    document.getElementById('certContainer').innerHTML = `<p style="font-size:.8rem;color:var(--gray-500);margin-top:14px;">Este módulo no incluye plantilla de certificado.</p>`;
    return;
  }

  const layout = layoutJson || { x: 500, y: 350, fontSize: 42, color: '#061E4E', fontFamily: 'Inter, sans-serif' };
  const blob = await templateEntry.async('blob');
  const url = URL.createObjectURL(blob);
  RP.urlsTemporales.push(url);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.font = `${layout.fontSize || 42}px ${layout.fontFamily || 'Inter, sans-serif'}`;
    ctx.fillStyle = layout.color || '#061E4E';
    ctx.textAlign = layout.align || 'center';
    ctx.fillText(nombreCompleto(usuario), layout.x || canvas.width/2, layout.y || canvas.height/2);

    if (layout.fechaX !== undefined) {
      ctx.font = `${layout.fechaFontSize || 18}px ${layout.fontFamily || 'Inter, sans-serif'}`;
      ctx.fillText(new Date(fechaEmisionISO || Date.now()).toLocaleDateString('es-PE'), layout.fechaX, layout.fechaY || (layout.y + 40));
    }

    const dataUrl = canvas.toDataURL('image/png');
    document.getElementById('certContainer').innerHTML = `
      <img src="${dataUrl}" class="rp-cert-preview" alt="Certificado">
      <a href="${dataUrl}" download="certificado_${usuario.dni}_${RP.moduloId}.png" class="btn-outline" style="text-decoration:none;justify-content:center;display:flex;">
        <i data-lucide="download" size="15"></i>&nbsp; Descargar certificado
      </a>
    `;
    lucide.createIcons();
  };
  img.src = url;
}

// ---------------------------------------------------------------
// Salir del reproductor
// ---------------------------------------------------------------
// Muestra el certificado de un módulo ya completado, fuera del flujo normal
// del reproductor (llamado desde "Mis módulos" o "Certificados"). Reutiliza
// la misma vista/overlay para no duplicar el visor de PDF.
async function verCertificadoStandalone(moduloId, alVolver) {
  const db = getDB();
  const usuario = getSesion();
  const modulo = db.modulos.find(m => m.id === moduloId);
  const hist = db.historial.find(h => h.usuarioId === usuario.id && h.moduloId === moduloId && h.estado === 'COMPLETADO');
  if (!modulo || !hist) return;

  RP.modulo = modulo;
  RP.moduloId = moduloId;
  RP.urlsTemporales = RP.urlsTemporales || [];
  RP.alSalir = alVolver || null;

  document.getElementById('viewReproductor').classList.remove('hidden');
  document.getElementById('reproductorTitulo').textContent = modulo.nombre;
  document.getElementById('reproductorPaso').textContent = '';
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card rp-resultado">
      <div class="icon-grande" style="background:var(--green-100);color:var(--green-500);"><i data-lucide="award" size="34"></i></div>
      <h2 style="font-size:1.3rem;font-weight:800;color:var(--navy-900);margin-bottom:6px;">Certificado</h2>
      <p style="color:var(--gray-500);font-size:.9rem;">${modulo.nombre}</p>
      <div id="certContainer"></div>
      <button class="btn-save" style="margin-top:10px;" onclick="cerrarReproductor()">Cerrar</button>
    </div>`;
  lucide.createIcons();
  await intentarGenerarCertificado(usuario, hist.fechaFin);
}

function cerrarReproductor() {
  if (document.fullscreenElement) document.exitFullscreen();
  clearInterval(RP.timerInterval);
  detenerReproduccionLamina();
  RP.urlsTemporales.forEach(u => URL.revokeObjectURL(u));
  RP.urlsTemporales = [];
  RP.zip = null; RP.manifest = null; RP.contenidoItems = []; RP.preguntas = [];
  RP.laminas = null; RP.indiceLamina = 0; RP.audioLamina = null;
  document.getElementById('viewReproductor').classList.add('hidden');
  (RP.alSalir || renderDashboardTrabajador)();
  RP.alSalir = null;
  lucide.createIcons();
}
document.getElementById('btnSalirReproductor').addEventListener('click', () => {
  if (confirm('¿Salir del módulo? Tu avance en la evaluación actual no se guardará.')) cerrarReproductor();
});
